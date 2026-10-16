// Flex automatico pelo estoque do Olist (pedido do usuario em 16/10/2026).
//   Estoque do produto no deposito Geral do Olist ZEROU  -> tira do Flex os anuncios da conta que estao com Flex.
//   Voltou a ter estoque                                -> devolve ao Flex SO os anuncios que este motor tirou.
// Anuncio que o usuario nunca colocou no Flex nao e tocado. SKU que nao existe no Olist nao e tocado.
// So a conta Flavia (o Olist e dela; Cordeiro em standby) e so o Dashboard da Flavia roda o motor (o da Cordeiro so
// mostra), para as duas nao agirem em dobro. Liga/desliga na tela do ERP Commander; tudo fica no historico.
// API do ML: GET/POST/DELETE /flex/sites/MLB/items/{id}/v2 (GET devolve { has_flex }).
const fs = require('fs');
const os = require('os');
const path = require('path');
const O = require('./olist_estoque');

const PASTA = path.join(os.homedir(), '.seven');
const ARQ = path.join(PASTA, 'flex_auto.json');          // { ligado, removidos: { item_id: {sku, titulo, em, saldo} } }
const ARQ_HIST = path.join(PASTA, 'flex_historico.json');
const CONTA = 'flavia';
const INTERVALO_MS = 30 * 60 * 1000;
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
const gravar = (arq, v) => { fs.mkdirSync(PASTA, { recursive: true }); fs.writeFileSync(arq, JSON.stringify(v), 'utf8'); };
const dormir = (ms) => new Promise(r => setTimeout(r, ms));

function esteAppRoda() {
    const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
    return path.basename(path.dirname(STORAGE)) === 'dashboard-ml';
}
function config() { return { ligado: false, removidos: {}, ...lerJson(ARQ, {}) }; }
function salvarConfig(c) { gravar(ARQ, c); }
function registrar(ev) {
    const h = lerJson(ARQ_HIST, []);
    h.unshift({ quando: new Date().toISOString(), ...ev });
    gravar(ARQ_HIST, h.slice(0, 2000));
}

const estado = { rodando: false, ultima: null, proxima: null, erro: null, etapa: null, resumo: null };

// anuncios ativos e pausados da conta com SKU e situacao do Flex (pelas tags do anuncio)
async function anunciosDaConta(headers, userId) {
    const ids = [];
    for (const status of ['active', 'paused']) {
        let scroll = null;
        for (let g = 0; g < 200; g++) {
            const r = await O.mlGet(`https://api.mercadolibre.com/users/${userId}/items/search`, headers, { search_type: 'scan', limit: 100, status, ...(scroll ? { scroll_id: scroll } : {}) });
            if (!r || !(r.results || []).length) break;
            ids.push(...r.results); scroll = r.scroll_id;
            if (!scroll) break;
        }
    }
    const out = [];
    for (let i = 0; i < ids.length; i += 20) {
        const lote = await O.mlGet('https://api.mercadolibre.com/items', headers, { ids: ids.slice(i, i + 20).join(','), attributes: 'id,title,status,seller_custom_field,attributes,shipping' });
        for (const x of lote || []) {
            const b = x.code === 200 && x.body; if (!b) continue;
            const sku = b.seller_custom_field || ((b.attributes || []).find(a => a.id === 'SELLER_SKU') || {}).value_name;
            const tags = (b.shipping && b.shipping.tags) || [];
            out.push({ item_id: b.id, titulo: b.title, status: b.status, sku: sku ? String(sku).trim() : null, flex: tags.includes('self_service_in') });
        }
    }
    return out;
}

async function flexMudar(headers, itemId, ligar) {
    const axios = require('axios');
    const url = `https://api.mercadolibre.com/flex/sites/MLB/items/${itemId}/v2`;
    for (let t = 0; t < 4; t++) {
        try {
            if (ligar) await axios.post(url, {}, { headers, timeout: 20000 });
            else await axios.delete(url, { headers, timeout: 20000 });
            return;
        } catch (e) {
            const st = e.response && e.response.status;
            if (st === 429 || !st || st >= 500) { await dormir(3000 * (t + 1)); continue; }
            throw new Error(`ML ${st}: ${JSON.stringify(e.response.data || '').slice(0, 140)}`);
        }
    }
    throw new Error('o Mercado Livre não respondeu');
}

// uma verificacao completa. simular=true so calcula o que faria (nao mexe em nada)
async function verificar({ simular = false } = {}) {
    if (estado.rodando) return { ok: false, erro: 'Já está verificando.' };
    estado.rodando = true; estado.erro = null; estado.etapa = 'lendo o estoque do Olist';
    const acoes = [];
    try {
        await O.atualizarSaldos();
        estado.etapa = 'lendo os anúncios da conta Flavia';
        const { headers, userId } = await O.cabecalhosDa(CONTA);
        const anuncios = (await anunciosDaConta(headers, userId)).filter(a => a.sku);
        const c = config();
        // so interessa: anuncio com Flex agora, ou anuncio que este motor tirou do Flex
        const alvo = anuncios.filter(a => a.flex || c.removidos[a.item_id]);
        estado.etapa = 'conferindo SKUs no Olist';
        await O.completarSaldos(alvo.map(a => a.sku));
        const S = O.lerSaldos();
        for (const a of alvo) {
            const s = O.saldoDoRetrato(S, a.sku);
            if (!s || s.geral == null) continue;                 // fora do Olist: nao mexe
            if (a.flex && s.geral <= 0) acoes.push({ ...a, acao: 'tirar', saldo: s.geral, codigo: s.codigo });
            else if (!a.flex && c.removidos[a.item_id] && s.geral > 0) acoes.push({ ...a, acao: 'devolver', saldo: s.geral, codigo: s.codigo });
            else if (a.flex && c.removidos[a.item_id]) { delete c.removidos[a.item_id]; }   // alguem ja devolveu
        }
        if (!simular) {
            estado.etapa = 'ajustando o Flex';
            for (const a of acoes) {
                try {
                    await flexMudar(headers, a.item_id, a.acao === 'devolver');
                    if (a.acao === 'tirar') c.removidos[a.item_id] = { sku: a.sku, titulo: a.titulo, em: new Date().toISOString(), saldo: a.saldo };
                    else delete c.removidos[a.item_id];
                    a.ok = true;
                    registrar({ item_id: a.item_id, sku: a.sku, titulo: a.titulo, acao: a.acao, saldo: a.saldo, ok: true });
                } catch (e) {
                    a.ok = false; a.erro = e.message;
                    registrar({ item_id: a.item_id, sku: a.sku, titulo: a.titulo, acao: a.acao, saldo: a.saldo, ok: false, erro: e.message });
                }
                await dormir(400);
            }
            salvarConfig({ ...config(), removidos: c.removidos });
        }
        if (simular) estado.simulacao = { em: new Date().toISOString(), acoes: acoes.map(x => ({ item_id: x.item_id, sku: x.sku, titulo: x.titulo, acao: x.acao, saldo: x.saldo })) };
        estado.resumo = { anuncios: anuncios.length, com_flex: anuncios.filter(a => a.flex).length, tirar: acoes.filter(a => a.acao === 'tirar').length, devolver: acoes.filter(a => a.acao === 'devolver').length, simulado: simular };
        return { ok: true, acoes, resumo: estado.resumo };
    } catch (e) { estado.erro = e.message; return { ok: false, erro: e.message }; }
    finally { estado.rodando = false; estado.etapa = null; estado.ultima = new Date().toISOString(); }
}

let timer = null;
function iniciarAgendador() {
    if (timer || !esteAppRoda()) return;
    const rodar = async () => {
        estado.proxima = new Date(Date.now() + INTERVALO_MS).toISOString();
        if (config().ligado) await verificar().catch(() => {});
    };
    setTimeout(rodar, 3 * 60 * 1000);
    timer = setInterval(rodar, INTERVALO_MS);
}
function pararAgendador() { if (timer) clearInterval(timer); timer = null; }

function ligar(v) {
    if (!esteAppRoda()) return { ok: false, erro: 'O Flex automático roda só no Dashboard da Flavia.' };
    salvarConfig({ ...config(), ligado: !!v });
    if (v && !estado.rodando) verificar().catch(() => {});
    return { ok: true, ligado: !!v };
}
function status() {
    const c = config();
    return { ligado: c.ligado, roda_aqui: esteAppRoda(), estado: { ...estado }, removidos: Object.entries(c.removidos).map(([item_id, r]) => ({ item_id, ...r })),
        historico: lerJson(ARQ_HIST, []).slice(0, 200), intervalo_min: INTERVALO_MS / 60000 };
}

module.exports = { verificar, iniciarAgendador, pararAgendador, ligar, status, flexMudar };
