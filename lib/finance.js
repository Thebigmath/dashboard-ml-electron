// Finance (SEVEN): DRE do mes, conciliacao com o Mercado Pago e margem por produto, das vendas do ML.
//
// Coleta de um mes (fica em STORAGE/finance/AAAA-MM.json; mes fechado nao muda mais):
//   pedidos ......... /orders/search dia a dia (cancelados ficam de fora, como no Mercado Turbo)
//   envio ........... /shipments/{id} + /costs: logistica e o frete que o vendedor pagou (cache compartilhado com a Analise de vendas)
//   pagamento ....... Mercado Pago /v1/payments/{id}: status, devolvido, liquido que caiu e a liberacao do dinheiro
//   ADS ............. gasto do mes nas campanhas de Product Ads
// Custos operacionais: cadastro manual por mes (STORAGE/finance_custos.json).
//
// DRE (por mes):
//   Faturamento bruto = valor x qtd de todos os pedidos (nao cancelados)
//   (-) cupons do vendedor
//   (-) devolucoes = o que voltou ao comprador SEM cobertura do ML (cobertura "bpp_covered" nao sai da loja)
//   = Receita liquida
//   (-) CMV (custo da planilha x qtd) · (-) tarifas do ML · (-) frete pago · (-) impostos  -> so das vendas que ficaram
//       impostos: Simples = imposto_pct da receita; Lucro Real (regime da conta) = o imposto de cada pedido da Planilha avancada
//       (regra fiscal do SKU na Base tributaria e UF do comprador), repartido pelos itens
//   = Margem de contribuicao · (-) ADS · (-) custos operacionais = Lucro liquido
// Venda estornada (devolvida sem cobertura): o ML devolve tarifa e frete e o produto volta, entao ela entra so como devolucao.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const P = require('./precificador');
const TokenManager = require('./tokenManager');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const DIR = path.join(STORAGE, 'finance');
const CUSTOS = path.join(STORAGE, 'finance_custos.json');
const ENVIOS = path.join(STORAGE, 'vendas_mc_envios.json');
const NOTAS_ML = path.join(STORAGE, 'ml_notas.json');   // NF-e de cada pedido no ML (Planilha avancada)
const ML = 'https://api.mercadolibre.com';
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
const gravarJson = (arq, d) => { fs.mkdirSync(path.dirname(arq), { recursive: true }); fs.writeFileSync(arq, JSON.stringify(d), 'utf8'); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const LOG = { fulfillment: 'Full', self_service: 'Flex', cross_docking: 'ME2', xd_drop_off: 'ME2', drop_off: 'ME2', default: 'ME2' };

async function get(url, headers, params) {
    for (let t = 1; ; t++) {
        try { return (await axios.get(url, { headers, params, timeout: 30000 })).data; }
        catch (e) { const st = e.response?.status; if ((st === 429 || st >= 500 || !e.response) && t < 6) { await sleep(1500 * t); continue; } throw e; }
    }
}
// o que o Mercado Pago descontou deste pagamento (charges_details), separado: tarifa de venda (ML + MP), cupom pago
// pelo vendedor, frete descontado no pagamento e juros do parcelamento (o comprador paga e o MP repassa: saldo zero).
// Frete do Flex e de parte do Full NAO vem aqui: e cobrado a parte (aparece no extrato de liberacoes).
// o essencial da NF-e do pedido no ML (sem dados do comprador)
function notaML(d) {
    const v = (nome, campo) => Number(((d.fiscal_data?.fiscal_amounts || []).find(x => x.name === nome) || {}).attributes?.[campo]) || 0;
    return { status: d.status, numero: d.invoice_number, serie: d.invoice_series, emitida: d.issued_date, chave: d.attributes?.invoice_key || null, fonte: d.attributes?.invoice_source || null,
        valor: Number(d.amount) || 0, icms: v('icms_simples', 'vicms') || v('icms', 'vicms'), st: v('icms_simples', 'vst') || v('icms', 'vst'), ipi: v('ipi', 'vipi'), pis: v('pis', 'vpis'), cofins: v('cofins', 'vcofins'),
        difal: v('difal', 'vicmsufdest'), tot_trib: v('ibpt', 'vtottrib'), simples: /Simples Nacional/i.test(JSON.stringify(d.fiscal_data?.messages || '')),
        itens: (d.items || []).map(i => { const a = i.fiscal_data?.attributes || {}, r = i.fiscal_data?.rules || []; const cst = (n) => ((r.find(x => x.name === n) || {}).attributes || {}).cst || null;
            return { sku: i.attributes?.sku || null, ncm: a.ncm || null, cest: a.cest || null, csosn: a.csosn || null, cfop: a.cfop || null, origem: a.origin_detail ?? null, cst_pis: cst('PIS'), cst_cofins: cst('COFINS') }; }),
        lido_em: new Date().toISOString() };
}
function cobrancasMP(m) {
    const c = { tarifa: 0, cupom: 0, frete: 0, juros: 0, outros: 0, frete_comprador: Number(m.shipping_amount) || 0 };
    for (const x of m.charges_details || []) {
        const v = (Number(x.amounts?.original) || 0) - (Number(x.amounts?.refunded) || 0), de = x.accounts?.from;
        if (de === 'payer' && x.accounts?.to === 'collector') { c.juros -= v; continue; }
        if (de !== 'collector') continue;
        if (x.type === 'shipping') c.frete += v; else if (x.type === 'coupon') c.cupom += v;
        else if (x.type === 'fee') { if (x.name === 'financing_fee') c.juros += v; else c.tarifa += v; } else c.outros += v;
    }
    for (const k in c) c[k] = Math.round(c[k] * 100) / 100;
    return c;
}
async function limitado(lista, n, fn) { let k = 0; await Promise.all(Array.from({ length: n }, async () => { while (k < lista.length) { const x = lista[k++]; await fn(x); } })); }

const hojeBR = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
function intervalo(mes) {
    const [a, m] = mes.split('-').map(Number);
    const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate();
    const de = `${mes}-01`, fimMes = `${mes}-${String(ultimo).padStart(2, '0')}`;
    return { de, ate: fimMes < hojeBR() ? fimMes : hojeBR(), fechado: fimMes < hojeBR() };
}
const arqMes = (mes) => path.join(DIR, `${mes}.json`);

// ---- coleta (em segundo plano, com progresso) ----
const estado = { rodando: false, mes: null, etapa: '', feito: 0, total: 0, erro: null };
async function coletar(mes, { forcar = false } = {}) {
    if (estado.rodando) return { ok: false, erro: 'Já existe uma coleta em andamento.', estado };
    if (!/^\d{4}-\d{2}$/.test(mes || '')) throw new Error('Mês inválido.');
    Object.assign(estado, { rodando: true, mes, etapa: 'Lendo os pedidos…', feito: 0, total: 0, erro: null });
    (async () => {
        try {
            const { headers, userId } = await P.auth();
            const { de, ate, fechado } = intervalo(mes);
            const antigo = forcar ? { pagamentos: {} } : lerJson(arqMes(mes), { pagamentos: {} });
            // pedidos dia a dia
            const pedidos = [];
            for (let d = new Date(de + 'T12:00:00Z'); d <= new Date(ate + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
                const dia = d.toISOString().slice(0, 10);
                estado.etapa = `Lendo os pedidos de ${dia.split('-').reverse().join('/')}…`;
                // a paginacao do ML as vezes repete um pedido em duas paginas (e pula outro): junta por id e, se faltar
                // pedido do dia, le de novo na ordem inversa para completar
                const doDia = new Map(); let total = 0;
                for (const sort of ['date_asc', 'date_desc']) {
                    for (let off = 0; off < 10000; off += 50) {
                        const r = await get(`${ML}/orders/search`, headers, { seller: userId, limit: 50, offset: off, sort,
                            'order.date_created.from': `${dia}T00:00:00.000-03:00`, 'order.date_created.to': `${dia}T23:59:59.999-03:00` });
                        for (const o of r.results || []) doDia.set(String(o.id), o);
                        total = r.paging?.total || 0;
                        if (off + 50 >= total) break;
                    }
                    if (doDia.size >= total) break;
                }
                pedidos.push(...doDia.values());
            }
            // o mesmo pedido pode vir em dois dias (paginacao do ML): fica um por id no mes inteiro
            { const m = new Map(pedidos.map(o => [String(o.id), o])); pedidos.length = 0; pedidos.push(...m.values()); }
            const validos = pedidos.filter(o => o.status !== 'cancelled');
            // envios (cache compartilhado)
            const envios = lerJson(ENVIOS, {});
            // relê o envio que ainda nao tem cidade/UF (Planilha avancada) ou que ainda nao chegou ao fim (o status muda)
            const FINAL = ['delivered', 'not_delivered', 'cancelled'];
            const faltam = [...new Set(validos.map(o => o.shipping?.id).filter(Boolean))].filter(id => !envios[id] || envios[id].uf === undefined || envios[id].desconto === undefined || envios[id].compensacao === undefined || !FINAL.includes(envios[id].status));
            Object.assign(estado, { etapa: 'Lendo o frete de cada envio…', feito: 0, total: faltam.length });
            await limitado(faltam, 5, async (id) => {
                try {
                    const [s, k] = await Promise.all([get(`${ML}/shipments/${id}`, headers), get(`${ML}/shipments/${id}/costs`, headers)]);
                    envios[id] = { logistica: s.logistic_type || '', status: s.status || '', cidade: s.receiver_address?.city?.name || '', uf: (s.receiver_address?.state?.id || '').replace(/^BR-/, ''), comprador: Number(k.receiver?.cost) || 0,
                        vendedor: (k.senders || []).filter(x => !x.user_id || String(x.user_id) === String(userId)).reduce((t, x) => t + (Number(x.cost) || 0), 0),
                        // desconto do ML no frete do vendedor (o cost ja vem com ele descontado): rebate do frete na Planilha avancada
                        desconto: (k.senders || []).filter(x => !x.user_id || String(x.user_id) === String(userId)).reduce((t, x) => t + (Number(x.save) || 0), 0),
                        // compensacao do ML no frete do vendedor (Rebate do frete na Planilha avancada)
                        compensacao: (k.senders || []).filter(x => !x.user_id || String(x.user_id) === String(userId)).reduce((t, x) => t + (Number(x.compensation) || 0), 0) };
                } catch { /* fica sem frete */ }
                estado.feito++;
            });
            gravarJson(ENVIOS, envios);
            // notas fiscais dos pedidos no ML (emissor do ML ou nota enviada ao ML): numero, serie, status e impostos
            // da NF-e (cache compartilhado; a nota autorizada ou cancelada nao muda mais)
            const notas = lerJson(NOTAS_ML, {});
            const semNota = validos.map(o => String(o.id)).filter(id => !notas[id] || !['authorized', 'canceled', 'cancelled'].includes(notas[id].status));
            Object.assign(estado, { etapa: 'Lendo as notas fiscais no Mercado Livre…', feito: 0, total: semNota.length });
            await limitado(semNota, 5, async (id) => {
                try { notas[id] = notaML(await get(`${ML}/users/${userId}/invoices/orders/${id}`, headers)); }
                catch (e) { if (e.response?.status === 404) notas[id] = { status: 'sem_nota', lido_em: new Date().toISOString() }; }
                estado.feito++;
            });
            gravarJson(NOTAS_ML, notas);
            // descontos de campanha dos pedidos com desconto (quanto a loja banca e quanto o ML devolve na tarifa)
            const comDesc = validos.filter(o => (o.tags || []).includes('order_has_discount'));
            const descontos = {};
            Object.assign(estado, { etapa: 'Lendo os descontos de campanha…', feito: 0, total: comDesc.length });
            await limitado(comDesc, 5, async (o) => {
                try { const d = await get(`${ML}/orders/${o.id}/discounts`, headers);
                    descontos[o.id] = (d.details || []).map(x => { const a = (x.items || []).reduce((s, i) => ({ total: s.total + (Number(i.amounts?.total) || 0), loja: s.loja + (Number(i.amounts?.seller) || 0) }), { total: 0, loja: 0 });
                        return { tipo: x.type, total: Math.round(a.total * 100) / 100, loja: Math.round(a.loja * 100) / 100, modo: x.supplier?.funding_mode || null }; }); }
                catch { /* sem detalhe */ }
                estado.feito++;
            });
            // pagamentos no Mercado Pago (o que ja foi liberado nao muda; o resto e lido de novo)
            const pags = {};
            for (const o of validos) for (const p of o.payments || []) pags[p.id] = o.id;
            // (relê tambem o que ainda nao tem o detalhe das cobrancas, usado na Conciliacao)
            const ler = Object.keys(pags).filter(id => !(antigo.pagamentos[id] && antigo.pagamentos[id].liberacao === 'released' && antigo.pagamentos[id].status !== 'in_mediation' && antigo.pagamentos[id].cobrancas && antigo.pagamentos[id].cobrancas.frete_comprador !== undefined));
            const pagamentos = { ...antigo.pagamentos };
            Object.assign(estado, { etapa: 'Conferindo os pagamentos no Mercado Pago…', feito: 0, total: ler.length });
            await limitado(ler, 6, async (id) => {
                try {
                    const m = await get(`https://api.mercadopago.com/v1/payments/${id}`, headers);
                    pagamentos[id] = { status: m.status, detalhe: m.status_detail, total: m.transaction_amount, devolvido: m.transaction_amount_refunded || 0,
                        liquido: m.transaction_details?.net_received_amount ?? null, liberacao: m.money_release_status || null, liberacao_data: m.money_release_date || null, cobrancas: cobrancasMP(m) };
                } catch { /* sem acesso ao MP para este pagamento */ }
                estado.feito++;
            });
            // ADS do mes
            let ads = null;
            try {
                estado.etapa = 'Lendo o gasto de ADS…';
                const { access_token } = await TokenManager.getToken();
                const h = { Authorization: `Bearer ${access_token}` };
                const { advertisers = [] } = await get(`${ML}/advertising/advertisers`, h, { product_id: 'PADS' });
                const an = advertisers.find(a => a.site_id === 'MLB');
                if (an) {
                    let gasto = 0, receita = 0;
                    for (let off = 0; ; off += 50) {
                        const d = await get(`${ML}/advertising/MLB/advertisers/${an.advertiser_id}/product_ads/campaigns/search`, { ...h, 'api-version': '2' },
                            { limit: 50, offset: off, date_from: de, date_to: ate, metrics: 'cost,total_amount' });
                        for (const c of d.results || []) { gasto += Number(c.metrics?.cost) || 0; receita += Number(c.metrics?.total_amount) || 0; }
                        if (off + 50 >= (d.paging?.total || 0)) break;
                    }
                    ads = { gasto: r2(gasto), receita: r2(receita) };
                }
            } catch (e) { ads = { erro: e.message }; }
            // so o necessario de cada pedido
            const enxuto = validos.map(o => ({ id: String(o.id), data: o.date_created, envio: o.shipping?.id || null, cupom: Number(o.coupon?.amount) || 0,
                pack: o.pack_id ? String(o.pack_id) : null, cliente: o.buyer?.nickname || '', descontos: descontos[o.id] || undefined,
                pagamentos: (o.payments || []).map(p => ({ id: String(p.id), status: p.status, detalhe: p.status_detail, total: p.transaction_amount, devolvido: p.transaction_amount_refunded || 0 })),
                itens: (o.order_items || []).map(i => ({ item_id: i.item?.id, titulo: i.item?.title || '', sku: i.item?.seller_sku || i.item?.seller_custom_field || '',
                    qtd: Number(i.quantity) || 1, valor: Number(i.unit_price) || 0, tarifa: Number(i.sale_fee) || 0 })) }));
            // cancelados: o ML cancela o pedido quando devolve o dinheiro todo (estorno); separa os que chegaram a ser pagos
            const canc = pedidos.filter(o => o.status === 'cancelled');
            const pagosEstornados = canc.filter(o => (o.payments || []).some(p => Number(p.transaction_amount_refunded) > 0));
            const cancelados_info = { qtd: canc.length, estornados: pagosEstornados.length,
                valor_estornado: r2(pagosEstornados.reduce((s, o) => s + (o.payments || []).reduce((t, p) => t + (Number(p.transaction_amount_refunded) || 0), 0), 0)) };
            gravarJson(arqMes(mes), { mes, de, ate, fechado, atualizado_em: new Date().toISOString(), cancelados: canc.length, cancelados_info, pedidos: enxuto, pagamentos, ads });
        } catch (e) { estado.erro = e.message; }
        finally { Object.assign(estado, { rodando: false, etapa: '' }); }
    })();
    return { ok: true, estado };
}

// ---- custos operacionais (cadastro manual por mes) ----
function custosOperacionais(mes) { return ((lerJson(CUSTOS, {})[mes]) || []).map(c => ({ ...c, tipo: tipoDo(c) })); }
// Custos e Despesas (22/10/2026): cada lancamento e fixo (nao muda com as vendas: pessoal, aluguel, sistemas, contador)
// ou variavel (acompanha as vendas: embalagem, transporte, marketing). Lancamento antigo sem tipo segue a categoria.
const VARIAVEIS = ['Embalagem', 'Transporte', 'Marketing'];
const tipoDo = (c) => c.tipo === 'fixo' || c.tipo === 'variavel' ? c.tipo : VARIAVEIS.includes(c.categoria) ? 'variavel' : 'fixo';
function salvarCustos(mes, lista) {
    const todos = lerJson(CUSTOS, {});
    todos[mes] = (lista || []).map(c => ({ nome: String(c.nome || '').trim(), valor: r2(c.valor), categoria: String(c.categoria || 'Outros'), tipo: tipoDo(c) })).filter(c => c.nome && c.valor);
    gravarJson(CUSTOS, todos);
    return todos[mes];
}

// ---- calculos ----
function analisar(mes) {
    const d = lerJson(arqMes(mes), null);
    if (!d) return { mes, coletado: false, estado };
    const cfg = lerJson(path.join(STORAGE, 'config.json'), {});
    const impostoPct = Number(cfg.imposto_pct ?? 7);
    // Lucro Real: imposto por pedido calculado pela Planilha avancada (mesmo motor, mesmas regras)
    const FP = require('./fiscal_produto'), lrMes = FP.regimeNoDia(mes + '-28') === 'lucro_real';
    let impPedido = null, lrResumo = null;
    // a Planilha avancada e o motor: o cupom do DRE e o que a loja pagou de fato (o cupom bancado pelo ML nao sai da loja), igual a
    // Planilha; no Lucro Real o imposto de cada pedido tambem vem dela
    let PL = null; try { PL = require('./finance_planilha').planilha({ de: d.de, ate: d.ate }); } catch { PL = null; }
    const pedPlan = PL ? new Map(PL.pedidos.map(p => [String(p.id), p])) : new Map();
    if (lrMes && PL) { impPedido = pedPlan; lrResumo = PL.lucro_real; }
    const envios = lerJson(ENVIOS, {});
    const linhas = [];          // uma por item vendido
    // mes coletado antes da correcao da paginacao pode ter o mesmo pedido duas vezes
    const vistos = new Set();
    d.pedidos = d.pedidos.filter(o => !vistos.has(o.id) && vistos.add(o.id));
    for (const o of d.pedidos) {
        // tentativas recusadas/canceladas (cartao negado antes do pagamento aprovado) nao movem dinheiro e ficam
        // "pendentes" para sempre no MP: entravam no total e deixavam o pedido como retido
        const todos = o.pagamentos.map(p => ({ ...p, ...(d.pagamentos[p.id] || {}) }));
        const pgs = todos.filter(p => !['rejected', 'cancelled'].includes(p.status)).length ? todos.filter(p => !['rejected', 'cancelled'].includes(p.status)) : todos;
        const total = pgs.reduce((s, p) => s + Number(p.total || 0), 0) || 1;
        const coberto = pgs.some(p => /covered/.test(p.detalhe || ''));
        const devolvido = coberto ? 0 : pgs.reduce((s, p) => s + Number(p.devolvido || 0), 0);
        const estornado = !coberto && devolvido >= total - 0.01;
        const liquidoMP = pgs.every(p => p.liquido != null) ? pgs.reduce((s, p) => s + Number(p.liquido), 0) : null;
        const libData = pgs.map(p => p.liberacao_data).filter(Boolean).sort().pop() || null;
        // a liberar com a data de liberacao ja vencida = dinheiro retido (mediacao, reclamacao...): precisa conferir
        let lib = pgs.every(p => p.liberacao === 'released') ? 'liberado' : pgs.some(p => p.liberacao) ? 'a_liberar' : null;
        if (lib === 'a_liberar' && libData && new Date(libData).getTime() < Date.now() - 3 * 86400000) lib = 'retido';   // 3 dias de folga (fim de semana)
        const env = envios[o.envio] || null;
        const somaItens = o.itens.reduce((s, i) => s + i.valor * i.qtd, 0) || 1;
        for (const i of o.itens) {
            const parte = (i.valor * i.qtd) / somaItens;
            const custoUn = P.custoDoSku(i.sku);
            const bruto = r2(i.valor * i.qtd), cupom = r2((pedPlan.has(String(o.id)) ? -(pedPlan.get(String(o.id)).salesDiscount || 0) : o.cupom) * parte), dev = r2(devolvido * parte);
            const fica = !estornado;
            const receita = r2(bruto - cupom - dev);
            linhas.push({ pedido: o.id, data: o.data, item_id: i.item_id, titulo: i.titulo, sku: i.sku, qtd: i.qtd, bruto, cupom, devolucao: dev, receita,
                custo: fica && custoUn ? r2(custoUn.valor * i.qtd) : 0, sem_custo: fica && !custoUn,
                tarifa: fica ? r2(i.tarifa * i.qtd) : 0, frete: fica && env ? r2(env.vendedor * parte) : 0, sem_frete: fica && !env,
                imposto: !fica ? 0 : impPedido ? r2(((impPedido.get(String(o.id)) || {}).tax || 0) * parte) : r2(receita * impostoPct / 100), logistica: env ? (LOG[env.logistica] || env.logistica) : '—',
                estornado, coberto, parcial: !estornado && dev > 0,
                liquido_mp: liquidoMP != null ? r2(liquidoMP * parte) : null,
                esperado: fica ? r2(receita - i.tarifa * i.qtd - (env ? env.vendedor * parte : 0)) : null, liberacao: estornado ? 'estornado' : lib, liberacao_data: libData });
        }
    }
    const soma = (arr, k) => r2(arr.reduce((s, x) => s + (Number(x[k]) || 0), 0));
    const custosOp = custosOperacionais(mes);
    const dre = {
        bruto: soma(linhas, 'bruto'), cupons: soma(linhas, 'cupom'), devolucoes: soma(linhas, 'devolucao'),
        receita: soma(linhas, 'receita'), cmv: soma(linhas, 'custo'), tarifas: soma(linhas, 'tarifa'), frete: soma(linhas, 'frete'), impostos: soma(linhas, 'imposto'),
        ads: d.ads && !d.ads.erro ? d.ads.gasto : 0, custos_operacionais: soma(custosOp, 'valor'),
        custos_fixos: soma(custosOp.filter(c => c.tipo === 'fixo'), 'valor'), custos_variaveis: soma(custosOp.filter(c => c.tipo === 'variavel'), 'valor'),
    };
    // margem so dos itens COM custo cadastrado (igual a Planilha avancada): item sem custo entraria com custo zero e inflaria a margem
    const semCusto = linhas.filter(l => l.sem_custo), comCusto = linhas.filter(l => !l.sem_custo);
    dre.sem_custo_itens = semCusto.length; dre.sem_custo_pedidos = new Set(semCusto.map(l => l.pedido)).size; dre.sem_custo_receita = soma(semCusto, 'receita');
    dre.mc = r2(soma(comCusto, 'receita') - soma(comCusto, 'custo') - soma(comCusto, 'tarifa') - soma(comCusto, 'frete') - soma(comCusto, 'imposto'));
    dre.lucro = r2(dre.mc - dre.ads - dre.custos_operacionais);
    const recCusto = r2(dre.receita - dre.sem_custo_receita), pct = (v) => recCusto ? r2(v / recCusto * 100) : null;
    dre.mc_pct = pct(dre.mc); dre.lucro_pct = pct(dre.lucro);
    // conciliacao
    const fic = linhas.filter(l => !l.estornado);
    const conc = {
        liquido_mp: r2(fic.filter(l => l.liquido_mp != null).reduce((s, l) => s + l.liquido_mp, 0)),
        liberado: r2(fic.filter(l => l.liberacao === 'liberado').reduce((s, l) => s + (l.liquido_mp || 0), 0)),
        a_liberar: r2(fic.filter(l => l.liberacao === 'a_liberar').reduce((s, l) => s + (l.liquido_mp || 0), 0)),
        retido: r2(fic.filter(l => l.liberacao === 'retido').reduce((s, l) => s + (l.liquido_mp || 0), 0)),
        qtd_retido: new Set(fic.filter(l => l.liberacao === 'retido').map(l => l.pedido)).size,
        estornado: soma(linhas.filter(l => l.estornado), 'devolucao'), qtd_estornado: new Set(linhas.filter(l => l.estornado).map(l => l.pedido)).size,
        coberto: new Set(linhas.filter(l => l.coberto).map(l => l.pedido)).size, parcial: new Set(linhas.filter(l => l.parcial).map(l => l.pedido)).size,
        sem_mp: fic.filter(l => l.liquido_mp == null).length,
        cancelados: d.cancelados_info || { qtd: d.cancelados || 0 },
    };
    // diferenca entre o que deveria cair (receita - tarifa - frete) e o que o Mercado Pago creditou
    const comp = fic.filter(l => l.liquido_mp != null && l.esperado != null && !l.coberto && !l.parcial);
    for (const l of comp) l.diferenca = r2(l.liquido_mp - l.esperado);
    conc.esperado = r2(comp.reduce((s, l) => s + l.esperado, 0));
    conc.creditado = r2(comp.reduce((s, l) => s + l.liquido_mp, 0));
    conc.diferenca = r2(conc.creditado - conc.esperado);
    conc.com_diferenca = comp.filter(l => Math.abs(l.diferenca) >= 1).length;
    const proximas = {};
    for (const l of fic.filter(l => l.liberacao === 'a_liberar' && l.liberacao_data)) { const k = l.liberacao_data.slice(0, 10); proximas[k] = r2((proximas[k] || 0) + (l.liquido_mp || 0)); }
    conc.proximas = Object.entries(proximas).sort().map(([dia, valor]) => ({ dia, valor }));
    // margem por produto (vendas que ficaram)
    const g = {};
    for (const l of linhas) {
        const k = l.item_id;
        const x = g[k] ||= { item_id: k, titulo: l.titulo, sku: l.sku, unidades: 0, pedidos: 0, estornos: 0, receita: 0, custo: 0, tarifa: 0, frete: 0, imposto: 0, devolucao: 0, sem_custo: false };
        x.pedidos++; if (l.estornado) x.estornos++; else x.unidades += l.qtd;
        for (const c of ['receita', 'custo', 'tarifa', 'frete', 'imposto', 'devolucao']) x[c] = r2(x[c] + l[c]);
        if (l.sem_custo) x.sem_custo = true;
    }
    const produtos = Object.values(g).map(x => ({ ...x, mc: r2(x.receita - x.custo - x.tarifa - x.frete - x.imposto) }))
        .map(x => ({ ...x, mc_pct: x.receita ? r2(x.mc / x.receita * 100) : null })).sort((a, b) => b.receita - a.receita);
    return { mes, coletado: true, de: d.de, ate: d.ate, fechado: d.fechado, atualizado_em: d.atualizado_em, imposto_pct: impostoPct, regime: lrMes ? 'lucro_real' : 'simples',
        irpj_csll: lrResumo ? r2(lrResumo.irpj + lrResumo.csll) : null,
        pedidos: d.pedidos.length, cancelados: d.cancelados, unidades: soma(fic, 'qtd'),
        sem_custo: fic.filter(l => l.sem_custo).length, sem_frete: fic.filter(l => l.sem_frete).length, ads_info: d.ads,
        dre, custos_operacionais: custosOp, conciliacao: conc, produtos, vendas: linhas.sort((a, b) => String(b.data).localeCompare(String(a.data))), estado };
}

function meses() {
    let lista = []; try { lista = fs.readdirSync(DIR).filter(f => /^\d{4}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 7)); } catch {}
    return lista.sort().reverse();
}

module.exports = { coletar, analisar, meses, estado, custosOperacionais, salvarCustos };
