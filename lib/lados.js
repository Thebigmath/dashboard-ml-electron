// Lados de um produto (Direito / Esquerdo / Par) — regras do usuário (13/10/2026):
//   1) mudou o preço de um lado, muda o do outro lado também (mesma variação, mesmo tipo de anúncio)
//   2) não subir o preço quando falta estoque: do próprio produto, do outro lado, ou de um dos lados do Par
// SKU da base: "35063d" (direito), "35063e" (esquerdo), "35063d-35063e-par" (par), com sufixos como "-cristal".
// Estoque: o da coleta de estoque (reposicao.json; Full ao vivo na última coleta, ou o declarado fora do Full).
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const P = require('./precificador');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ML = 'https://api.mercadolibre.com';
const lerRep = () => { try { return JSON.parse(fs.readFileSync(path.join(STORAGE, 'reposicao.json'), 'utf8')); } catch { return []; } };
const base = (s) => String(s || '').toLowerCase().split('~')[0].split('#')[0].trim();
const NOME = { d: 'Direito', e: 'Esquerdo' };

// estoque de um SKU (soma das entradas da coleta com esse SKU); null = SKU fora da coleta
function estoqueSku(sku, rep) {
    const L = (rep || lerRep()).filter(r => base(r.chave || r.sku) === base(sku));
    return L.length ? L.reduce((s, r) => s + (Number(r.estoque) || 0), 0) : null;
}
function lados(sku) {
    const s = base(sku);
    const par = s.match(/^(\d{4,6}[de][a-z0-9]*?)-(\d{4,6}[de][a-z0-9]*?)-par/);
    if (par) return { tipo: 'par', lados: [par[1], par[2]] };
    const m = s.match(/^(\d{4,6})([de])(.*)$/);
    if (m) return { tipo: 'lado', lado: m[2], oposto: m[1] + (m[2] === 'd' ? 'e' : 'd') + m[3] };
    return { tipo: 'outro' };
}

// Trava de estoque: devolve o motivo para NÃO subir, ou null
function travaEstoque(sku) {
    if (!sku) return null;
    const rep = lerRep(), S = String(sku).toUpperCase();
    const proprio = estoqueSku(sku, rep);
    if (proprio === 0) return `Sem estoque (${S}): não subir o preço de produto zerado.`;
    const l = lados(sku);
    if (l.tipo === 'par') {
        const falta = l.lados.filter(x => estoqueSku(x, rep) === 0);
        if (falta.length) return `Falta ${falta.map(x => `o lado ${NOME[x.match(/^\d+([de])/)[1]]} (${x.toUpperCase()})`).join(' e ')} no estoque: o par não fecha. Não subir.`;
    }
    if (l.tipo === 'lado' && estoqueSku(l.oposto, rep) === 0)
        return `O outro lado (${NOME[l.lado === 'd' ? 'e' : 'd']}, ${l.oposto.toUpperCase()}) está sem estoque: não subir este lado sozinho.`;
    return null;
}

// Anúncios do outro lado (mesmo tipo de anúncio do que foi mudado), para aplicar a mesma variação
async function opostos(itemId) {
    const rep = lerRep();
    const meu = rep.find(r => r.item_id === itemId);
    const { headers } = await P.auth();
    let sku = meu && base(meu.chave || meu.sku);
    let tipo = null;
    try {
        const it = (await axios.get(`${ML}/items/${itemId}`, { headers, params: { attributes: 'id,listing_type_id,seller_custom_field,attributes' }, timeout: 20000 })).data;
        tipo = it.listing_type_id;
        if (!sku) sku = it.seller_custom_field || ((it.attributes || []).find(a => a.id === 'SELLER_SKU') || {}).value_name || '';
    } catch {}
    const l = lados(sku);
    if (l.tipo !== 'lado') return { sku: sku || null, oposto: null, itens: [] };
    const cand = [...new Set(rep.filter(r => base(r.chave || r.sku) === l.oposto && r.status === 'active' && r.item_id && r.item_id !== itemId).map(r => r.item_id))];
    const itens = [];
    for (let i = 0; i < cand.length; i += 20) {
        try {
            const lote = (await axios.get(`${ML}/items`, { headers, params: { ids: cand.slice(i, i + 20).join(','), attributes: 'id,title,price,listing_type_id,status' }, timeout: 20000 })).data;
            for (const r of lote || []) if (r.code === 200 && r.body.status === 'active' && (!tipo || r.body.listing_type_id === tipo))
                itens.push({ item_id: r.body.id, titulo: r.body.title, preco: r.body.price, tipo: r.body.listing_type_id, estoque: estoqueSku(l.oposto, rep) });
        } catch {}
    }
    return { sku: String(sku).toUpperCase(), oposto: l.oposto.toUpperCase(), lado_oposto: NOME[l.lado === 'd' ? 'e' : 'd'], tipo, itens };
}

// pelo anuncio: o SKU real e a "chave" da coleta (o "sku" pode ser um rotulo como "32081e-sandero")
function travaEstoqueItem(itemId, skuReserva) {
    const r = lerRep().find(x => x.item_id === itemId);
    return travaEstoque(r ? (r.chave || r.sku) : skuReserva);
}

module.exports = { travaEstoque, travaEstoqueItem, opostos, lados, estoqueSku };
