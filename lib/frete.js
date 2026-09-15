// Monitor do frete que o VENDEDOR paga no Mercado Livre — porte do
// bot_precos/frete_monitor.py e frete_pedidos.py (README_FRETE.md) para dentro
// do app, com aviso na área de notificações do Windows em vez do Telegram.
//
// Dois ângulos do mesmo custo:
//   tabela — /users/{id}/shipping_options/free?item_id= : quanto o ML vai
//            cobrar de nós pelo frete grátis de cada anúncio ativo, hoje.
//            A API não guarda histórico: um snapshot por verificação, e a
//            diferença para o anterior é o alerta.
//   vendas — /shipments/{id} + /shipments/{id}/costs : quanto o ML cobrou de
//            nós em cada envio já feito (senders[0].cost; o receiver é o
//            comprador e é ignorado). Histórico incremental; a última venda
//            de cada anúncio é comparada com a anterior — só vendas "limpas"
//            (1 item no pedido, 1 unidade, mesma logística) para não confundir
//            pedido grande com mudança de frete.
//
// Arquivos (STORAGE):
//   frete_tabela.json    último snapshot da tabela (baseline da próxima)
//   frete_mudancas.json  log acumulado do que mudou, mais recente primeiro
//   frete_vendas.json    { linhas, notificados, verificado_em }
//   frete_config.json    { avisar_tabela, avisar_diferenca, avisar_vendas, horas_tabela }
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const TokenManager = require('./tokenManager');
const { mapaLimitado, comBackoff, paginarEmParalelo } = require('./paralelo');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ML = 'https://api.mercadolibre.com';

const CAMPOS_MONITORADOS = ['list_cost', 'billable_weight', 'free_shipping', 'logistic_type'];
const DIAS_PRIMEIRA_CARGA = 30;
const DIAS_SOBREPOSICAO = 3;      // relê os últimos dias: pedido pode ter ganhado envio depois
const MAX_MUDANCAS = 2000;
const MAX_LINHAS_VENDAS = 20000;
const PRIMEIRA_RODADA_MS = 90 * 1000;
const INTERVALO_MS = 60 * 60 * 1000;

const CONFIG_PADRAO = { avisar_tabela: true, avisar_diferenca: true, avisar_vendas: false, horas_tabela: 12 };

function lerJson(file, def) {
    const p = path.join(STORAGE, file);
    if (!fs.existsSync(p)) return def;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; }
}
function salvarJson(file, data) {
    fs.writeFileSync(path.join(STORAGE, file), JSON.stringify(data, null, 1), 'utf8');
}

const { notificar, usarNotificador } = require('./notificar');

const estado = { rodando: false, fase: '', iniciado_em: null, ultimo_erro: null, motorOcupado: false };
let timerPrimeira = null, timerIntervalo = null;

const brl = (v) => v == null ? '?' : 'R$ ' + Number(v).toFixed(2).replace('.', ',');
const fmtValor = (campo, v) => {
    if (v == null) return '?';
    if (campo === 'list_cost') return brl(v);
    if (campo === 'billable_weight') return v + ' g';
    if (campo === 'free_shipping') return v ? 'grátis' : 'pago';
    return String(v);
};
const dataBr = (iso) => iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) : '';

function configuracao() {
    return { ...CONFIG_PADRAO, ...lerJson('frete_config.json', {}) };
}
function salvarConfiguracao(parcial) {
    const nova = { ...configuracao() };
    for (const k of Object.keys(CONFIG_PADRAO)) {
        if (parcial[k] === undefined) continue;
        nova[k] = k === 'horas_tabela' ? Math.max(1, Number(parcial[k]) || CONFIG_PADRAO.horas_tabela) : !!parcial[k];
    }
    salvarJson('frete_config.json', nova);
    return nova;
}

// ── Tabela por anúncio ──────────────────────────────────────────────────────
async function coletarTabela(headers, userId, tentar) {
    estado.fase = 'listando anúncios ativos';
    const ids = [];
    let scrollId = null;
    do {
        const params = { search_type: 'scan', limit: 100, status: 'active' };
        if (scrollId) params.scroll_id = scrollId;
        const { data } = await tentar(() => axios.get(`${ML}/users/${userId}/items/search`, { headers, params }));
        const res = data.results || [];
        if (!res.length) break;
        ids.push(...res);
        scrollId = data.scroll_id;
    } while (scrollId);

    estado.fase = `detalhes de ${ids.length} anúncios`;
    const lotes = [];
    for (let i = 0; i < ids.length; i += 20) lotes.push(ids.slice(i, i + 20));
    const itens = {};
    await mapaLimitado(lotes, 12, async (lote) => {
        let data;
        try {
            ({ data } = await tentar(() => axios.get(`${ML}/items`, {
                headers, params: { ids: lote.join(','), attributes: 'id,title,price,status,shipping,seller_custom_field' },
            })));
        } catch (e) {
            console.error('[FRETE] lote de detalhes falhou: ' + (e.message || '').slice(0, 80));
            return; // o lote fica de fora desta rodada; volta na próxima
        }
        for (const e of data || []) {
            const b = e.body || {};
            if (!b.id || b.status !== 'active') continue;
            const s = b.shipping || {};
            itens[b.id] = {
                item_id: b.id, title: b.title || '', sku: b.seller_custom_field || '', price: b.price ?? null,
                status: b.status, free_shipping: s.free_shipping ?? null, logistic_type: s.logistic_type ?? null,
                list_cost: null, billable_weight: null,
            };
        }
    });

    const lista = Object.values(itens);
    let prontos = 0;
    await mapaLimitado(lista, 10, async (it) => {
        try {
            const { data } = await tentar(() => axios.get(`${ML}/users/${userId}/shipping_options/free`, { headers, params: { item_id: it.item_id } }));
            const cov = (data.coverage || {}).all_country || {};
            it.list_cost = cov.list_cost ?? null;
            it.billable_weight = cov.billable_weight ?? null;
        } catch (e) {
            it.erro = String(e.response?.data?.message || e.message || '').slice(0, 120);
        }
        prontos++;
        if (prontos % 25 === 0 || prontos === lista.length) estado.fase = `frete de ${prontos}/${lista.length} anúncios`;
    });
    return itens;
}

function compararTabela(antes, agora) {
    const mudancas = [];
    for (const [itemId, novo] of Object.entries(agora)) {
        const velho = antes[itemId];
        if (!velho || novo.list_cost == null || velho.list_cost == null) continue;
        const diffs = {};
        for (const c of CAMPOS_MONITORADOS) if (velho[c] !== novo[c]) diffs[c] = { antes: velho[c], depois: novo[c] };
        if (Object.keys(diffs).length) {
            mudancas.push({ item_id: itemId, title: novo.title, sku: novo.sku, price: novo.price, mudancas: diffs });
        }
    }
    const novos = Object.keys(agora).filter(i => !antes[i]);
    const sumidos = Object.keys(antes).filter(i => !agora[i]);
    return { mudancas, novos, sumidos };
}

// ── Custo por venda ─────────────────────────────────────────────────────────
async function buscarFreteEnvio(headers, shipmentId, tentar) {
    try {
        const [{ data: ship }, { data: costs }] = await Promise.all([
            tentar(() => axios.get(`${ML}/shipments/${shipmentId}`, { headers })),
            tentar(() => axios.get(`${ML}/shipments/${shipmentId}/costs`, { headers })),
        ]);
        const sender = (costs.senders || [])[0] || {};
        const receiver = costs.receiver || {};
        const addr = ship.receiver_address || {};
        const descVendedor = (sender.discounts || []).reduce((s, d) => s + (d.promoted_amount || 0), 0);
        return {
            shipment_id: String(shipmentId),
            shipment_status: ship.status ?? null,
            logistic_type: ship.logistic_type ?? null,
            uf_destino: String((addr.state || {}).id || '').replace('BR-', ''),
            cidade_destino: (addr.city || {}).name || '',
            tabela_cheia: costs.gross_amount ?? null,
            desconto_vendedor: Math.round(descVendedor * 100) / 100,
            custo_vendedor: sender.cost ?? null,
            flex: (sender.charges || {}).charge_flex || 0,
            comprador_pagou: receiver.cost ?? null,
        };
    } catch {
        return null; // ML ainda não calculou, ou envio não resolve nessa rota
    }
}

async function coletarVendas(headers, userId, tentar, historico) {
    const ja = new Set(historico.map(l => l.order_id + '|' + l.item_id));
    let de;
    if (historico.length) {
        const ultima = historico.reduce((m, l) => l.date > m ? l.date : m, '');
        de = new Date(new Date(ultima.slice(0, 10)).getTime() - DIAS_SOBREPOSICAO * 86400000);
    } else {
        de = new Date(Date.now() - DIAS_PRIMEIRA_CARGA * 86400000);
    }
    estado.fase = 'pedidos desde ' + de.toISOString().slice(0, 10);
    const { itens: pedidos } = await paginarEmParalelo({
        limite: 50, concorrencia: 6,
        // paginarEmParalelo já aplica o backoff em cada página
        buscarPagina: (offset) => axios.get(`${ML}/orders/search`, {
            headers, params: { seller: userId, 'order.date_created.from': de.toISOString(), 'order.date_created.to': new Date().toISOString(), limit: 50, offset },
        }).then(r => r.data),
        extrair: (data) => data.results || [],
    });

    // Envios pendentes: só os de pedidos com item ainda fora do histórico.
    const porEnvio = new Map();
    for (const od of pedidos) {
        if (od.status === 'cancelled') continue;
        const shipId = (od.shipping || {}).id;
        if (!shipId) continue;
        const orderId = String(od.id);
        const itensPedido = od.order_items || [];
        const pendentes = itensPedido.filter(oi => !ja.has(orderId + '|' + (oi.item || {}).id));
        if (!pendentes.length) continue;
        if (!porEnvio.has(shipId)) porEnvio.set(shipId, []);
        porEnvio.get(shipId).push({ od, orderId, itensPedido, pendentes });
    }

    const envios = [...porEnvio.keys()];
    estado.fase = `custo de ${envios.length} envios novos`;
    const linhas = [];
    let prontos = 0;
    await mapaLimitado(envios, 8, async (shipId) => {
        const frete = await buscarFreteEnvio(headers, shipId, tentar);
        prontos++;
        if (prontos % 20 === 0) estado.fase = `custo de ${prontos}/${envios.length} envios`;
        if (!frete || frete.custo_vendedor == null) return;
        for (const { od, orderId, itensPedido, pendentes } of porEnvio.get(shipId)) {
            for (const oi of pendentes) {
                const item = oi.item || {};
                linhas.push({
                    order_id: orderId,
                    date: String(od.date_created || '').slice(0, 19).replace('T', ' '),
                    item_id: item.id, sku: item.seller_sku || item.seller_custom_field || '',
                    title: item.title || '', units: oi.quantity || 1, unit_price: oi.unit_price ?? null,
                    itens_no_pedido: itensPedido.length,
                    ...frete,
                });
            }
        }
    });
    return linhas;
}

function compararUltimasVendas(historico) {
    const limpas = historico.filter(l => l.itens_no_pedido === 1 && l.units === 1 && l.custo_vendedor != null)
        .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    const porItem = {};
    for (const l of limpas) (porItem[l.item_id] = porItem[l.item_id] || []).push(l);
    const mudancas = [];
    for (const [itemId, g] of Object.entries(porItem)) {
        if (g.length < 2) continue;
        const atual = g[g.length - 1], anterior = g[g.length - 2];
        if (atual.logistic_type !== anterior.logistic_type) continue;
        if (Math.round((atual.custo_vendedor - anterior.custo_vendedor) * 100) === 0) continue;
        mudancas.push({
            item_id: itemId, sku: atual.sku, title: atual.title,
            antes: anterior.custo_vendedor, antes_data: anterior.date.slice(0, 10), antes_uf: anterior.uf_destino,
            depois: atual.custo_vendedor, depois_data: atual.date.slice(0, 10), depois_uf: atual.uf_destino,
            order_id: atual.order_id,
        });
    }
    return mudancas;
}

// ── Verificação completa ────────────────────────────────────────────────────
async function verificar({ forcarTabela = false, origem = 'agendador' } = {}) {
    if (estado.rodando) return { ok: false, motivo: 'já está verificando' };
    estado.rodando = true;
    estado.iniciado_em = new Date().toISOString();
    estado.ultimo_erro = null;
    const resultado = { ok: true, origem, tabela: null, vendas: null };
    try {
        const { access_token, user_id } = await TokenManager.getToken();
        const headers = { Authorization: `Bearer ${access_token}` };
        const tentar = (fn) => comBackoff(fn, { tentativas: 4, baseMs: 400 });
        const cfg = configuracao();
        const agoraIso = new Date().toISOString();

        // 1. vendas — sempre (incremental, barato)
        const estVendas = lerJson('frete_vendas.json', { linhas: [], notificados: [], verificado_em: null });
        const primeiraCarga = !estVendas.linhas.length;
        const novas = await coletarVendas(headers, user_id, tentar, estVendas.linhas);
        let historico = estVendas.linhas.concat(novas).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
        if (historico.length > MAX_LINHAS_VENDAS) historico = historico.slice(-MAX_LINHAS_VENDAS);
        const difs = compararUltimasVendas(historico);
        const jaNotificados = new Set(estVendas.notificados || []);
        const pendentes = primeiraCarga ? [] : difs.filter(m => !jaNotificados.has(m.order_id));
        estVendas.linhas = historico;
        estVendas.notificados = [...new Set([...jaNotificados, ...difs.map(m => m.order_id)])].slice(-5000);
        estVendas.verificado_em = agoraIso;
        salvarJson('frete_vendas.json', estVendas);
        resultado.vendas = { novas: novas.length, total: historico.length, diferentes: pendentes.length, primeira_carga: primeiraCarga };

        if (!primeiraCarga && novas.length && cfg.avisar_vendas) {
            const total = novas.reduce((s, l) => s + (l.custo_vendedor || 0), 0);
            const linhas = novas.slice(-3).map(l => `${dataBr(l.date)} ${l.sku ? '[' + l.sku + '] ' : ''}${l.title.slice(0, 38)} — ${brl(l.custo_vendedor)} ${l.uf_destino}`);
            notificar(`Frete pago em ${novas.length} venda(s): ${brl(total)}`, linhas.join('\n'), '/frete');
        }
        if (pendentes.length && cfg.avisar_diferenca) {
            const linhas = pendentes.slice(0, 3).map(m => `${m.sku ? '[' + m.sku + '] ' : ''}${m.title.slice(0, 34)}: ${brl(m.antes)} → ${brl(m.depois)} ${m.depois > m.antes ? '▲' : '▼'}`);
            if (pendentes.length > 3) linhas.push(`… e mais ${pendentes.length - 3}`);
            notificar(`${pendentes.length} anúncio(s) com frete diferente da venda anterior`, linhas.join('\n'), '/frete');
        }

        // 2. tabela — só quando forçada ou passou o intervalo configurado
        const tabelaAntes = lerJson('frete_tabela.json', null);
        const idadeH = tabelaAntes ? (Date.now() - new Date(tabelaAntes.coletado_em).getTime()) / 3600000 : Infinity;
        if (forcarTabela || idadeH >= cfg.horas_tabela) {
            const agora = await coletarTabela(headers, user_id, tentar);
            const snapshot = { coletado_em: agoraIso, total: Object.keys(agora).length, itens: agora };
            salvarJson('frete_tabela.json', snapshot);
            if (!tabelaAntes) {
                resultado.tabela = { baseline: true, total: snapshot.total, mudancas: 0 };
                notificar('Monitor de frete ativo', `Baseline criada com ${snapshot.total} anúncios ativos. Aviso quando o Mercado Livre mudar o frete de algum.`, '/frete');
            } else {
                const { mudancas, novos, sumidos } = compararTabela(tabelaAntes.itens || {}, agora);
                if (mudancas.length) {
                    const log = lerJson('frete_mudancas.json', []);
                    const registros = mudancas.map(m => ({ quando: agoraIso, ...m }));
                    salvarJson('frete_mudancas.json', registros.concat(log).slice(0, MAX_MUDANCAS));
                }
                resultado.tabela = { total: snapshot.total, mudancas: mudancas.length, novos: novos.length, sumidos: sumidos.length };
                if (mudancas.length && cfg.avisar_tabela) {
                    const sobe = mudancas.filter(m => m.mudancas.list_cost && m.mudancas.list_cost.depois > m.mudancas.list_cost.antes).length;
                    const cai = mudancas.filter(m => m.mudancas.list_cost && m.mudancas.list_cost.antes > m.mudancas.list_cost.depois).length;
                    const linhas = mudancas.slice(0, 3).map(m => {
                        const partes = Object.entries(m.mudancas).map(([c, ad]) => `${fmtValor(c, ad.antes)} → ${fmtValor(c, ad.depois)}`);
                        return `${m.sku ? '[' + m.sku + '] ' : ''}${m.title.slice(0, 30)}: ${partes.join(' | ')}`;
                    });
                    if (mudancas.length > 3) linhas.push(`… e mais ${mudancas.length - 3}`);
                    notificar(`Frete ML: ${mudancas.length} anúncio(s) com frete alterado (${sobe} subiram, ${cai} caíram)`, linhas.join('\n'), '/frete');
                }
            }
        } else {
            resultado.tabela = { pulada: true, proxima_em_h: Math.max(0, Math.round((cfg.horas_tabela - idadeH) * 10) / 10) };
        }
    } catch (e) {
        estado.ultimo_erro = String(e.response?.data?.message || e.message || e).slice(0, 200);
        resultado.ok = false;
        resultado.erro = estado.ultimo_erro;
        console.error('[FRETE] verificação falhou: ' + estado.ultimo_erro);
    } finally {
        estado.rodando = false;
        estado.fase = '';
    }
    return resultado;
}

// ── Leitura para a tela ─────────────────────────────────────────────────────
function resumo() {
    const tabela = lerJson('frete_tabela.json', null);
    const mudancas = lerJson('frete_mudancas.json', []);
    const vendas = lerJson('frete_vendas.json', { linhas: [], verificado_em: null });
    const itens = tabela ? Object.values(tabela.itens || {}) : [];
    const ultimaMudancaPorItem = {};
    for (const m of mudancas) if (!ultimaMudancaPorItem[m.item_id]) ultimaMudancaPorItem[m.item_id] = m;
    const corte7 = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const corte30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const linhas = vendas.linhas || [];
    const soma = (de) => linhas.filter(l => l.date >= de).reduce((s, l) => s + (l.custo_vendedor || 0), 0);
    const difs = compararUltimasVendas(linhas);
    const difPorItem = Object.fromEntries(difs.map(d => [d.item_id, d]));
    return {
        estado: { ...estado },
        config: configuracao(),
        tabela: {
            coletado_em: tabela ? tabela.coletado_em : null,
            total: itens.length,
            itens: itens.map(it => ({ ...it, ultima_mudanca: ultimaMudancaPorItem[it.item_id] ? ultimaMudancaPorItem[it.item_id].quando : null })),
        },
        mudancas: mudancas.slice(0, 300),
        vendas: {
            verificado_em: vendas.verificado_em,
            total: linhas.length,
            frete_7d: Math.round(soma(corte7) * 100) / 100,
            frete_30d: Math.round(soma(corte30) * 100) / 100,
            vendas_7d: linhas.filter(l => l.date >= corte7).length,
            recentes: linhas.slice(-80).reverse().map(l => ({ ...l, diferente: difPorItem[l.item_id] && difPorItem[l.item_id].order_id === l.order_id ? difPorItem[l.item_id] : null })),
        },
        mudancas_30d: mudancas.filter(m => m.quando >= corte30).length,
    };
}

// ── Agendador ───────────────────────────────────────────────────────────────
// Roda 90 s depois de o app abrir (a coleta da abertura já terminou) e depois
// de hora em hora enquanto o app estiver aberto. Não concorre com o motor.
function rodada(origem) {
    if (estado.rodando || estado.motorOcupado) return;
    verificar({ origem }).catch(() => {});
}
function iniciarAgendador() {
    pararAgendador();
    timerPrimeira = setTimeout(() => rodada('abertura'), PRIMEIRA_RODADA_MS);
    timerIntervalo = setInterval(() => rodada('agendador'), INTERVALO_MS);
}
function pararAgendador() {
    if (timerPrimeira) clearTimeout(timerPrimeira);
    if (timerIntervalo) clearInterval(timerIntervalo);
    timerPrimeira = timerIntervalo = null;
}

module.exports = {
    verificar, resumo, configuracao, salvarConfiguracao, usarNotificador,
    iniciarAgendador, pararAgendador, estado,
    notificarTeste: () => notificar('Notificação de teste', 'Se você está vendo isto, os avisos de frete vão aparecer aqui.', '/frete'),
    _interno: { compararTabela, compararUltimasVendas },
};
