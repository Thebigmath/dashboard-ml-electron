// Central de Promocoes (AD HEALTH > Campanhas e precos). So leitura: mostra as campanhas do ML,
// os anuncios candidatos e se entrar da lucro ou prejuizo. Entrar/sair continua manual.
//
// Mesma logica da skill "promocoes" (central_promocoes/engine.py), com uma diferenca: a margem
// aqui desconta tambem frete e imposto, igual ao precificador e ao queima-margem, para os
// numeros baterem no Dashboard inteiro.
//   margem = preco promocional - tarifa do ML - custo - imposto - frete
//
//   campanhas ............ GET /seller-promotions/users/{user}?app_version=v2
//   itens da campanha .... GET /seller-promotions/promotions/{id}/items?promotion_type=&search_after=
//   anuncio .............. GET /items?ids= (sku, categoria, tipo, frete gratis)
//   frete ................ GET /users/{user}/shipping_options/free?item_id= (guardado 24 h)
// Relampago (LIGHTNING) nao lista itens pela API: aparece so como campanha.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const P = require('./precificador');
const { mapaLimitado } = require('./paralelo');
const { ehEmpilhadeira } = require('./feed');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const CACHE = path.join(STORAGE, 'promocoes_central.json');
const CACHE_FRETE = path.join(STORAGE, 'promocoes_frete.json');
const VALIDADE_MS = 30 * 60 * 1000;
const MARGEM_MINIMA = 10;   // % abaixo disso: AVALIAR (vale por giro, nao por lucro)
const ML = 'https://api.mercadolibre.com';
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
const salvar = (arq, d) => { fs.mkdirSync(STORAGE, { recursive: true }); fs.writeFileSync(arq, JSON.stringify(d), 'utf8'); };

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

function classificar(l) {
    if (l.estado === 'started') {
        if (l.margem_pct != null && l.margem_pct < 0) return ['SAIR', 'Já está na campanha vendendo com margem negativa.'];
        return ['JA_PARTICIPA', 'Já está na campanha.'];
    }
    if (l.margem_pct == null) return ['SEM_DADOS', l.custo == null ? 'Sem custo na planilha: não dá para calcular a margem.' : 'Tarifa ou frete indisponível.'];
    if (l.margem_pct < 0) return ['NAO_ENTRAR', `Margem negativa (${l.margem_pct}%) no preço da campanha.`];
    if (l.margem_pct < MARGEM_MINIMA) return ['AVALIAR', `Margem de ${l.margem_pct}%, abaixo de ${MARGEM_MINIMA}%: vale por giro, não por lucro.`];
    if (l.ml_banca_pct) return ['ENTRAR', `Margem de ${l.margem_pct}% e o ML banca ${l.ml_banca_pct}% do desconto.`];
    return ['ENTRAR', `Margem de ${l.margem_pct}% no preço da campanha.`];
}

async function central({ forcar = false } = {}) {
    const cache = lerJson(CACHE, null);
    if (!forcar && cache && Date.now() - new Date(cache.atualizado_em).getTime() < VALIDADE_MS) return cache;

    const { headers, userId } = await P.auth();
    const impostoPct = Number(lerJson(path.join(STORAGE, 'config.json'), {}).imposto_pct ?? 7);
    const camps = ((await get(`${ML}/seller-promotions/users/${userId}`, headers, { app_version: 'v2' })).results || [])
        .filter(c => ['started', 'pending'].includes(c.status));

    // itens de cada campanha (menos relampago, que a API nao lista)
    const brutos = [];
    for (const c of camps) {
        c.qtd_itens = 0;
        // relampago nao lista itens; cupom nao tem preco promocional por item (fica so na lista de campanhas)
        if (c.type === 'LIGHTNING' || c.type === 'SELLER_COUPON_CAMPAIGN') continue;
        let cursor = null;
        for (let pag = 0; pag < 40; pag++) {
            let d;
            try { d = await get(`${ML}/seller-promotions/promotions/${c.id}/items`, headers, { promotion_type: c.type, app_version: 'v2', limit: 50, ...(cursor ? { search_after: cursor } : {}) }); }
            catch { break; }
            const lote = d.results || [];
            for (const it of lote) brutos.push({ it, c });
            c.qtd_itens += lote.length;
            cursor = d.paging?.searchAfter;
            if (!lote.length || !cursor) break;
        }
    }

    // detalhes dos anuncios (20 por chamada)
    const ids = [...new Set(brutos.map(b => b.it.id))];
    const det = {};
    for (let i = 0; i < ids.length; i += 20) {
        try {
            const d = await get(`${ML}/items`, headers, { ids: ids.slice(i, i + 20).join(','), attributes: 'id,title,price,seller_custom_field,category_id,listing_type_id,shipping,permalink,available_quantity,attributes,thumbnail' });
            for (const x of d) if (x.code === 200) det[x.body.id] = x.body;
        } catch {}
    }

    // frete que o vendedor paga, por anuncio (24 h)
    const fc = lerJson(CACHE_FRETE, { em: 0, mapa: {} });
    if (Date.now() - fc.em > 24 * 3600 * 1000) { fc.em = Date.now(); fc.mapa = {}; }
    await mapaLimitado(ids.filter(id => !(id in fc.mapa)), 5, async (id) => {
        try { fc.mapa[id] = (await get(`${ML}/users/${userId}/shipping_options/free`, headers, { item_id: id })).coverage?.all_country?.list_cost ?? null; }
        catch { fc.mapa[id] = null; }
    });
    salvar(CACHE_FRETE, fc);

    // tarifa por (preco, categoria, tipo), reaproveitada entre itens iguais
    const tarifas = new Map();
    const tarifa = async (preco, cat, tipo) => {
        const k = `${preco}|${cat}|${tipo}`;
        if (!tarifas.has(k)) tarifas.set(k, await P.tarifa(headers, preco, tipo, cat));
        return tarifas.get(k);
    };

    const linhas = [];
    await mapaLimitado(brutos, 5, async ({ it, c }) => {
        const d = det[it.id] || {};
        const sku = d.seller_custom_field || ((d.attributes || []).find(a => a.id === 'SELLER_SKU') || {}).value_name || '';
        if (ehEmpilhadeira({ sku, titulo: d.title || '' })) return;   // empilhadeiras ficam fora do AD HEALTH
        const custo = P.custoDoSku(sku);
        const original = Number(it.original_price || d.price || 0);
        const alvo = Number(it.suggested_discounted_price || it.price || 0) || null;
        const frete = fc.mapa[it.id] ?? null;
        const l = {
            item_id: it.id, titulo: d.title || '', sku, thumbnail: d.thumbnail, permalink: d.permalink, estoque: d.available_quantity ?? null,
            campanha_id: c.id, campanha: c.name || c.type, tipo: c.type, prazo_adesao: c.deadline_date || null, fim: c.finish_date || null,
            estado: it.status, preco_original: original || null, preco_promo: alvo,
            preco_min: it.min_discounted_price ?? null, preco_max: it.max_discounted_price ?? null,
            desconto_pct: original && alvo ? r2((1 - alvo / original) * 100) : null,
            ml_banca_pct: it.meli_percentage || null, nosso_pct: it.seller_percentage || null,
            custo: custo ? custo.valor : null, frete, margem: null, margem_pct: null, margem_hoje_pct: null,
        };
        if (alvo && custo && frete != null) {
            const t = await tarifa(alvo, d.category_id, d.listing_type_id);
            if (t) {
                const m = P.margem(alvo, frete, custo.valor, impostoPct, t.valor);
                l.margem = m.margem; l.margem_pct = m.margem_pct;
                const t0 = original ? await tarifa(original, d.category_id, d.listing_type_id) : null;
                if (t0) l.margem_hoje_pct = P.margem(original, frete, custo.valor, impostoPct, t0.valor).margem_pct;
            }
        }
        [l.recomendacao, l.motivo] = classificar(l);
        linhas.push(l);
    });

    // anuncios ativos sem nenhuma promocao no ar (base: coleta do Dashboard)
    const emPromo = new Set(linhas.filter(l => l.estado === 'started').map(l => l.item_id));
    const ativos = lerJson(path.join(STORAGE, 'reposicao.json'), []).filter(p => p.status === 'active' && p.item_id && !ehEmpilhadeira(p));
    const semPromo = ativos.filter(p => !emPromo.has(p.item_id)).map(p => ({ item_id: p.item_id, sku: p.sku, titulo: p.titulo, preco: p.preco, estoque: p.estoque, vendas30: p.vendas30 }));

    const r = {
        atualizado_em: new Date().toISOString(), margem_minima: MARGEM_MINIMA, imposto_pct: impostoPct,
        frentes: {
            subsidiadas: linhas.filter(l => l.recomendacao === 'ENTRAR' && l.ml_banca_pct).length,
            relampago: camps.filter(c => c.type === 'LIGHTNING').length,
            sem_promocao: semPromo.length,
            margem_negativa: linhas.filter(l => l.recomendacao === 'SAIR').length,
        },
        campanhas: camps.map(c => ({ id: c.id, nome: c.name || c.type, tipo: c.type, status: c.status, prazo_adesao: c.deadline_date || null, fim: c.finish_date || null,
            itens: c.qtd_itens, participando: linhas.filter(l => l.campanha_id === c.id && l.estado === 'started').length,
            entrar: linhas.filter(l => l.campanha_id === c.id && l.recomendacao === 'ENTRAR').length })),
        itens: linhas.sort((a, b) => (b.ml_banca_pct || 0) - (a.ml_banca_pct || 0) || (b.margem_pct ?? -999) - (a.margem_pct ?? -999)),
        sem_promocao: semPromo.sort((a, b) => (b.vendas30 || 0) - (a.vendas30 || 0)),
    };
    salvar(CACHE, r);
    return r;
}

module.exports = { central, MARGEM_MINIMA };
