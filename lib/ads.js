// Campanhas ADS (AD HEALTH): desempenho do Product Ads pela API de Publicidade do ML.
//
//   anunciante .............. GET /advertising/advertisers?product_id=PADS
//   campanhas + metricas .... GET /advertising/MLB/advertisers/{id}/product_ads/campaigns/search?metrics=...
//   serie por dia ........... a mesma rota com aggregation_type=DAILY
// Receita = total_amount (venda direta + indireta atribuida ao anuncio). ACoS = gasto / receita.
// Fica guardado 15 min: o ML atualiza as metricas de ADS algumas vezes por dia.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const TokenManager = require('./tokenManager');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const CACHE = path.join(STORAGE, 'ads_resumo.json');
const VALIDADE_MS = 15 * 60 * 1000;
const METRICAS = 'clicks,prints,cost,cpc,acos,roas,direct_amount,indirect_amount,total_amount,units_quantity,direct_units_quantity,organic_units_quantity';
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const diaBR = (ms) => new Date(ms - 3 * 3600 * 1000).toISOString().slice(0, 10);

async function get(url, headers, params) {
    for (let t = 0; ; t++) {
        try { return (await axios.get(url, { headers, params, timeout: 30000 })).data; }
        catch (e) {
            // 429 (limite) e 5xx (ML instavel por instantes): espera e tenta de novo
            const st = e.response?.status;
            if ((st === 429 || (st >= 500 && st < 600)) && t < 5) { await new Promise(r => setTimeout(r, 1500 * (t + 1))); continue; }
            throw e;
        }
    }
}

async function resumo({ dias = 30, forcar = false } = {}) {
    dias = [7, 15, 30, 60, 90].includes(Number(dias)) ? Number(dias) : 30;
    let cache = null; try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch {}
    if (!forcar && cache && cache.dias === dias && Date.now() - new Date(cache.atualizado_em).getTime() < VALIDADE_MS) return cache;

    const { access_token } = await TokenManager.getToken();
    const headers = { Authorization: `Bearer ${access_token}` };
    const { advertisers = [] } = await get('https://api.mercadolibre.com/advertising/advertisers', headers, { product_id: 'PADS' });
    const anunciante = advertisers.find(a => a.site_id === 'MLB');
    if (!anunciante) throw new Error('Esta conta não tem anunciante de Product Ads.');
    const h = { ...headers, 'api-version': '2' };
    const base = `https://api.mercadolibre.com/advertising/MLB/advertisers/${anunciante.advertiser_id}/product_ads`;
    const ate = diaBR(Date.now() - 86400000);                 // ate ontem: o dia de hoje ainda esta aberto
    const de = diaBR(Date.now() - dias * 86400000);

    const campanhas = [];
    for (let off = 0; ; off += 50) {
        const d = await get(`${base}/campaigns/search`, h, { limit: 50, offset: off, date_from: de, date_to: ate, metrics: METRICAS });
        for (const c of d.results || []) {
            const m = c.metrics || {};
            const receita = r2(m.total_amount), gasto = r2(m.cost);
            campanhas.push({
                id: c.id, nome: c.name, status: c.status, estrategia: c.strategy, orcamento_dia: c.daily_budget ?? c.budget ?? null,
                acos_alvo: c.acos_target ?? null, roas_alvo: c.roas_target ?? null,
                gasto, receita, cliques: m.clicks || 0, impressoes: m.prints || 0, cpc: r2(m.cpc),
                vendas: m.units_quantity || 0, acos: receita ? r2(gasto / receita * 100) : null, roas: gasto ? r2(receita / gasto) : null,
            });
        }
        if (off + 50 >= (d.paging?.total || 0)) break;
    }

    // serie diaria dos ultimos 7 dias (todas as campanhas somadas)
    let serie = [];
    try {
        const d = await get(`${base}/campaigns/search`, h, { date_from: diaBR(Date.now() - 7 * 86400000), date_to: ate, metrics: 'cost,total_amount', aggregation_type: 'DAILY' });
        serie = (d.results || []).map(x => ({ dia: x.date, gasto: r2(x.cost), receita: r2(x.total_amount) })).sort((a, b) => a.dia.localeCompare(b.dia));
    } catch {}

    const gasto = r2(campanhas.reduce((s, c) => s + c.gasto, 0));
    const receita = r2(campanhas.reduce((s, c) => s + c.receita, 0));
    const r = {
        dias, de, ate, anunciante: anunciante.advertiser_name, atualizado_em: new Date().toISOString(),
        gasto, receita, acos: receita ? r2(gasto / receita * 100) : null, roas: gasto ? r2(receita / gasto) : null,
        conversoes: campanhas.reduce((s, c) => s + c.vendas, 0),
        total: campanhas.length, ativas: campanhas.filter(c => c.status === 'active').length,
        pausadas: campanhas.filter(c => c.status === 'paused').length,
        campanhas: campanhas.sort((a, b) => b.gasto - a.gasto), serie,
    };
    fs.mkdirSync(STORAGE, { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(r), 'utf8');
    return r;
}

module.exports = { resumo };
