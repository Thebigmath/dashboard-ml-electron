// Controle de estoque parado (AD HEALTH): quanto dinheiro esta parado em cada anuncio e ha
// quanto tempo o estoque levaria para acabar no ritmo atual, com as etiquetas de ADS e promocao.
//
// Base: reposicao.json, SO anuncios do Full (estoque, vendas 30 d, preco) + custos.json (planilha de custos).
// Etiquetas: API de Publicidade (campanha de ADS de cada anuncio) e seller-promotions (promocao
// ativa). As duas ficam guardadas por 6 h: sao centenas de chamadas e mudam pouco no dia.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const TokenManager = require('./tokenManager');
const { mapaLimitado } = require('./paralelo');
const { ehEmpilhadeira } = require('./feed');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const CACHE_ADS = path.join(STORAGE, 'parado_ads.json');
const CACHE_PROMO = path.join(STORAGE, 'parado_promocoes.json');
const VALIDADE_MS = 6 * 3600 * 1000;
const TOP = 100;

function lerJson(arq, padrao) { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return padrao; } }
function salvar(arq, d) { fs.mkdirSync(STORAGE, { recursive: true }); fs.writeFileSync(arq, JSON.stringify(d), 'utf8'); }
const fresco = (c) => c && c.em && Date.now() - new Date(c.em).getTime() < VALIDADE_MS;

// custo pela planilha: SKU exato, sem sufixo (-par, -esq...), sem zeros a esquerda (igual ao precificador)
function custoDoSku(custos, sku) {
    if (!sku) return null;
    const s = String(sku).trim();
    for (const k of [s, s.toLowerCase(), s.toUpperCase(), s.split(/[-_\s]/)[0], s.replace(/^0+/, '')])
        if (custos[k] != null && !isNaN(Number(custos[k]))) return Number(custos[k]);
    return null;
}

async function get(url, headers, params) {
    for (let t = 0; ; t++) {
        try { return (await axios.get(url, { headers, params, timeout: 20000 })).data; }
        catch (e) {
            // 429 (limite) e 5xx (ML instavel por instantes): espera e tenta de novo
            const st = e.response?.status;
            if ((st === 429 || (st >= 500 && st < 600)) && t < 5) { await new Promise(r => setTimeout(r, 1500 * (t + 1))); continue; }
            throw e;
        }
    }
}

// item_id -> nome da campanha de ADS (so anuncios ativos no ADS)
async function etiquetasAds(headers) {
    const c = lerJson(CACHE_ADS, null);
    if (fresco(c)) return c.mapa;
    const h = { ...headers, 'api-version': '2' };
    const { advertisers = [] } = await get('https://api.mercadolibre.com/advertising/advertisers', headers, { product_id: 'PADS' });
    const mapa = {};
    for (const a of advertisers.filter(x => x.site_id === 'MLB')) {
        const base = `https://api.mercadolibre.com/advertising/MLB/advertisers/${a.advertiser_id}/product_ads`;
        const nomes = {};
        for (let off = 0; ; off += 50) {
            const d = await get(`${base}/campaigns/search`, h, { limit: 50, offset: off });
            for (const k of d.results || []) nomes[k.id] = k.name;
            if (off + 50 >= (d.paging?.total || 0)) break;
        }
        for (let off = 0; ; off += 50) {
            const d = await get(`${base}/ads/search`, h, { limit: 50, offset: off });
            for (const ad of d.results || []) if (ad.status === 'active' && ad.campaign_id) mapa[ad.item_id] = nomes[ad.campaign_id] || `campanha ${ad.campaign_id}`;
            if (off + 50 >= (d.paging?.total || 0)) break;
        }
    }
    salvar(CACHE_ADS, { em: new Date().toISOString(), mapa });
    return mapa;
}

const NOME_PROMO = {
    PRICE_DISCOUNT: 'Desconto Direto', DEAL: 'Campanha', LIGHTNING: 'Oferta Relâmpago', DOD: 'Oferta do Dia',
    MARKETPLACE_CAMPAIGN: 'Campanha ML', SMART: 'Campanha automática', PRICE_MATCHING: 'Preço competitivo',
    UNHEALTHY_STOCK: 'Liquidação Full', PRE_NEGOTIATED: 'Desconto negociado', SELLER_CAMPAIGN: 'Campanha do vendedor', VOLUME: 'Desconto por quantidade',
};

// promocao ATIVA de cada item pedido (candidata nao conta: ainda nao esta no ar)
async function etiquetasPromo(headers, itens) {
    const c = lerJson(CACHE_PROMO, null);
    const mapa = fresco(c) ? { ...c.mapa } : {};
    const faltam = itens.filter(id => !(id in mapa));
    await mapaLimitado(faltam, 5, async (id) => {
        try {
            const lista = await get(`https://api.mercadolibre.com/seller-promotions/items/${id}`, headers, { app_version: 'v2' });
            const ativa = (Array.isArray(lista) ? lista : []).find(p => p.status === 'started');
            mapa[id] = ativa ? (ativa.name || NOME_PROMO[ativa.type] || ativa.type) : null;
        } catch { mapa[id] = null; }
    });
    salvar(CACHE_PROMO, { em: fresco(c) ? c.em : new Date().toISOString(), mapa });
    return mapa;
}

async function controle({ minDias = 60 } = {}) {
    minDias = Math.max(1, Number(minDias) || 60);
    const base = lerJson(path.join(STORAGE, 'reposicao.json'), []);
    const custos = lerJson(path.join(STORAGE, 'custos.json'), {});
    const linhas = base
        .filter(p => p.item_id && p.status === 'active' && p.eFull && Number(p.estoque) > 0 && !ehEmpilhadeira(p))   // so o Full (decisao de 07/10/2026)
        .map(p => {
            const vendas30 = Number(p.vendas30) || 0;
            const media = vendas30 / 30;
            const dias = media > 0 ? Number(p.estoque) / media : null;   // null = nao vendeu em 30 dias
            const preco = Number(p.preco) || 0;
            return {
                item_id: p.item_id, sku: p.sku, titulo: p.titulo, permalink: p.permalink, full: !!p.eFull,
                estoque: Number(p.estoque), vendas30, dias: dias == null ? null : Math.round(dias),
                preco, custo: custoDoSku(custos, p.sku), potencial: +(Number(p.estoque) * preco).toFixed(2),
            };
        })
        .filter(l => l.dias == null || l.dias >= minDias);

    const top = [...linhas].sort((a, b) => b.potencial - a.potencial).slice(0, TOP);
    const avisos = [];
    try {
        const { access_token } = await TokenManager.getToken();
        const headers = { Authorization: `Bearer ${access_token}` };
        let ads = {}, promo = {};
        try { ads = await etiquetasAds(headers); } catch (e) { avisos.push('ADS: ' + (e.response?.status || e.message)); }
        try { promo = await etiquetasPromo(headers, top.map(l => l.item_id)); } catch (e) { avisos.push('Promoções: ' + (e.response?.status || e.message)); }
        for (const l of top) { l.ads = ads[l.item_id] || null; l.promocao = promo[l.item_id] || null; }
    } catch (e) { avisos.push('Sem token do ML: ' + e.message); }

    return {
        min_dias: minDias,
        potencial: +linhas.reduce((s, l) => s + l.potencial, 0).toFixed(2),
        produtos: linhas.length,
        unidades: linhas.reduce((s, l) => s + l.estoque, 0),
        sem_venda: linhas.filter(l => l.dias == null).length,
        coletado_em: (() => { try { return fs.statSync(path.join(STORAGE, 'reposicao.json')).mtime.toISOString(); } catch { return null; } })(),
        avisos, itens: top,
    };
}

module.exports = { controle };
