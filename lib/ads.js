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
const METRICAS = 'clicks,prints,cost,cpc,ctr,cvr,acos,roas,direct_amount,indirect_amount,total_amount,units_quantity,direct_units_quantity,organic_units_quantity';
// indicadores de funil: CTR = cliques / impressoes · impressoes por clique · CPC · conversao = vendas / cliques · custo por venda
const funil = (impressoes, cliques, gasto, vendas) => ({
    ctr: impressoes ? r2(cliques / impressoes * 100) : null, imp_por_clique: cliques ? Math.round(impressoes / cliques) : null,
    cpc: cliques ? r2(gasto / cliques) : null, conversao: cliques ? r2(vendas / cliques * 100) : null, custo_por_venda: vendas ? r2(gasto / vendas) : null });
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
                ...funil(m.prints || 0, m.clicks || 0, gasto, m.units_quantity || 0),
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
        impressoes: campanhas.reduce((s, c) => s + c.impressoes, 0), cliques: campanhas.reduce((s, c) => s + c.cliques, 0),
        ...funil(campanhas.reduce((s, c) => s + c.impressoes, 0), campanhas.reduce((s, c) => s + c.cliques, 0), gasto, campanhas.reduce((s, c) => s + c.vendas, 0)),
        total: campanhas.length, ativas: campanhas.filter(c => c.status === 'active').length,
        pausadas: campanhas.filter(c => c.status === 'paused').length,
        campanhas: campanhas.sort((a, b) => b.gasto - a.gasto), serie,
    };
    fs.mkdirSync(STORAGE, { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(r), 'utf8');
    return r;
}

// ---- Detalhe de uma campanha: funil por dia e por anuncio ----
async function cabecalhos() {
    const { access_token } = await TokenManager.getToken();
    const headers = { Authorization: `Bearer ${access_token}` };
    const { advertisers = [] } = await get('https://api.mercadolibre.com/advertising/advertisers', headers, { product_id: 'PADS' });
    const an = advertisers.find(a => a.site_id === 'MLB');
    if (!an) throw new Error('Esta conta não tem anunciante de Product Ads.');
    return { h: { ...headers, 'api-version': '2' }, base: `https://api.mercadolibre.com/advertising/MLB/advertisers/${an.advertiser_id}/product_ads` };
}
async function detalhe(campanhaId, dias = 30) {
    dias = [7, 15, 30, 60, 90].includes(Number(dias)) ? Number(dias) : 30;
    const { h, base } = await cabecalhos();
    const ate = diaBR(Date.now() - 86400000), de = diaBR(Date.now() - dias * 86400000);
    const filtro = { 'filters[campaign_id]': campanhaId };
    const c = ((await get(`${base}/campaigns/search`, h, { limit: 1, date_from: de, date_to: ate, metrics: METRICAS, ...filtro })).results || [])[0];
    if (!c) throw new Error('Campanha não encontrada.');
    const m = c.metrics || {};
    const camp = { id: c.id, nome: c.name, status: c.status, estrategia: c.strategy, orcamento_dia: c.daily_budget ?? c.budget ?? null, acos_alvo: c.acos_target ?? null,
        impressoes: m.prints || 0, cliques: m.clicks || 0, gasto: r2(m.cost), receita: r2(m.total_amount), vendas: m.units_quantity || 0,
        acos: m.total_amount ? r2(m.cost / m.total_amount * 100) : null, roas: m.cost ? r2(m.total_amount / m.cost) : null, ...funil(m.prints || 0, m.clicks || 0, r2(m.cost), m.units_quantity || 0) };
    let serie = [];
    try {
        const d = await get(`${base}/campaigns/search`, h, { date_from: de, date_to: ate, metrics: 'clicks,prints,cost,units_quantity,total_amount', aggregation_type: 'DAILY', ...filtro });
        serie = (d.results || []).map(x => ({ dia: x.date, impressoes: x.prints || 0, cliques: x.clicks || 0, gasto: r2(x.cost), vendas: x.units_quantity || 0, receita: r2(x.total_amount),
            ...funil(x.prints || 0, x.clicks || 0, r2(x.cost), x.units_quantity || 0) })).sort((a, b) => a.dia.localeCompare(b.dia));
    } catch {}
    const anuncios = [];
    for (let off = 0; off < 2000; off += 50) {
        const d = await get(`${base}/ads/search`, h, { limit: 50, offset: off, date_from: de, date_to: ate, metrics: METRICAS, ...filtro });
        for (const a of d.results || []) {
            const x = a.metrics || {}, gasto = r2(x.cost), receita = r2(x.total_amount);
            anuncios.push({ item_id: a.item_id, titulo: a.title, status: a.status, preco: a.price, tipo: a.listing_type_id, thumbnail: a.thumbnail,
                impressoes: x.prints || 0, cliques: x.clicks || 0, gasto, receita, vendas: x.units_quantity || 0,
                acos: receita ? r2(gasto / receita * 100) : null, ...funil(x.prints || 0, x.clicks || 0, gasto, x.units_quantity || 0) });
        }
        if (off + 50 >= (d.paging?.total || 0)) break;
    }
    // sinais por anuncio, comparados com a media da campanha
    for (const a of anuncios) {
        a.sinais = [];
        if (a.gasto >= Math.max(20, camp.custo_por_venda || 0) && !a.vendas) a.sinais.push('gasta sem vender');
        if (a.impressoes >= 1000 && camp.ctr && a.ctr != null && a.ctr < camp.ctr * 0.5) a.sinais.push('CTR baixo');
        if (a.cliques >= 30 && camp.conversao && a.conversao != null && a.conversao < camp.conversao * 0.5) a.sinais.push('conversão baixa');
        if (camp.cpc && a.cpc != null && a.cliques >= 20 && a.cpc > camp.cpc * 1.5) a.sinais.push('CPC alto');
        if (a.vendas >= 2 && camp.conversao && a.conversao >= camp.conversao * 1.5) a.sinais.push('converte bem');
    }
    anuncios.sort((a, b) => b.gasto - a.gasto);
    return { dias, de, ate, atualizado_em: new Date().toISOString(), campanha: camp, serie, anuncios };
}

// Analise da IA sobre o funil da campanha (Gemini, 40 s no maximo)
const SISTEMA_ADS = `Você é especialista em Product Ads do Mercado Livre de uma loja de autopeças.
Analise o funil da campanha: impressões -> cliques (CTR e impressões por clique) -> vendas (conversão), e o custo (CPC, custo por venda, ACoS, ROAS).
Diga o que está bom, o que está ruim e o que fazer, de forma curta e prática, citando números e anúncios.
CTR baixo = foto, título ou preço chamam pouca atenção na busca. Conversão baixa = o anúncio atrai clique mas não convence (preço, frete, avaliações, ficha técnica).
Responda SÓ em JSON: {"resumo":"2-3 frases","ctr":"1 frase","cpc":"1 frase","conversao":"1 frase","acoes":["..."],"anuncios":[{"item_id":"...","problema":"...","acao":"..."}]}`;
async function analisarIA(campanhaId, dias = 30) {
    const d = await detalhe(campanhaId, dias);
    const ia = require('./ia');
    const top = d.anuncios.filter(a => a.impressoes > 0).slice(0, 20).map(a => ({ item_id: a.item_id, titulo: a.titulo.slice(0, 60), preco: a.preco, impressoes: a.impressoes, cliques: a.cliques, ctr: a.ctr,
        imp_por_clique: a.imp_por_clique, cpc: a.cpc, vendas: a.vendas, conversao: a.conversao, gasto: a.gasto, receita: a.receita, acos: a.acos, sinais: a.sinais }));
    const prompt = `Campanha (${d.dias} dias, ${d.de} a ${d.ate}): ${JSON.stringify(d.campanha)}\nPor dia: ${JSON.stringify(d.serie.map(x => ({ dia: x.dia, ctr: x.ctr, cpc: x.cpc, conversao: x.conversao, vendas: x.vendas, gasto: x.gasto })))}\nAnúncios (os que mais gastam): ${JSON.stringify(top)}`;
    const g = await Promise.race([ia.gerarGemini(SISTEMA_ADS, prompt, 3000, 'gemini-3.1-flash-lite', { json: true }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('a IA demorou mais de 40 s')), 40000))]);
    const j = JSON.parse(String(g.texto).replace(/^```(json)?|```$/g, '').trim());
    return { ...j, modelo: g.modelo, analisado_em: new Date().toISOString() };
}

module.exports = { resumo, detalhe, analisarIA };
