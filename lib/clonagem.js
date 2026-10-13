// Clonagem de anuncios (AD HEALTH): copia um anuncio como anuncio NOVO nesta mesma conta (padrao) ou na OUTRA
// conta (Flavia <-> Cordeiro). Destino escolhido por anuncio da fila (edicao.destino: 'esta' | 'outra').
// Fila em storage/clonagem.json. Cada anuncio da fila pode ter titulo, descricao, preco, estoque, SKU e tipo editados.
// Vendas, avaliacoes e perguntas NAO vao junto: sao do MLB de origem; o clone nasce do zero.
//   validar(): manda o corpo para POST /items/validate da outra conta — nao cria nada
//   clonar():  cria de verdade (POST /items) + descricao + compatibilidades; grava o MLB novo na fila
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const P = require('./precificador');
const outra = require('./outra_conta');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ARQ = path.join(STORAGE, 'clonagem.json');
const ML = 'https://api.mercadolibre.com';
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
const ler = () => lerJson(ARQ, { fila: [] });
const gravar = (d) => { fs.mkdirSync(STORAGE, { recursive: true }); fs.writeFileSync(ARQ, JSON.stringify(d, null, 2), 'utf8'); };
const mlbDe = (txt) => { const m = String(txt || '').toUpperCase().replace(/MLB-?/, 'MLB').match(/MLB\d{6,}/); return m ? m[0] : null; };
// atributos que o ML calcula sozinho ou que nao podem ser enviados na criacao
const ATRIB_FORA = new Set(['ITEM_CONDITION', 'GTIN_RELATIONSHIP', 'PRODUCT_DATA_SOURCE', 'IS_HIGHLIGHT_BRAND', 'IS_TOM_BRAND', 'IS_SUITABLE_FOR_SHIPMENT', 'EXCLUSIVE_CHANNEL',
    'CATALOG_TITLE', 'HAS_COMPATIBILITIES', 'PACKAGE_HEIGHT', 'PACKAGE_LENGTH', 'PACKAGE_WEIGHT', 'PACKAGE_WIDTH', 'PRODUCT_FEATURES', 'SHIPMENT_PACKING']);

async function origem(mlb) {
    const { headers } = await P.auth();
    const [item, desc] = await Promise.all([
        axios.get(`${ML}/items/${mlb}`, { headers, params: { include_attributes: 'all' }, timeout: 30000 }).then(r => r.data),
        axios.get(`${ML}/items/${mlb}/description`, { headers, timeout: 30000 }).then(r => r.data).catch(() => ({})),
    ]);
    let compat = [];
    try { compat = (await axios.get(`${ML}/items/${mlb}/compatibilities`, { headers, timeout: 30000 })).data.products || []; } catch { /* sem compatibilidade */ }
    const sku = (item.attributes || []).find(a => a.id === 'SELLER_SKU')?.value_name || item.seller_custom_field || '';
    return { item, descricao: desc.plain_text || '', compat, sku };
}

function lista() {
    const d = ler();
    for (const r of d.fila) if (r.status !== 'clonado' && !r.edicao.destino) r.edicao.destino = 'esta';
    return { ...outra.info(), fila: d.fila };
}

// token e nome da conta onde o anuncio novo vai ser criado
async function destino(r) {
    const info = outra.info();
    if ((r.edicao.destino || 'esta') === 'esta') return { headers: (await P.auth()).headers, conta: info.esta_conta };
    if (!info.disponivel) throw new Error(info.motivo);
    return { headers: (await outra.cabecalhos()).headers, conta: info.outra_conta };
}

async function adicionar(texto) {
    const ids = [...new Set(String(texto || '').split(/[\s,;]+/).map(mlbDe).filter(Boolean))];
    if (!ids.length) throw new Error('Cole o MLB ou o link do anúncio.');
    const d = ler();
    const novos = [];
    for (const mlb of ids) {
        if (d.fila.some(x => x.mlb === mlb && x.status !== 'clonado')) continue;
        const o = await origem(mlb);
        const it = o.item;
        const reg = { mlb, adicionado_em: new Date().toISOString(), status: 'na_fila', thumbnail: it.thumbnail, permalink: it.permalink,
            original: { titulo: it.title, preco: it.price, estoque: it.available_quantity, sku: o.sku, tipo: it.listing_type_id, status: it.status,
                logistica: it.shipping?.logistic_type || '', fotos: (it.pictures || []).length, variacoes: (it.variations || []).length,
                vendidos: it.sold_quantity ?? null, compat: o.compat.length },
            // no modelo novo o ML monta o titulo a partir do nome do produto (family_name) + ficha tecnica (lado, cor)
            edicao: { titulo: it.family_name || it.title, preco: it.price, estoque: Math.max(1, Math.min(it.available_quantity || 1, 999)), sku: o.sku, tipo: it.listing_type_id, descricao: o.descricao, destino: 'esta' } };
        d.fila.unshift(reg);
        novos.push(mlb);
    }
    gravar(d);
    return { adicionados: novos, ...lista() };
}

function editar(mlb, edicao) {
    const d = ler();
    const r = d.fila.find(x => x.mlb === mlb && x.status !== 'clonado');
    if (!r) throw new Error('Anúncio não está na fila.');
    const e = r.edicao;
    if (edicao.titulo != null) e.titulo = String(edicao.titulo).trim();
    if (edicao.descricao != null) e.descricao = String(edicao.descricao);
    if (edicao.preco != null) e.preco = Number(edicao.preco);
    if (edicao.estoque != null) e.estoque = Math.max(1, parseInt(edicao.estoque) || 1);
    if (edicao.sku != null) e.sku = String(edicao.sku).trim();
    if (edicao.destino != null) e.destino = edicao.destino === 'outra' ? 'outra' : 'esta';
    if (edicao.tipo != null) e.tipo = ['gold_special', 'gold_pro'].includes(edicao.tipo) ? edicao.tipo : e.tipo;
    r.status = 'na_fila'; r.validacao = null;
    gravar(d);
    return r;
}

function remover(mlb) {
    const d = ler();
    d.fila = d.fila.filter(x => !(x.mlb === mlb && x.status !== 'clonado'));
    gravar(d);
    return lista();
}

// corpo do anuncio novo, a partir do original + o que foi editado.
// Contas no modelo novo do ML ("User Products", as duas hoje) nao aceitam "title": o nome vai em "family_name"
// e o ML monta o titulo. modo 'classico' manda "title" para conta no modelo antigo.
function corpo(it, e, modo = 'up') {
    const atributo = (a) => ({ id: a.id, ...(a.value_id ? { value_id: a.value_id } : {}), ...(a.value_name != null ? { value_name: a.value_name } : {}) });
    const attrs = (it.attributes || []).filter(a => a.id && !ATRIB_FORA.has(a.id) && a.id !== 'SELLER_SKU' && (a.value_id || a.value_name)).map(atributo);
    if (e.sku && !(it.variations || []).length) attrs.push({ id: 'SELLER_SKU', value_name: e.sku });
    const fotos = (it.pictures || []).map(p => ({ source: p.secure_url || p.url }));
    const urlDaFoto = Object.fromEntries((it.pictures || []).map(p => [p.id, p.secure_url || p.url]));
    const b = {
        ...(modo === 'up' ? { family_name: e.titulo } : { title: e.titulo }), category_id: it.category_id, price: e.preco, currency_id: it.currency_id || 'BRL',
        available_quantity: e.estoque, buying_mode: it.buying_mode || 'buy_it_now', listing_type_id: e.tipo || it.listing_type_id,
        condition: it.condition || 'new', pictures: fotos, attributes: attrs,
        sale_terms: (it.sale_terms || []).map(atributo),
        shipping: { mode: 'me2', local_pick_up: false, free_shipping: !!it.shipping?.free_shipping },
    };
    if ((it.variations || []).length) {
        const n = it.variations.length;
        b.variations = it.variations.map(v => ({
            price: e.preco, available_quantity: Math.max(1, Math.floor(e.estoque / n)),
            attribute_combinations: (v.attribute_combinations || []).map(atributo),
            picture_ids: (v.picture_ids || []).map(id => urlDaFoto[id]).filter(Boolean),
            attributes: (v.attributes || []).filter(a => a.id && (a.value_id || a.value_name)).map(atributo),
        }));
        delete b.available_quantity;
    }
    return b;
}

const erroML = (e) => {
    const d = e.response?.data;
    if (!d) return e.message;
    const causas = (d.cause || []).filter(c => c.type !== 'warning').map(c => c.message).filter(Boolean);
    return [d.message, ...causas].filter(Boolean).join(' · ') || JSON.stringify(d).slice(0, 400);
};
// manda no modelo novo; se a conta for do modelo antigo (family_name recusado), manda com title
async function enviar(url, it, e, headers, timeout) {
    try { return await axios.post(url, corpo(it, e, 'up'), { headers, timeout }); }
    catch (x) {
        const txt = JSON.stringify(x.response?.data || '');
        if (x.response && /family_name/.test(txt) && !/required_fields/.test(txt)) return axios.post(url, corpo(it, e, 'classico'), { headers, timeout });
        throw x;
    }
}
const AVISOS = { 'shipping.lost_me1_by_user': null, 'item.shipping.mandatory_free_shipping': 'O ML vai colocar frete grátis (obrigatório nesse preço).' };
const avisosML = (e) => (e.response?.data?.cause || []).filter(c => c.type === 'warning')
    .map(c => c.code in AVISOS ? AVISOS[c.code] : /ignored because it is not modifiable/.test(c.message) ? null : c.message).filter(Boolean);

async function validar(mlb) {
    const d = ler();
    const r = d.fila.find(x => x.mlb === mlb && x.status !== 'clonado');
    if (!r) throw new Error('Anúncio não está na fila.');
    const o = await origem(mlb);
    const { headers, conta } = await destino(r);
    let res;
    try {
        await enviar(`${ML}/items/validate`, o.item, r.edicao, headers, 30000);
        res = { ok: true, em: new Date().toISOString(), avisos: [] };
    } catch (e) {
        if (!e.response) throw e;
        // o ML responde 400 mesmo quando so ha avisos (ex.: "frete gratis obrigatorio adicionado"); aviso nao impede publicar
        const causas = e.response.data?.cause || [];
        res = causas.length && causas.every(c => c.type === 'warning')
            ? { ok: true, em: new Date().toISOString(), avisos: avisosML(e) }
            : { ok: false, em: new Date().toISOString(), erro: erroML(e), avisos: avisosML(e) };
    }
    r.validacao = res; r.status = res.ok ? 'validado' : 'com_erro';
    gravar(d);
    return r;
}

async function clonar(mlb) {
    const d = ler();
    const r = d.fila.find(x => x.mlb === mlb && x.status !== 'clonado');
    if (!r) throw new Error('Anúncio não está na fila.');
    const o = await origem(mlb);
    const { headers, conta } = await destino(r);
    let novo;
    try { novo = (await enviar(`${ML}/items`, o.item, r.edicao, headers, 60000)).data; }
    catch (e) {
        if (!e.response) throw e;
        r.status = 'com_erro'; r.validacao = { ok: false, em: new Date().toISOString(), erro: erroML(e), avisos: avisosML(e) };
        gravar(d);
        return r;
    }
    const passos = [];
    if (r.edicao.descricao) {
        try { await axios.post(`${ML}/items/${novo.id}/description`, { plain_text: r.edicao.descricao }, { headers, timeout: 30000 }); passos.push('descrição ok'); }
        catch (e) { passos.push('descrição falhou: ' + erroML(e)); }
    }
    if (o.compat.length) {
        try {
            for (let i = 0; i < o.compat.length; i += 200)
                await axios.post(`${ML}/items/${novo.id}/compatibilities`, { products: o.compat.slice(i, i + 200).map(c => ({ id: c.catalog_product_id || c.id })) }, { headers, timeout: 60000 });
            passos.push(`${o.compat.length} compatibilidade(s) ok`);
        } catch (e) { passos.push('compatibilidades falharam: ' + erroML(e)); }
    }
    r.status = 'clonado';
    r.clone = { id: novo.id, permalink: novo.permalink, status: novo.status, em: new Date().toISOString(), conta, passos };
    gravar(d);
    return r;
}

module.exports = { lista, adicionar, editar, remover, validar, clonar, corpo };
