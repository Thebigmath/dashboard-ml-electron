// Analise de vendas (AD HEALTH), no formato do relatorio de vendas do Mercado Turbo: a MC% REAL de cada venda.
//   base ............ valor unitario x quantidade - cupom do vendedor
//   faturamento ML .. base + frete pago pelo comprador (so passa pela venda)
//   imposto ......... imposto_pct (config, padrao 7% — informado pelo usuario em 13/10/2026) da base
//   tarifa .......... sale_fee cobrado pelo ML na venda x quantidade
//   frete vendedor .. o que o vendedor pagou no envio (shipments/{id}/costs -> senders)
//   MC = base - custo x quantidade - imposto - tarifa - frete vendedor;  MC% = MC / (valor x quantidade), como o MT
// Conferido com o MT em 13/10/2026 (010TB: 306,80 → MC 46,00 = 14,99%; cupom e frete do comprador iguais).
// Pedidos cancelados ficam de fora. Envio e custo do envio guardados em cache (nao mudam depois da venda).
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const P = require('./precificador');
const { mapaLimitado } = require('./paralelo');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const CACHE_ENVIO = path.join(STORAGE, 'vendas_mc_envios.json');
const ML = 'https://api.mercadolibre.com';
const MC_ALVO = 15;
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
const diaBR = (ms) => new Date(ms - 3 * 3600 * 1000).toISOString().slice(0, 10);
const LOGISTICA = { fulfillment: 'Full', self_service: 'Flex', cross_docking: 'ME2', xd_drop_off: 'ME2', drop_off: 'ME2', default: 'ME2' };

async function get(url, headers, params) {
    for (let t = 0; ; t++) {
        try { return (await axios.get(url, { headers, params, timeout: 30000 })).data; }
        catch (e) {
            const st = e.response?.status;
            if ((st === 429 || (st >= 500 && st < 600)) && t < 5) { await new Promise(r => setTimeout(r, 1500 * (t + 1))); continue; }
            throw e;
        }
    }
}

// periodo: 'hoje' | 'ontem' | numero de dias (7, 15, 30) terminando hoje
function intervalo(periodo) {
    const hoje = diaBR(Date.now());
    if (periodo === 'hoje') return { de: hoje, ate: hoje };
    if (periodo === 'ontem' || !periodo) { const o = diaBR(Date.now() - 86400000); return { de: o, ate: o }; }
    const n = Math.max(1, Math.min(60, Number(periodo) || 7));
    return { de: diaBR(Date.now() - (n - 1) * 86400000), ate: hoje };
}

async function analisar({ periodo = 'ontem' } = {}) {
    const { de, ate } = intervalo(periodo);
    const { headers, userId } = await P.auth();
    const impostoPct = Number(lerJson(path.join(STORAGE, 'config.json'), {}).imposto_pct ?? 7);

    // pedidos do periodo
    const pedidos = [];
    for (let off = 0; off < 5000; off += 50) {
        const d = await get(`${ML}/orders/search`, headers, { seller: userId, limit: 50, offset: off, sort: 'date_desc',
            'order.date_created.from': `${de}T00:00:00.000-03:00`, 'order.date_created.to': `${ate}T23:59:59.999-03:00` });
        pedidos.push(...(d.results || []));
        if (off + 50 >= (d.paging?.total || 0)) break;
    }
    const validos = pedidos.filter(o => o.status !== 'cancelled');

    // envio: tipo de logistica e custos (cache)
    const cache = lerJson(CACHE_ENVIO, {});
    const envios = [...new Set(validos.map(o => o.shipping?.id).filter(Boolean))].filter(id => !cache[id]);
    await mapaLimitado(envios, 5, async (id) => {
        try {
            const [s, k] = await Promise.all([get(`${ML}/shipments/${id}`, headers), get(`${ML}/shipments/${id}/costs`, headers)]);
            cache[id] = { logistica: s.logistic_type || '', comprador: Number(k.receiver?.cost) || 0,
                vendedor: (k.senders || []).filter(x => !x.user_id || String(x.user_id) === String(userId)).reduce((t, x) => t + (Number(x.cost) || 0), 0) };
        } catch { /* sem custo de envio: fica de fora do cache e e tentado na proxima */ }
    });
    fs.mkdirSync(STORAGE, { recursive: true });
    fs.writeFileSync(CACHE_ENVIO, JSON.stringify(cache), 'utf8');

    // uma linha por item vendido (pedido com varios itens: frete e cupom repartidos pelo valor)
    const vendas = [];
    for (const o of validos) {
        const itens = o.order_items || [];
        const totalItens = itens.reduce((t, i) => t + Number(i.unit_price) * Number(i.quantity), 0) || 1;
        const env = cache[o.shipping?.id] || null;
        const cupom = Number(o.coupon?.amount) || 0;
        for (const i of itens) {
            const qtd = Number(i.quantity) || 1, valor = Number(i.unit_price) || 0, parte = (valor * qtd) / totalItens;
            const sku = i.item?.seller_sku || i.item?.seller_custom_field || '';
            const custoUn = P.custoDoSku(sku);
            const base = r2(valor * qtd - cupom * parte);
            const freteC = env ? r2(env.comprador * parte) : null, freteV = env ? r2(env.vendedor * parte) : null;
            const tarifa = r2((Number(i.sale_fee) || 0) * qtd);
            const imposto = r2(base * impostoPct / 100);
            const custo = custoUn ? r2(custoUn.valor * qtd) : null;
            // custo da planilha maior que 1,5x o preco de venda: quase sempre erro de digitacao (ex.: 3800 no lugar de 38,00)
            const custoSuspeito = !!(custoUn && valor && custoUn.valor > valor * 1.5);
            const mc = custo != null && freteV != null ? r2(base - custo - imposto - tarifa - freteV) : null;
            vendas.push({ pedido: String(o.id), data: o.date_created, item_id: i.item?.id, titulo: i.item?.title || '', sku,
                logistica: env ? (LOGISTICA[env.logistica] || env.logistica || '—') : '—', valor, qtd, cupom: r2(cupom * parte),
                faturamento: freteC != null ? r2(base + freteC) : base, base, custo, imposto, tarifa, frete_comprador: freteC, frete_vendedor: freteV,
                bruto: r2(valor * qtd), mc, mc_pct: mc != null && valor ? r2(mc / (valor * qtd) * 100) : null,
                custo_suspeito: custoSuspeito, frete_alto: freteV != null && valor ? freteV > valor * qtd * 0.3 : false });
        }
    }
    vendas.sort((a, b) => String(b.data).localeCompare(String(a.data)));

    // por anuncio: os que mais venderam primeiro, com a MC% ponderada pelo faturamento
    const grupos = {};
    for (const v of vendas) (grupos[v.item_id] ||= []).push(v);
    const coleta = new Map(lerJson(path.join(STORAGE, 'reposicao.json'), []).map(r => [r.item_id, r]));
    const anuncios = Object.entries(grupos).map(([id, L]) => {
        const comMc = L.filter(v => v.mc != null && !v.custo_suspeito);
        const base = comMc.reduce((t, v) => t + v.bruto, 0), mc = comMc.reduce((t, v) => t + v.mc, 0);
        return { item_id: id, titulo: L[0].titulo, sku: L[0].sku, logistica: L[0].logistica, unidades: L.reduce((t, v) => t + v.qtd, 0), vendas: L.length,
            faturamento: r2(L.reduce((t, v) => t + v.faturamento, 0)), mc: r2(mc), mc_pct: base ? r2(mc / base * 100) : null,
            sem_dado: L.length - comMc.length, preco_atual: (coleta.get(id) || {}).preco ?? null,
            abaixo_alvo: base ? (mc / base * 100) < MC_ALVO : false };
    }).sort((a, b) => b.unidades - a.unidades || b.faturamento - a.faturamento);

    const comMc = vendas.filter(v => v.mc != null && !v.custo_suspeito);   // custo suspeito fica fora da media
    const baseT = comMc.reduce((t, v) => t + v.bruto, 0), mcT = comMc.reduce((t, v) => t + v.mc, 0);
    // anuncios com o preco mudado nos ultimos 3 dias (pelo Precificar ou pelo motor): saem da lista ate a observacao terminar
    const alterados = {};
    for (const h of P.historico(undefined, 1000)) {
        if (h.item_id && h.quando && Date.now() - new Date(h.quando).getTime() < 3 * 86400000 && !alterados[h.item_id])
            alterados[h.item_id] = { quando: h.quando, antes: h.antes, depois: h.depois };
    }
    // preco mudado POR FORA do SEVEN (site do ML, Mercado Turbo...): o ML diz quando o preco padrao mudou
    // (/items/{id}/prices -> last_updated). Mudou depois da ultima venda do anuncio no periodo = ja foi atualizado.
    const ultimaVenda = {};
    for (const v of vendas) if (!ultimaVenda[v.item_id] || v.data > ultimaVenda[v.item_id]) ultimaVenda[v.item_id] = v.data;
    await mapaLimitado(Object.keys(ultimaVenda).filter(id => !alterados[id]), 5, async (id) => {
        try {
            const pr = ((await get(`${ML}/items/${id}/prices`, headers)).prices || []).find(x => x.type === 'standard');
            if (pr && pr.last_updated && new Date(pr.last_updated) > new Date(ultimaVenda[id])) {
                const venda = vendas.find(v => v.item_id === id && v.data === ultimaVenda[id]);
                alterados[id] = { quando: pr.last_updated, antes: venda ? venda.valor : null, depois: pr.amount, fora: true };
            }
        } catch { /* sem o historico de preco: fica na lista */ }
    });
    return {
        periodo, de, ate, atualizado_em: new Date().toISOString(), mc_alvo: MC_ALVO, imposto_pct: impostoPct, alterados,
        resumo: { pedidos: validos.length, cancelados: pedidos.length - validos.length, unidades: vendas.reduce((t, v) => t + v.qtd, 0),
            faturamento: r2(vendas.reduce((t, v) => t + v.faturamento, 0)), mc: r2(mcT), mc_pct: baseT ? r2(mcT / baseT * 100) : null,
            anuncios: anuncios.length, abaixo_alvo: anuncios.filter(a => a.abaixo_alvo).length,
            sem_custo: vendas.filter(v => v.custo == null).length, custo_suspeito: vendas.filter(v => v.custo_suspeito).length,
            frete_alto: vendas.filter(v => v.frete_alto).length },
        vendas, anuncios,
    };
}

module.exports = { analisar, MC_ALVO };
