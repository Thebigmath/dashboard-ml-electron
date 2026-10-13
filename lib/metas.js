// Metas de vendas por produto (unidades por DIA), usadas pela regra de preço.
// Definidas pelo usuário em 13/10/2026 para os tapetes da Flavia Stock. Ficam em
// STORAGE/metas_vendas.json (cada conta tem as suas); na Flavia, se o arquivo não
// existir, nasce com a lista abaixo. Meta null = produto sem meta (não sobe pela regra de metas).
// Cada meta é SKU + palavras do título, porque o mesmo SKU vale para carros diferentes
// (010TB = Polo, Tera e Nivus).
const fs = require('fs');
const path = require('path');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ARQ = path.join(STORAGE, 'metas_vendas.json');
const INICIAIS_FLAVIA = [
    { sku: '010TB', modelo: 'Polo', meta: 4 }, { sku: '010TB', modelo: 'Tera', meta: 1.2 }, { sku: '010TB', modelo: 'Nivus', meta: 1 },
    { sku: '013TB', modelo: 'Virtus', meta: 1.6 }, { sku: '013TB', modelo: 'Tcross', meta: 2 },
    { sku: '020TB', modelo: 'Fastback', meta: 2 }, { sku: '020TB', modelo: 'Pulse', meta: 1.6 },
    { sku: '23TB', modelo: 'Compass', meta: 3 }, { sku: '23TB', modelo: 'Commander', meta: 1.6 },
    { sku: '25TB', modelo: 'Renegade', meta: 3 }, { sku: '27TB', modelo: 'Toro', meta: 5 }, { sku: '28TB', modelo: 'Rampage', meta: 1 },
    { sku: '030TB', modelo: 'Fastback', meta: 1 }, { sku: '030TB', modelo: 'Pulse', meta: null },
    { sku: '032TB', modelo: 'Strada', meta: 3 }, { sku: '035TB', modelo: 'Argo', meta: 2 }, { sku: '035TB', modelo: 'Cronos', meta: 1 },
    { sku: '050TB', modelo: 'Hilux', meta: 1.6 }, { sku: '040TB', modelo: 'Creta', meta: 2 },
];

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// "023tb-commander" / "23TB" / "023tb~mlb123" -> "23tb"
const baseSku = (s) => String(s || '').toLowerCase().split('~')[0].split('-')[0].replace(/^0+(?=\d)/, '').trim();

function lista() {
    try { const d = JSON.parse(fs.readFileSync(ARQ, 'utf8')); if (Array.isArray(d)) return d; } catch {}
    if (path.basename(path.dirname(STORAGE)) === 'dashboard-ml') {
        try { fs.mkdirSync(STORAGE, { recursive: true }); fs.writeFileSync(ARQ, JSON.stringify(INICIAIS_FLAVIA, null, 2), 'utf8'); } catch {}
        return INICIAIS_FLAVIA;
    }
    return [];
}

// meta do produto: { meta, modelo } ou null se o produto não está na lista
function metaDe(sku, titulo) {
    const b = baseSku(sku), t = semAcento(titulo).replace(/[\s-]+/g, '');
    if (!b) return null;
    const m = lista().find(x => baseSku(x.sku) === b && t.includes(semAcento(x.modelo).replace(/[\s-]+/g, '')));
    return m ? { meta: m.meta == null ? null : Number(m.meta), modelo: m.modelo, sku: m.sku } : null;
}

module.exports = { lista, metaDe, ARQ };
