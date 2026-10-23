// Planilha avancada do Finance (19/10/2026): analise de vendas PEDIDO A PEDIDO, no modelo da "Planilha avancada" do
// GeFinance (mesmas colunas e formulas), com os pedidos do Mercado Livre que o Finance ja coleta por mes
// (STORAGE/finance/AAAA-MM.json), o frete/cidade de cada envio (vendas_mc_envios.json) e as NF-e do Olist (finance_fiscal).
//   Total prod. vendidos = valor dos produtos + desconto (cupom do vendedor, negativo) + devolucao (negativa)
//   Total venda          = total prod. vendidos + frete recebido (no ML fica com o ML: 0) + ST da venda + IPI da venda
//   Comissao final       = comissao (tarifa de venda do ML, negativa) + rebate da comissao
//   Diferenca do frete   = frete recebido + frete pago (negativo, antes do desconto) + rebate do frete (desconto do ML)
//   Deb. TOTAL           = IPI + PIS + COFINS + ICMS + ST + DIFAL (XML da NF-e) · Cred. TOTAL = idem dos creditos (por SKU)
//   Imposto              = Deb. TOTAL + Simples/DAS (imposto_pct x base, quando CRT 1 ou sem nota) - Cred. TOTAL
//   Valor liquido        = BASE + comissao final + diferenca do frete - imposto - brinde - embalagem
//   Margem               = valor liquido - custo (planilha de custos)           % custo = margem / custo · % venda = margem / BASE
//   Repasse              = liquido que caiu no Mercado Pago (quando ja lido) ou total venda + comissao + dif. frete + bonus
const fs = require('fs');
const path = require('path');
const P = require('./precificador');
const FISCAL = require('./finance_fiscal');

const STORAGE = () => process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const r4 = (v) => Math.round(Number(v || 0) * 10000) / 10000;
const LOG = { fulfillment: 'Full', self_service: 'Flex', cross_docking: 'Coleta', xd_drop_off: 'Agência', drop_off: 'Correios', default: 'ME2' };
const STATUS = { ready_to_ship: 'Pronto para envio', shipped: 'Enviado', delivered: 'Entregue', not_delivered: 'Não entregue', cancelled: 'Cancelado', pending: 'Pendente', handling: 'Em preparação' };
const IMPOSTOS = ['Ipi', 'Pis', 'Cofins', 'Icms', 'St', 'Difal'];
const diaBR = (iso) => new Date(new Date(iso).getTime() - 3 * 3600000).toISOString().slice(0, 10);
function canal() {
    const app = path.basename(path.dirname(STORAGE()));
    return app === 'dashboard-cordeiro' ? 'Cordeiro Car' : 'Flavia Stock';
}

function mesesEntre(de, ate) {
    const out = []; let [a, m] = de.slice(0, 7).split('-').map(Number); const [a2, m2] = ate.slice(0, 7).split('-').map(Number);
    while (a < a2 || (a === a2 && m <= m2)) { out.push(`${a}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; a++; } }
    return out;
}
const lerMeses = (de, ate) => mesesEntre(de, ate).map(m => ({ mes: m, d: lerJson(path.join(STORAGE(), 'finance', m + '.json'), null) }));

// regime: 'auto' (padrao) segue o regime da conta em config.json (regime_tributario: { regime: 'lucro_real', desde: 'AAAA-MM' });
// 'real' simula o Lucro Real no periodo inteiro; 'simples' forca o Simples
function planilha({ de, ate, base = 'produtos', regime = 'auto', opcoes = {} } = {}) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(de || '') || !/^\d{4}-\d{2}-\d{2}$/.test(ate || '')) throw new Error('Período inválido.');
    const cfg = lerJson(path.join(STORAGE(), 'config.json'), {});
    const impostoPct = Number(cfg.imposto_pct ?? 7), brinde = Number(cfg.planilha_brinde) || 0, embalagem = Number(cfg.planilha_embalagem) || 0;
    const envios = lerJson(path.join(STORAGE(), 'vendas_mc_envios.json'), {});
    const notasML = lerJson(path.join(STORAGE(), 'ml_notas.json'), {});   // NF-e de cada pedido no ML
    const fis = FISCAL.base();
    // aliquota efetiva do Simples do mes do pedido (RBT12); sem os 12 meses lidos, fica o imposto_pct das Configuracoes
    const SN = require('./simples_nacional'), snCfg = SN.config(), aliqMes = {};
    const aliqDo = (dia) => { const m = dia.slice(0, 7); if (!(m in aliqMes)) { const a = snCfg.auto ? SN.aliquota(m, snCfg) : null; aliqMes[m] = a && a.completo ? a : null; } return aliqMes[m]; };
    // DAS do item: as partes do DAS do mes, tirando PIS/COFINS se o SKU e monofasico e o ICMS se tem ST. Quem diz e a Base
    // tributaria do contador (por SKU); SKU fora da base segue as opcoes do Simples (icms_st / monofasico).
    const FP = require('./fiscal_produto'), fontesFiscais = FP.fontes();
    const rt = cfg.regime_tributario || {}, realDesde = rt.regime === 'lucro_real' ? (rt.desde || '0000-00') + '-01' : null;
    const taxaItem = (a, b) => {
        if (!a) return impostoPct;
        let r = a.efetiva;
        if (b ? b.st : snCfg.icms_st) r -= a.partes.icms || 0;
        if (b ? b.monofasico : snCfg.monofasico) r -= (a.partes.pis || 0) + (a.partes.cofins || 0);
        return r;
    };
    const meses = lerMeses(de, ate);
    const pedidos = [];
    for (const { d } of meses) {
        if (!d) continue;
        const vistos = new Set();
        for (const o of d.pedidos) {
            if (vistos.has(o.id)) continue; vistos.add(o.id);   // mes coletado antes da correcao pode ter pedido repetido
            const dia = diaBR(o.data); if (dia < de || dia > ate) continue;
            const todos = o.pagamentos.map(p => ({ ...p, ...(d.pagamentos[p.id] || {}) }));
            // so os pagamentos que valeram (tentativa recusada/cancelada fica de fora: liquido zero e sem cobranca)
            const pgs = todos.some(p => !['rejected', 'cancelled'].includes(p.status)) ? todos.filter(p => !['rejected', 'cancelled'].includes(p.status)) : todos;
            const total = pgs.reduce((s, p) => s + Number(p.total || 0), 0) || 1;
            const coberto = pgs.some(p => /covered/.test(p.detalhe || ''));
            const devolvido = coberto ? 0 : pgs.reduce((s, p) => s + Number(p.devolvido || 0), 0);
            const est = !coberto && devolvido >= total - 0.01;   // estornado: o ML devolve tarifa e frete e o produto volta
            const liquidoMP = pgs.length && pgs.every(p => p.liquido != null) ? r2(pgs.reduce((s, p) => s + Number(p.liquido), 0)) : null;
            const env = envios[o.envio] || null;
            // cobrancas do Mercado Pago (quando todos os pagamentos do pedido ja foram lidos com o detalhe)
            const cob = pgs.length && pgs.every(p => p.cobrancas) ? pgs.reduce((a, p) => { for (const k in p.cobrancas) a[k] = (a[k] || 0) + p.cobrancas[k]; return a; }, {}) : null;
            const nota = fis.notaDo(o.id, o.pack), x = nota && nota.xml;
            const nm = notasML[o.id] && notasML[o.id].numero ? notasML[o.id] : null;   // nota no ML (vale mais que a do Olist: cobre todos os pedidos)
            let custo = 0, semCusto = false, credIcmsNota = 0, notaTodos = true;
            const cred = Object.fromEntries(IMPOSTOS.map(k => [k, 0])); let importTax = 0;
            const produtos = o.itens.map(i => {
                const c = P.custoDoSku(i.sku); if (!c) semCusto = true; else custo += c.valor * i.qtd;
                const f = fis.skus[i.sku] || fis.skus[String(i.sku).toUpperCase()] || null;
                // ICMS da nota de compra (dataSeven): so vale como credito na simulacao do Lucro Real (no Simples nao ha credito)
                if (f && f.icms_unit != null) credIcmsNota += f.icms_unit * i.qtd; else notaTodos = false;
                if (f) { for (const k of IMPOSTOS) cred[k] += (Number(f[k.toLowerCase()]) || 0) * i.qtd; importTax += (Number(f.importacao) || 0) * i.qtd; }
                const b = FP.regra(i.sku, fontesFiscais), ok = b && !b.sem_regra;
                return { sku: i.sku, nome: i.titulo, quantidade: i.qtd, preco: i.valor, custo_unit: c ? c.valor : null, item_id: i.item_id,
                    fiscal: ok ? { ncm: b.ncm, origem: b.origem, importado: b.importado, st: b.st, monofasico: b.monofasico, pis: b.pis, cofins: b.cofins, aliq_interna: b.aliq_interna, fonte: b.fonte } : null,
                    fiscal_fonte: b ? b.fonte : 'sem regra', ncm: b ? b.ncm : null,
                    cred_icms_nota: f && f.icms_unit != null ? r2(f.icms_unit * i.qtd) : null };
            });
            const z = (v) => est ? 0 : r2(v);
            // venda
            const valueWithoutDiscount = r2(o.itens.reduce((s, i) => s + i.valor * i.qtd, 0));
            // desconto do vendedor = o cupom que o MP cobrou da loja (coupon_fee). O cupom do pedido pode ser bancado pelo
            // proprio ML (coupon_code ml>payer, parte do vendedor 0): esse nao sai do bolso da loja. Sem o MP lido, fica o do pedido.
            const salesDiscount = r2(-(cob ? cob.cupom : (o.cupom || 0))), devolucao = r2(-devolvido);
            const valueWithDiscount = r2(valueWithoutDiscount + salesDiscount + devolucao);
            // frete recebido: o que o comprador pagou de frete (entra no pagamento do MP e o MP desconta junto com o frete)
            const receivedFreight = est ? 0 : cob ? r2(cob.frete_comprador || 0) : r2(env ? env.comprador || 0 : 0), saleSt = z(x ? x.st : 0), saleIpi = z(x ? x.ipi : 0);
            const totalSale = r2(valueWithDiscount + receivedFreight + saleSt + saleIpi);
            // comissao e frete
            // rebate da comissao: na campanha bancada em parte pelo ML (funding_mode sale_fee), a parte do ML volta como desconto na tarifa
            const rebate = (o.descontos || []).filter(d => d.modo === 'sale_fee').reduce((s, d) => s + Math.max(0, d.total - d.loja), 0);
            const allCommissionValue = z(-(o.itens.reduce((s, i) => s + i.tarifa * i.qtd, 0) + rebate)), rebateCommissionValue = z(rebate);
            const commission = r2(allCommissionValue + rebateCommissionValue), bonusValue = 0;
            // como o GeFinance: o desconto do ML no frete ja vem embutido no custo do envio (nao vira rebate)
            const shippingRebate = z(env ? env.compensacao || 0 : 0);   // compensacao do ML no frete
            // frete pago = parte do vendedor + parte do comprador; a diferenca do frete fica = -parte do vendedor
            const paidFreight = z(env ? -(env.vendedor + receivedFreight) : 0);
            const freightDifference = r2(receivedFreight + paidFreight + shippingRebate);
            // impostos
            const BASE = base === 'pedido' ? totalSale : valueWithDiscount;
            const nf = nm || x;   // impostos destacados na NF-e (ML; senao o XML do Olist)
            const deb = { Ipi: nf ? nf.ipi : 0, Pis: nf ? nf.pis : 0, Cofins: nf ? nf.cofins : 0, Icms: nf ? nf.icms : 0, St: nf ? nf.st : 0, Difal: nf ? nf.difal : 0 };
            const simples = nm ? (nm.simples || (nm.itens || []).some(i => i.csosn) || !(nm.icms > 0)) : (!x || x.crt === 1 || x.crt === 2);   // CSOSN so existe no Simples   // Simples Nacional (ou sem nota: estimativa pelo DAS)
            // DAS item a item (proporcional ao valor de cada produto no pedido), separado por imposto: o PIS, a COFINS e o
            // ICMS que estao dentro do DAS vao para as colunas de debito; IRPJ + CSLL + CPP ficam na coluna Simples (DAS)
            const aMes = aliqDo(dia);
            const dasP = { pis: 0, cofins: 0, icms: 0, resto: 0 };
            if (valueWithoutDiscount) for (const it of produtos) {
                const v = BASE * (it.preco * it.quantidade / valueWithoutDiscount), fz = it.fiscal;
                if (!aMes) { dasP.resto += v * impostoPct / 100; continue; }
                const st = fz ? fz.st : snCfg.icms_st, mono = fz ? fz.monofasico : snCfg.monofasico, pt = aMes.partes || {};
                if (!mono) { dasP.pis += v * (pt.pis || 0) / 100; dasP.cofins += v * (pt.cofins || 0) / 100; }
                if (!st) dasP.icms += v * (pt.icms || 0) / 100;
                dasP.resto += v * ((pt.irpj || 0) + (pt.csll || 0) + (pt.cpp || 0)) / 100;
            }
            const das = dasP.pis + dasP.cofins + dasP.icms + dasP.resto;
            const aliqDas = BASE ? r4(das / BASE * 100) : (aMes ? aMes.aplicada : impostoPct);
            if (simples) { deb.Pis += dasP.pis; deb.Cofins += dasP.cofins; deb.Icms += dasP.icms; }
            const linhaImp = {};
            for (const k of IMPOSTOS) { linhaImp['debit' + k] = z(deb[k]); linhaImp['credit' + k] = z(cred[k]); }
            const debitTotal = r2(IMPOSTOS.reduce((s, k) => s + linhaImp['debit' + k], 0));
            const creditTotal = r2(IMPOSTOS.reduce((s, k) => s + linhaImp['credit' + k], 0));
            const simplesDas = z(simples ? dasP.resto : 0);
            const tax = r2(debitTotal + simplesDas - creditTotal);
            const gift = z(brinde), pkg = z(embalagem);
            const totalCost = z(custo);
            const liquidValue = r2(BASE + commission + freightDifference - tax - gift - pkg);
            const margin = semCusto && !est ? null : r2(liquidValue - totalCost);
            pedidos.push({
                id: o.id, date: o.data, dia, requestNumberEcommerce: o.id, ecommerceNumber: o.pack || o.id, client: o.cliente || '',
                invoiceNumberWithSerie: nm ? `${Number(nm.numero)}-${nm.serie}` : nota ? `${Number(nota.numero)}-${nota.serie}` : null, nota_situacao: nm ? nm.status : nota ? nota.situacao : null,
                nota_fonte: nm ? 'ML' : nota ? 'Olist' : null, nota_crt: x ? x.crt : null, nota_tot_trib: nm ? nm.tot_trib : x ? x.tot_trib : null, debitos_do_das: simples,
                salesChannel: canal(), city: env && env.cidade || '', state: env && env.uf || '', shippingMethod: env ? (LOG[env.logistica] || env.logistica || '—') : '—',
                status: est ? 'Devolvido' : env && env.status ? (STATUS[env.status] || env.status) : '—',
                products: produtos, totalCost, productionCost: totalCost, sem_custo: semCusto && !est, sem_frete: !env && !est,
                ...Object.fromEntries(IMPOSTOS.map(k => ['credit' + k, linhaImp['credit' + k]])), creditTotal,
                valueWithoutDiscount, salesDiscount, devolucao, valueWithDiscount, receivedFreight, saleSt, saleIpi, totalSale,
                financialTransfer: liquidoMP != null ? liquidoMP : r2(totalSale + commission + freightDifference + bonusValue), repasse_do_mp: liquidoMP != null,
                repasse_mp: liquidoMP, repasse_esperado: cob ? r2(valueWithDiscount + receivedFreight + commission - cob.frete - cob.juros - cob.outros) : r2(totalSale + commission + freightDifference + bonusValue),
                credito_icms_nota: notaTodos && !est ? r2(credIcmsNota) : null, base_trib_itens: produtos.filter(x => x.fiscal).length,
                mp_cobrancas: cob, frete_fora: cob && !est && env ? r2(Math.max(0, env.vendedor - (cob.frete - receivedFreight))) : null, pagamento_liberacao: pgs.map(p => p.liberacao).filter(Boolean).join(',') || null, pagamento_liberacao_data: pgs.map(p => p.liberacao_data).filter(Boolean).sort().pop() || null,
                mp_liberado: pgs.length > 0 && pgs.every(p => p.liberacao === 'released'),
                nota_valor: nm ? nm.valor : nota ? nota.valor : null, nota_emissao: nm ? String(nm.emitida || '').slice(0, 10) : nota ? nota.emissao : null, pedido_pago_status: pgs.map(p => p.status).join(','),
                allCommissionValue, rebateCommissionValue, commission, bonusValue, paidFreight, shippingRebate, freightDifference,
                ...Object.fromEntries(IMPOSTOS.map(k => ['debit' + k, linhaImp['debit' + k]])), debitTotal, simplesDas, importTax: z(importTax),
                tax, aliquota_das: aliqDas, imposto_origem: est ? null : (nm || x) ? 'nota' : 'estimado', gift, package: pkg, liquidValue, margin,
                costPercentage: margin == null || !totalCost ? null : r2(margin / totalCost * 100),
                salePercentage: margin == null || !BASE ? null : r2(margin / BASE * 100),
            });
        }
    }
    pedidos.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    // uma NF-e pode cobrir o pacote inteiro (varios pedidos): a venda que a nota deve ter e a soma dos pedidos dela
    const porNF = {};
    for (const p of pedidos) if (p.invoiceNumberWithSerie) porNF[p.invoiceNumberWithSerie] = r2((porNF[p.invoiceNumberWithSerie] || 0) + p.valueWithoutDiscount + p.salesDiscount);
    for (const p of pedidos) p.venda_da_nota = p.invoiceNumberWithSerie ? porNF[p.invoiceNumberWithSerie] : null;
    // simulacao do Lucro Real (laboratorio): guarda o resultado do Simples para comparar e recalcula os impostos
    // Lucro Real: na conta que esta nele (config), vale para os pedidos a partir da data de inicio, com as regras da Base
    // tributaria por SKU e por UF; 'real' simula o periodo inteiro (laboratorio). O resultado do Simples fica guardado para comparar.
    let lucroReal = null;
    const oficial = regime === 'auto' && realDesde, noReal = (p) => regime === 'real' || (oficial && p.dia >= realDesde);
    if (regime === 'real' || oficial) {
        const alvo = pedidos.filter(noReal);
        if (alvo.length) {
            const comM = alvo.filter(p => p.margin != null);
            const simples = { tax: r2(alvo.reduce((s, p) => s + p.tax, 0)), margin: r2(comM.reduce((s, p) => s + p.margin, 0)) };
            const dias = Math.round((new Date(ate) - new Date(alvo.reduce((m, p) => p.dia < m ? p.dia : m, ate))) / 86400000) + 1;
            // SKU sem regra na base: no oficial assume o caso geral (ICMS proprio, PIS/COFINS nao cumulativo), nao a ST
            const r = require('./finance_lucro_real').aplicar(alvo, base, { ...(oficial ? { cenario: 'normal' } : {}), ...(rt.opcoes || {}), ...opcoes }, dias);
            const porId = new Map(r.pedidos.map(p => [p.id, { ...p, imposto_origem: oficial ? 'base tributária' : 'simulado' }]));
            pedidos.splice(0, pedidos.length, ...pedidos.map(p => porId.get(p.id) || p));
            lucroReal = { ...r.resumo, simples, dias, oficial: !!oficial, desde: oficial ? rt.desde : null, pedidos: alvo.length };
        }
    }
    const regimeEfetivo = regime === 'real' ? 'real' : oficial && lucroReal ? 'lucro_real' : 'simples';
    // configuracao fiscal por produto: cada SKU do periodo e de onde veio a regra (base, NCM ou sem regra)
    const fiscalSkus = {};
    for (const p of pedidos) for (const it of p.products) {
        const k = String(it.sku || '').trim() || '(sem SKU)', x = (fiscalSkus[k] ||= { sku: k, nome: it.nome, ncm: it.ncm, fonte: it.fiscal_fonte, fiscal: it.fiscal, pedidos: 0, unidades: 0, venda: 0 });
        x.pedidos++; x.unidades += it.quantidade; x.venda = r2(x.venda + it.preco * it.quantidade);
    }
    const soma = (k) => r2(pedidos.reduce((s, p) => s + (Number(p[k]) || 0), 0));
    const comMargem = pedidos.filter(p => p.margin != null);
    const tot = { pedidos: pedidos.length, sem_custo: pedidos.filter(p => p.sem_custo).length, devolvidos: pedidos.filter(p => p.status === 'Devolvido').length,
        com_nota: pedidos.filter(p => p.imposto_origem === 'nota').length, imposto_estimado: pedidos.filter(p => p.imposto_origem === 'estimado').length };
    for (const k of Object.keys(pedidos[0] || {})) if (typeof pedidos[0][k] === 'number' && !['costPercentage', 'salePercentage', 'nota_crt', 'nota_tot_trib', 'aliquota_das', 'repasse_mp', 'nota_valor', 'frete_fora'].includes(k)) tot[k] = soma(k);
    tot.margin = r2(comMargem.reduce((s, p) => s + p.margin, 0));
    const custoComMargem = r2(comMargem.reduce((s, p) => s + p.totalCost, 0)), baseComMargem = r2(comMargem.reduce((s, p) => s + (base === 'pedido' ? p.totalSale : p.valueWithDiscount), 0));
    tot.costPercentage = custoComMargem ? r2(tot.margin / custoComMargem * 100) : null;
    tot.salePercentage = baseComMargem ? r2(tot.margin / baseComMargem * 100) : null;
    const aliquotas = Object.fromEntries(Object.entries(aliqMes).map(([m, a]) => [m, a ? { aplicada: a.aplicada, efetiva: a.efetiva, rbt12: a.rbt12, faixa: a.faixa, tirou: a.tirou } : null]));
    return { de, ate, base, regime: regimeEfetivo, regime_conta: rt.regime === 'lucro_real' ? { regime: 'lucro_real', desde: rt.desde } : { regime: 'simples' }, lucro_real: lucroReal,
        config_fiscal: Object.values(fiscalSkus).sort((a, b) => b.venda - a.venda), imposto_pct: impostoPct, aliquotas_simples: aliquotas, simples_auto: snCfg.auto, brinde, embalagem, canal: canal(),
        fiscal: { notas: fis.notas, atualizado_em: fis.atualizado_em },
        meses: meses.map(({ mes, d }) => ({ mes, coletado: !!d, atualizado_em: d ? d.atualizado_em : null, ate: d ? d.ate : null })),
        totais: tot, pedidos };
}

// atualiza do ML os meses do periodo (um de cada vez, com a coleta do Finance) e depois as NF-e do Olist
const est = { rodando: false, mes: null, fila: [], erro: null, aviso: null };
function atualizar({ de, ate }) {
    if (est.rodando) return { ok: false, erro: 'Já está atualizando.' };
    const F = require('./finance');
    if (F.estado.rodando) return { ok: false, erro: 'O Finance já está coletando um mês. Espere terminar.' };
    const fila = mesesEntre(de, ate);
    Object.assign(est, { rodando: true, fila: [...fila], erro: null, aviso: null });
    (async () => {
        try {
            for (const mes of fila) {
                est.mes = mes;
                const r = await F.coletar(mes, {});
                if (r && r.ok === false) throw new Error(r.erro);
                while (F.estado.rodando) await new Promise(res => setTimeout(res, 1500));
                if (F.estado.erro) throw new Error(F.estado.erro);
                est.fila = est.fila.filter(m => m !== mes);
            }
            est.mes = 'notas';
            const ids = lerMeses(de, ate).flatMap(({ d }) => d ? d.pedidos.filter(o => { const x = diaBR(o.data); return x >= de && x <= ate; }).flatMap(o => [o.id, o.pack].filter(Boolean)) : []);
            const r = await FISCAL.coletar({ de, ate, pedidos: ids });
            if (!r.ok) est.aviso = 'Notas fiscais do Olist: ' + r.erro;
        } catch (e) { est.erro = e.message; }
        finally { est.rodando = false; est.mes = null; }
    })();
    return { ok: true };
}
function estado() { return { ...est, finance: { ...require('./finance').estado }, fiscal: { ...FISCAL.estado } }; }

// brinde e embalagem por pedido (R$)
function configurar({ brinde, embalagem, regime, desde }) {
    const arq = path.join(STORAGE(), 'config.json'), c = lerJson(arq, {});
    // regime tributario da conta: Lucro Real a partir de um mes (os pedidos antes continuam no Simples)
    if (regime === 'lucro_real') { if (!/^\d{4}-\d{2}$/.test(desde || '')) throw new Error('Informe o mês de início do Lucro Real.'); c.regime_tributario = { ...(c.regime_tributario || {}), regime: 'lucro_real', desde }; }
    else if (regime === 'simples') c.regime_tributario = { regime: 'simples' };
    if (brinde != null) c.planilha_brinde = Math.max(0, Number(brinde) || 0);
    if (embalagem != null) c.planilha_embalagem = Math.max(0, Number(embalagem) || 0);
    fs.writeFileSync(arq, JSON.stringify(c, null, 2));
    return { ok: true, brinde: c.planilha_brinde || 0, embalagem: c.planilha_embalagem || 0, regime_tributario: c.regime_tributario || { regime: 'simples' } };
}

module.exports = { planilha, atualizar, estado, configurar };
