// Monitor de cotas (Area do desenvolvedor): conta cada chamada ao Mercado Livre e ao Gemini,
// por dia e por hora, com os erros de cota (429) e o tempo de resposta.
//   ML ...... interceptor global do axios (toda chamada a api.mercadolibre.com / mercadopago)
//   Gemini .. registrado em lib/ia.js a cada tentativa (por chave e por modelo)
// Guarda os ultimos 14 dias em STORAGE/cotas.json (grava no maximo a cada 10 s).
const fs = require('fs');
const path = require('path');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ARQ = path.join(STORAGE, 'cotas.json');
const DIAS = 14;
let dados = null, sujo = false, timer = null;

const diaBR = (ms = Date.now()) => new Date(ms - 3 * 3600 * 1000).toISOString().slice(0, 10);
const horaBR = (ms = Date.now()) => new Date(ms - 3 * 3600 * 1000).toISOString().slice(11, 13);

function carregar() {
    if (dados) return dados;
    try { dados = JSON.parse(fs.readFileSync(ARQ, 'utf8')); } catch { dados = {}; }
    return dados;
}
function gravarDepois() {
    sujo = true;
    if (timer) return;
    timer = setTimeout(() => {
        timer = null;
        if (!sujo) return;
        sujo = false;
        const d = carregar();
        for (const k of Object.keys(d).sort().slice(0, -DIAS)) delete d[k];   // so os ultimos 14 dias
        try { fs.mkdirSync(STORAGE, { recursive: true }); fs.writeFileSync(ARQ, JSON.stringify(d), 'utf8'); } catch {}
    }, 10000);
    if (timer.unref) timer.unref();
}

// servico: 'ml' | 'mp' | 'gemini'; chave: rotulo (ex.: final da chave do Gemini / modelo)
function registrar(servico, { status = 200, ms = 0, chave = '', rota = '' } = {}) {
    const d = carregar(); const dia = diaBR(), hora = horaBR();
    const s = ((d[dia] ||= {})[servico] ||= { total: 0, erros: 0, cota: 0, ms: 0, horas: {}, chaves: {}, rotas: {} });
    s.total++; s.ms += ms;
    if (status === 429) s.cota++;
    else if (status >= 400 || status === 0) s.erros++;
    s.horas[hora] = (s.horas[hora] || 0) + 1;
    if (chave) { const c = (s.chaves[chave] ||= { total: 0, cota: 0, erros: 0 }); c.total++; if (status === 429) c.cota++; else if (status >= 400 || status === 0) c.erros++; }
    if (rota) s.rotas[rota] = (s.rotas[rota] || 0) + 1;
    gravarDepois();
}

// rota resumida: /items/MLB123 -> /items/:id (para agrupar sem guardar ids)
function rotaML(url) {
    try {
        const u = new URL(url);
        return u.pathname.replace(/\/MLB[A-Z]?\d+/g, '/:id').replace(/\/\d{4,}/g, '/:n').split('/').slice(0, 4).join('/') || '/';
    } catch { return '?'; }
}

// Liga o interceptor no axios global (chamado uma vez, no start do servidor)
function ligarAxios(axios) {
    if (axios.__cotas) return;
    axios.__cotas = true;
    axios.interceptors.request.use(cfg => { cfg.__t0 = Date.now(); return cfg; });
    const servico = (url) => /api\.mercadolibre\.com/.test(url || '') ? 'ml' : /api\.mercadopago\.com/.test(url || '') ? 'mp' : null;
    axios.interceptors.response.use(r => {
        const s = servico(r.config.url);
        if (s) registrar(s, { status: r.status, ms: Date.now() - (r.config.__t0 || Date.now()), rota: rotaML(r.config.url) });
        return r;
    }, e => {
        const c = e.config || {}, s = servico(c.url);
        if (s) registrar(s, { status: e.response?.status || 0, ms: Date.now() - (c.__t0 || Date.now()), rota: rotaML(c.url) });
        return Promise.reject(e);
    });
}

// Resumo para a tela: hoje, por hora, os ultimos dias e as rotas que mais gastam
function resumo() {
    const d = carregar(); const hoje = diaBR();
    const media = (s) => s && s.total ? Math.round(s.ms / s.total) : null;
    const dias = Object.keys(d).sort().slice(-DIAS).map(dia => ({
        dia, ml: d[dia].ml?.total || 0, ml_cota: d[dia].ml?.cota || 0, gemini: d[dia].gemini?.total || 0, gemini_cota: d[dia].gemini?.cota || 0, mp: d[dia].mp?.total || 0,
    }));
    const h = d[hoje] || {};
    const top = (s) => Object.entries(s?.rotas || {}).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([rota, n]) => ({ rota, n }));
    return {
        hoje, dias,
        ml: h.ml ? { total: h.ml.total, erros: h.ml.erros, cota: h.ml.cota, ms_medio: media(h.ml), horas: h.ml.horas, rotas: top(h.ml) } : { total: 0, erros: 0, cota: 0, horas: {}, rotas: [] },
        gemini: h.gemini ? { total: h.gemini.total, erros: h.gemini.erros, cota: h.gemini.cota, ms_medio: media(h.gemini), horas: h.gemini.horas, chaves: h.gemini.chaves } : { total: 0, erros: 0, cota: 0, horas: {}, chaves: {} },
        mp: h.mp ? { total: h.mp.total, erros: h.mp.erros, cota: h.mp.cota } : { total: 0, erros: 0, cota: 0 },
    };
}

module.exports = { registrar, ligarAxios, resumo };
