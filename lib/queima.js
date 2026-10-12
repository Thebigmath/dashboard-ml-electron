// Queima-margem (AD HEALTH > Controle de estoque parado): coloca um anuncio parado em
// Desconto Direto com o preco que deixa so 5% de margem de contribuicao, para o estoque girar.
//
// So manual: a tela mostra antes/depois e so aplica com o clique da pessoa. Sem progressao
// automatica por enquanto (decisao de 07/10/2026).
//
// Preco alvo: margem = P - frete - custo - imposto(P) - tarifa(P) = 5% de P. A tarifa tem parte
// percentual e parte fixa e muda com o preco, entao o calculo repete ate estabilizar.
//
// Aplicar: POST /seller-promotions/items/{id}?app_version=v2 { promotion_type: PRICE_DISCOUNT,
// deal_price, start_date, finish_date }. Se o anuncio ja estiver em outra promocao ativa, ela
// sai antes (o ML nao deixa duas). Tudo fica em queima_historico.jsonl.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const P = require('./precificador');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ML = 'https://api.mercadolibre.com';
const HIST = path.join(STORAGE, 'queima_historico.jsonl');
const MARGEM_ALVO = 5;      // % de margem de contribuicao
const DIAS_PROMO = 14;      // duracao do Desconto Direto
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const lerJson = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(STORAGE, f), 'utf8')); } catch { return d; } };

async function promocoesDoItem(headers, itemId) {
    try {
        const { data } = await axios.get(`${ML}/seller-promotions/items/${itemId}`, { headers, params: { app_version: 'v2' }, timeout: 20000 });
        return Array.isArray(data) ? data : [];
    } catch { return []; }
}

// Tudo o que a janela "Ativar queima-margem" precisa, sem mudar nada no ML
async function simular(itemId) {
    const { headers, userId } = await P.auth();
    const { data: it } = await axios.get(`${ML}/items/${itemId}`, { headers, params: { include_attributes: 'all' }, timeout: 20000 });
    const sku = it.seller_custom_field || ((it.attributes || []).find(a => a.id === 'SELLER_SKU') || {}).value_name || '';
    const custo = P.custoDoSku(sku);
    const impostoPct = Number(lerJson('config.json', {}).imposto_pct ?? 3);
    let frete = null;
    try {
        const { data } = await axios.get(`${ML}/users/${userId}/shipping_options/free`, { headers, params: { item_id: itemId }, timeout: 20000 });
        frete = (data.coverage || {}).all_country?.list_cost ?? null;
    } catch {}

    const base = { item_id: it.id, titulo: it.title, sku, thumbnail: it.thumbnail, full: it.shipping?.logistic_type === 'fulfillment',
        preco_atual: it.price, custo: custo ? custo.valor : null, frete, imposto_pct: impostoPct, margem_alvo: MARGEM_ALVO };
    const tarAtual = await P.tarifa(headers, it.price, it.listing_type_id, it.category_id);
    base.antes = { preco: it.price, ...P.margem(it.price, frete, custo && custo.valor, impostoPct, tarAtual && tarAtual.valor) };

    // promocoes e ADS atuais (avisos da janela)
    const promos = await promocoesDoItem(headers, itemId);
    const ativa = promos.find(p => p.status === 'started');
    base.promocao_ativa = ativa ? { tipo: ativa.type, id: ativa.id || null, nome: ativa.name || ativa.type, preco: ativa.price } : null;
    const cand = promos.find(p => p.type === 'PRICE_DISCOUNT');
    base.limites = cand ? { min: cand.min_discounted_price, max: cand.max_discounted_price } : null;
    try { base.ads = (lerJson('parado_ads.json', {}).mapa || {})[itemId] || null; } catch { base.ads = null; }

    if (!base.full) return { ...base, pode: false, motivo: 'Só anúncios do Full entram na queima-margem.' };
    if (!custo) return { ...base, pode: false, motivo: 'Sem custo na planilha de custos: não dá para calcular a margem.' };
    if (frete == null) return { ...base, pode: false, motivo: 'O ML não informou o frete deste anúncio: não dá para calcular a margem.' };

    // preco que deixa MARGEM_ALVO% de margem (repete porque a tarifa muda com o preco)
    let preco = it.price, tar = tarAtual;
    for (let i = 0; i < 6; i++) {
        const pct = (tar && tar.pct != null ? Number(tar.pct) : 0) / 100;
        const fixa = tar && tar.fixa != null ? Number(tar.fixa) : 0;
        const novo = r2((frete + custo.valor + fixa) / (1 - impostoPct / 100 - pct - MARGEM_ALVO / 100));
        if (Math.abs(novo - preco) < 0.01) break;
        preco = novo;
        tar = await P.tarifa(headers, preco, it.listing_type_id, it.category_id);
    }
    const depois = { preco, ...P.margem(preco, frete, custo.valor, impostoPct, tar && tar.valor) };
    const r = { ...base, depois, desconto_pct: r2((1 - preco / it.price) * 100) };
    if (!(preco < it.price)) return { ...r, pode: false, motivo: `O preço atual já deixa ${base.antes.margem_pct}% de margem, abaixo de ${MARGEM_ALVO}%: não há o que queimar.` };
    if (r.limites && preco < r.limites.min) return { ...r, pode: false, motivo: `O ML só aceita Desconto Direto a partir de R$ ${r.limites.min} neste anúncio.` };
    if (r.limites && preco > r.limites.max) return { ...r, pode: false, motivo: `O desconto é pequeno demais: o ML exige preço de no máximo R$ ${r.limites.max} no Desconto Direto.` };
    const aviso79 = it.price >= 79 && preco < 79 ? 'Abaixo de R$ 79 o frete pode mudar: confira a margem depois.' : '';
    return { ...r, pode: true, aviso: aviso79 };
}

// Aplica de verdade (so chamado pelo botao, com a pessoa confirmando)
async function aplicar(itemId, precoEsperado) {
    const s = await simular(itemId);
    if (!s.pode) return { ok: false, erro: s.motivo };
    // o preco tem que ser o mesmo que a pessoa viu na janela
    if (Math.abs(s.depois.preco - Number(precoEsperado)) > 0.05) return { ok: false, erro: `O preço calculado mudou (agora R$ ${s.depois.preco}). Abra a janela de novo.` };
    const { headers } = await P.auth();
    const h = { ...headers, 'Content-Type': 'application/json' };
    const erroML = (e) => `${e.response?.status || ''} ${e.response?.data?.message || e.response?.data?.error || e.message}`;

    if (s.promocao_ativa) {
        try {
            await axios.delete(`${ML}/seller-promotions/items/${itemId}`, { headers: h, timeout: 30000,
                params: { app_version: 'v2', promotion_type: s.promocao_ativa.tipo, ...(s.promocao_ativa.id ? { promotion_id: s.promocao_ativa.id } : {}) } });
        } catch (e) { return { ok: false, erro: `Não consegui tirar da promoção atual (${s.promocao_ativa.nome}): ${erroML(e)}` }; }
    }
    const ini = new Date(); const fim = new Date(ini.getTime() + DIAS_PROMO * 86400000);
    const fmt = (d) => new Date(d.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 19);
    try {
        await axios.post(`${ML}/seller-promotions/items/${itemId}`, {
            promotion_type: 'PRICE_DISCOUNT', deal_price: s.depois.preco, start_date: fmt(ini), finish_date: fmt(fim),
        }, { headers: h, params: { app_version: 'v2' }, timeout: 30000 });
    } catch (e) { return { ok: false, erro: `O ML recusou o Desconto Direto: ${erroML(e)}` }; }

    const reg = { quando: new Date().toISOString(), item_id: itemId, titulo: s.titulo, antes: s.preco_atual, depois: s.depois.preco,
        margem_antes: s.antes.margem_pct, margem_depois: s.depois.margem_pct, saiu_de: s.promocao_ativa ? s.promocao_ativa.nome : null, ate: fim.toISOString() };
    fs.mkdirSync(STORAGE, { recursive: true });
    fs.appendFileSync(HIST, JSON.stringify(reg) + '\n', 'utf8');
    try { fs.rmSync(path.join(STORAGE, 'parado_promocoes.json'), { force: true }); } catch {}   // etiquetas voltam a ser lidas
    return { ok: true, ...reg };
}

module.exports = { simular, aplicar, MARGEM_ALVO };
