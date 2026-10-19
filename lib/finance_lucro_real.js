// Simulacao "e se fossemos do Lucro Real?" na Planilha avancada (19/10/2026, laboratorio). Recalcula os impostos de
// cada pedido como se a empresa saisse do Simples Nacional (DAS) e fosse para o Lucro Real. E uma SIMULACAO para
// decisao: as aliquotas sao as gerais e editaveis; a palavra final e do contador.
// Regras por SKU e por UF vem da Base tributaria do contador (lib/base_tributaria.js) quando o SKU esta nela:
//   ST, monofasico (CST 04: PIS/COFINS zero e sem credito), importado (4% interestadual) e a tabela de DIFAL por UF.
//   PIS/COFINS (nao cumulativo) ... debito 1,65% + 7,6% sobre a venda SEM o ICMS (Tema 69 do STF)
//                                     credito 1,65% + 7,6% sobre o custo da mercadoria e o frete pago na venda
//   ICMS (empresa em SP) .......... cenario "st": produto com ST ja paga na compra (como nas notas de hoje, CSOSN 500)
//                                     -> sem debito/credito de ICMS proprio
//                                   cenario "normal": debito pela aliquota (SP 18% dentro do estado; 12% para S/SE;
//                                     7% para N/NE/CO/ES; 4% importado) e credito do ICMS da compra (icms_credito_pct)
//   DIFAL ......................... venda para consumidor final de outro estado: (aliquota interna do destino -
//                                     interestadual) x valor (EC 87/2015), nos dois cenarios
//   IRPJ/CSLL ..................... sobre o lucro do periodo: IRPJ 15% + adicional 10% do que passar de R$ 20 mil/mes,
//                                     CSLL 9%. Aqui a base e a soma das margens (sem ADS e custos fixos, que reduziriam o IR).
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const SUL_SUDESTE = ['MG', 'RJ', 'PR', 'SC', 'RS'];
// aliquota interna (modal + FCP) por UF — tabela geral de 2026 para simular; conferir com o contador
const INTERNA = { AC: 19, AL: 20, AM: 20, AP: 18, BA: 20.5, CE: 20, DF: 20, ES: 17, GO: 19, MA: 23, MG: 18, MS: 17, MT: 17, PA: 19,
    PB: 20, PE: 20.5, PI: 22.5, PR: 19.5, RJ: 22, RN: 20, RO: 19.5, RR: 20, RS: 17, SC: 17, SE: 19, SP: 18, TO: 20 };
const PADRAO = { cenario: 'st', pis: 1.65, cofins: 7.6, icms_credito_pct: 12, credito_frete: true, importado: false, difal: true, irpj: 15, irpj_adicional: 10, adicional_acima_mes: 20000, csll: 9 };

function interestadual(uf, o) { if (o.importado) return 4; return SUL_SUDESTE.includes(uf) ? 12 : 7; }

// recalcula as colunas fiscais de cada pedido (copia) e devolve o resumo com IRPJ/CSLL
function aplicar(pedidos, base, opcoes = {}, dias = 30) {
    const o = { ...PADRAO, ...opcoes };
    const L = pedidos.map(p0 => {
        const p = { ...p0 };
        if (p.status === 'Devolvido') return p;
        const venda = p.valueWithDiscount, uf = p.state || 'SP', dentro = uf === 'SP';
        // item a item: regra do SKU na Base tributaria (ST, monofasico, importado, PIS/COFINS) e a tabela de UF da base
        const BT = require('./base_tributaria'), U = BT.daUF(uf), bruto = p.products.reduce((s, x) => s + x.preco * x.quantidade, 0) || 1;
        let icms = 0, difal = 0, credIcms = 0, pis = 0, cofins = 0, credPis = 0, credCofins = 0;
        const freteParte = o.credito_frete ? -p.paidFreight : 0;
        for (const it of p.products) {
            const fr = it.preco * it.quantidade / bruto, v = venda * fr, fz = it.fiscal || {};
            const custoIt = (it.custo_unit || 0) * it.quantidade;
            const temSt = it.fiscal ? fz.st : o.cenario === 'st';
            const imp = fz.importado != null ? fz.importado : o.importado;
            let ic = 0;
            if (!temSt) {
                const aliq = dentro ? (fz.aliq_interna || (U && U.interna) || INTERNA.SP) : (U ? (imp ? U.inter_importado : U.inter_nacional) : interestadual(uf, { importado: imp }));
                ic = v * aliq / 100;
                credIcms += it.cred_icms_nota != null ? it.cred_icms_nota : custoIt * o.icms_credito_pct / 100;   // credito real da nota de compra (dataSeven) quando tem
            }
            icms += ic;
            if (o.difal && !dentro) difal += v * (U ? (imp ? U.difal_importado : U.difal_nacional) || 0 : Math.max(0, (INTERNA[uf] || 18) - interestadual(uf, { importado: imp }))) / 100;
            if (!fz.monofasico) {   // monofasico (CST 04): revenda a aliquota zero e sem credito
                const ap = fz.pis != null ? fz.pis : o.pis, ac = fz.cofins != null ? fz.cofins : o.cofins, bc = Math.max(0, v - ic), bcc = custoIt + freteParte * fr;
                pis += bc * ap / 100; cofins += bc * ac / 100; credPis += bcc * ap / 100; credCofins += bcc * ac / 100;
            }
        }
        Object.assign(p, {
            debitIpi: 0, debitSt: 0, debitIcms: r2(icms), debitDifal: r2(difal), debitPis: r2(pis), debitCofins: r2(cofins),
            creditIpi: 0, creditSt: 0, creditDifal: 0, creditIcms: r2(credIcms), creditPis: r2(credPis), creditCofins: r2(credCofins),
            simplesDas: 0, imposto_origem: 'simulado',
        });
        p.debitTotal = r2(p.debitIpi + p.debitPis + p.debitCofins + p.debitIcms + p.debitSt + p.debitDifal);
        p.creditTotal = r2(p.creditIpi + p.creditPis + p.creditCofins + p.creditIcms + p.creditSt + p.creditDifal);
        p.tax = r2(p.debitTotal - p.creditTotal);
        const BASE = base === 'pedido' ? p.totalSale : p.valueWithDiscount;
        p.liquidValue = r2(BASE + p.commission + p.freightDifference - p.tax - p.gift - p.package);
        p.margin = p.sem_custo ? null : r2(p.liquidValue - p.totalCost);
        p.costPercentage = p.margin == null || !p.totalCost ? null : r2(p.margin / p.totalCost * 100);
        p.salePercentage = p.margin == null || !BASE ? null : r2(p.margin / BASE * 100);
        return p;
    });
    const lucro = r2(L.filter(p => p.margin != null).reduce((s, p) => s + p.margin, 0));
    const meses = dias / 30, tributavel = Math.max(0, lucro);
    const irpj = r2(tributavel * o.irpj / 100 + Math.max(0, tributavel - o.adicional_acima_mes * meses) * o.irpj_adicional / 100);
    const csll = r2(tributavel * o.csll / 100);
    return { pedidos: L, resumo: { opcoes: o, lucro_antes_ir: lucro, irpj, csll, lucro_depois_ir: r2(lucro - irpj - csll), interna: INTERNA } };
}

module.exports = { aplicar, PADRAO, INTERNA };
