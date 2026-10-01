// Precificador do SEVEN (estilo Mercado Turbo): margem do anuncio no Classico e no Premium e
// alteracao do preco direto no ML, so depois de a pessoa confirmar.
//
// De onde vem cada numero (nada estimado sem dizer):
//   preco, tipo (Classico/Premium), categoria .. GET /items/{id}
//   frete que o vendedor paga ................... GET /users/{id}/shipping_options/free?item_id= (list_cost)
//   tarifa de venda .............................. GET /sites/MLB/listing_prices?price=&listing_type_id=&category_id=
//   custo ........................................ custos.json do app (planilha de custos, por SKU)
//   imposto ...................................... % do config.json (imposto_pct, padrao 3%)
// Margem de contribuicao = venda - frete - custo - imposto - tarifa.
//
// Alterar preco: PUT /items/{id} {price} (com variacoes, o preco vai em cada variacao).
// Trava: ate 20% de diferenca; acima disso so com confirmacao extra. Todo envio fica no
// historico (precos_historico.jsonl) e pode ser desfeito.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const TokenManager = require('./tokenManager');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ML = 'https://api.mercadolibre.com';
const HIST = path.join(STORAGE, 'precos_historico.jsonl');
const TIPOS = { gold_special: 'Clássico', gold_pro: 'Premium' };
const LIMITE_PCT = 20;

const lerJson = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(STORAGE, f), 'utf8')); } catch { return d; } };
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
async function auth() { const t = await TokenManager.getToken(); return { headers: { Authorization: `Bearer ${t.access_token}` }, userId: t.user_id }; }

// custo pela planilha: SKU exato, sem sufixo (-par, -esq...), sem zeros a esquerda
function custoDoSku(sku) {
    const c = lerJson('custos.json', {});
    if (!sku) return null;
    const s = String(sku).trim();
    const tentativas = [s, s.toLowerCase(), s.toUpperCase(), s.split(/[-_\s]/)[0], s.replace(/^0+/, '')];
    for (const k of tentativas) if (c[k] != null && !isNaN(Number(c[k]))) return { valor: Number(c[k]), chave: k };
    return null;
}

async function tarifa(headers, preco, tipo, categoria) {
    try {
        const { data } = await axios.get(`${ML}/sites/MLB/listing_prices`, { headers, params: { price: preco, listing_type_id: tipo, category_id: categoria }, timeout: 20000 });
        const d = Array.isArray(data) ? data[0] : data;
        return { valor: r2(d.sale_fee_amount), pct: d.sale_fee_details?.percentage_fee ?? null, fixa: d.sale_fee_details?.fixed_fee ?? null };
    } catch { return null; }
}

function margem(preco, frete, custo, impostoPct, taxa) {
    const imposto = r2(preco * impostoPct / 100);
    const m = r2(preco - (frete || 0) - (custo || 0) - imposto - (taxa || 0));
    return { imposto, margem: m, margem_pct: preco ? r2(m / preco * 100) : 0 };
}

// Tudo o que o popup precisa para um anuncio, num preco (atual ou digitado)
async function dados(itemId, precoDigitado, custoDigitado) {
    const { headers, userId } = await auth();
    const { data: it } = await axios.get(`${ML}/items/${itemId}`, { headers, params: { include_attributes: 'all' }, timeout: 20000 });
    const sku = it.seller_custom_field || ((it.attributes || []).find(a => a.id === 'SELLER_SKU') || {}).value_name || '';
    const preco = r2(precoDigitado || it.price);
    let frete = null;
    try {
        const { data } = await axios.get(`${ML}/users/${userId}/shipping_options/free`, { headers, params: { item_id: itemId }, timeout: 20000 });
        frete = (data.coverage || {}).all_country?.list_cost ?? null;
    } catch {}
    const custo = custoDigitado != null ? { valor: Number(custoDigitado), chave: 'digitado' } : custoDoSku(sku);
    const impostoPct = Number(lerJson('config.json', {}).imposto_pct ?? 3);
    const colunas = {};
    for (const tipo of Object.keys(TIPOS)) {
        const t = await tarifa(headers, preco, tipo, it.category_id);
        colunas[tipo] = { nome: TIPOS[tipo], atual: it.listing_type_id === tipo, tarifa: t, ...margem(preco, frete, custo && custo.valor, impostoPct, t && t.valor) };
    }
    return {
        item_id: it.id, titulo: it.title, sku, thumbnail: it.thumbnail, link: it.permalink, status: it.status,
        preco_atual: it.price, preco, tipo_atual: it.listing_type_id, frete, frete_gratis: !!it.shipping?.free_shipping,
        custo: custo ? custo.valor : null, custo_origem: custo ? custo.chave : null, imposto_pct: impostoPct,
        variacoes: (it.variations || []).length, colunas,
        aviso_frete: it.price >= 79 && preco < 79 ? 'Abaixo de R$ 79 o frete grátis deixa de ser obrigatório: o valor do frete pode mudar.' : (it.price < 79 && preco >= 79 ? 'A partir de R$ 79 o frete grátis passa a ser obrigatório: o frete pode passar a ser pago por você.' : ''),
    };
}

// Sugestao de +1% ou -1% conforme o sinal da analise do Seven
function sugestao(precoAtual, sinal) {
    const desce = ['preco_caro_sem_venda', 'fora_do_podio', 'fora_da_pagina1', 'parado', 'sem_ontem'];
    const sobe = ['subir_preco', 'margem_curta', 'oportunidade'];
    if (desce.includes(sinal)) return { preco: r2(precoAtual * 0.99), direcao: -1, motivo: 'Está mais caro que o concorrente e vendendo pouco: baixar 1% e acompanhar a venda.' };
    if (sobe.includes(sinal)) return { preco: r2(precoAtual * 1.01), direcao: 1, motivo: 'Está vendendo bem ou abaixo do concorrente: subir 1% e acompanhar a venda.' };
    return { preco: r2(precoAtual), direcao: 0, motivo: 'Sem sinal claro: manter o preço.' };
}

async function aplicar(itemId, novoPreco, { confirmarGrande = false, origem = 'seven', motivo = '' } = {}) {
    const p = r2(novoPreco);
    if (!(p > 0)) throw new Error('Preço inválido.');
    const { headers } = await auth();
    const { data: it } = await axios.get(`${ML}/items/${itemId}`, { headers, timeout: 20000 });
    const antes = it.price;
    const dif = antes ? Math.abs(p - antes) / antes * 100 : 100;
    if (dif > LIMITE_PCT && !confirmarGrande) return { ok: false, precisa_confirmar: true, erro: `A mudança é de ${dif.toFixed(1)}% (acima de ${LIMITE_PCT}%). Confirme de novo para aplicar.` };
    const corpo = (it.variations || []).length ? { variations: it.variations.map(v => ({ id: v.id, price: p })) } : { price: p };
    try {
        await axios.put(`${ML}/items/${itemId}`, corpo, { headers: { ...headers, 'Content-Type': 'application/json' }, timeout: 30000 });
    } catch (e) {
        const msg = e.response?.data?.message || e.response?.data?.error || e.message;
        const causa = (e.response?.data?.cause || []).map(c => c.message || c.code).join('; ');
        return { ok: false, erro: `O ML recusou (${e.response?.status || ''}): ${msg}${causa ? ' — ' + causa : ''}` };
    }
    const reg = { quando: new Date().toISOString(), item_id: itemId, titulo: it.title, antes, depois: p, origem, motivo };
    fs.mkdirSync(STORAGE, { recursive: true });
    fs.appendFileSync(HIST, JSON.stringify(reg) + '\n', 'utf8');
    return { ok: true, ...reg };
}

function historico(itemId, n = 20) {
    try {
        return fs.readFileSync(HIST, 'utf8').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
            .filter(x => x && (!itemId || x.item_id === itemId)).reverse().slice(0, n);
    } catch { return []; }
}

module.exports = { dados, sugestao, aplicar, historico };
