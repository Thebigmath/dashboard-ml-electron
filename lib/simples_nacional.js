// Aliquota efetiva do Simples Nacional (19/10/2026): no lugar dos 7% fixos, o imposto da Planilha avancada passa a
// ser a aliquota EFETIVA do mes, calculada como a Receita calcula (LC 123/2006, Anexo I - comercio):
//   RBT12 ............ receita bruta dos 12 meses ANTERIORES ao mes (vendas do ML sem cancelados; com a opcao, soma a
//                      outra conta do SEVEN quando for o mesmo CNPJ, e outras receitas informadas)
//   efetiva .......... (RBT12 x aliquota nominal da faixa - parcela a deduzir) / RBT12
//   ICMS-ST .......... produto com ICMS ja recolhido por substituicao (CSOSN 500 nas notas): a parte do ICMS sai do DAS
//   monofasico ....... autopecas com PIS/COFINS monofasico (Lei 10.485/2002): a parte do PIS/COFINS sai do DAS
//                      (desligado por padrao: quem confirma o NCM de cada produto e o contador)
// O faturamento de cada mes fechado fica em STORAGE/simples_faturamento.json (mes fechado nao muda; o atual e relido).
const fs = require('fs');
const path = require('path');

const STORAGE = () => process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ARQ = () => path.join(STORAGE(), 'simples_faturamento.json');
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const r4 = (v) => Math.round(Number(v || 0) * 10000) / 10000;

// Anexo I (comercio): ate, aliquota nominal %, parcela a deduzir R$, partilha do DAS em %
const ANEXO_I = [
    { ate: 180000, nominal: 4, deduzir: 0, partilha: { irpj: 5.5, csll: 3.5, cofins: 12.74, pis: 2.76, cpp: 41.5, icms: 34 } },
    { ate: 360000, nominal: 7.3, deduzir: 5940, partilha: { irpj: 5.5, csll: 3.5, cofins: 12.74, pis: 2.76, cpp: 41.5, icms: 34 } },
    { ate: 720000, nominal: 9.5, deduzir: 13860, partilha: { irpj: 5.5, csll: 3.5, cofins: 12.74, pis: 2.76, cpp: 42, icms: 33.5 } },
    { ate: 1800000, nominal: 10.7, deduzir: 22500, partilha: { irpj: 5.5, csll: 3.5, cofins: 12.74, pis: 2.76, cpp: 42, icms: 33.5 } },
    { ate: 3600000, nominal: 14.3, deduzir: 87300, partilha: { irpj: 5.5, csll: 3.5, cofins: 12.74, pis: 2.76, cpp: 42, icms: 33.5 } },
    { ate: 4800000, nominal: 19, deduzir: 378000, partilha: { irpj: 13.5, csll: 10, cofins: 28.27, pis: 6.13, cpp: 42.1, icms: 0 } },
];
const PADRAO = { auto: true, somar_outra_conta: false, outras_receitas_mes: 0, icms_st: true, monofasico: false };

const mesAnt = (mes, n) => { const [a, m] = mes.split('-').map(Number); const d = new Date(Date.UTC(a, m - 1 - n, 1)); return d.toISOString().slice(0, 7); };
const fimDoMes = (mes) => { const [a, m] = mes.split('-').map(Number); return new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10); };
const hojeBR = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);

function config() { return { ...PADRAO, ...(lerJson(path.join(STORAGE(), 'config.json'), {}).simples || {}) }; }
function configurar(novo) {
    const arq = path.join(STORAGE(), 'config.json'), c = lerJson(arq, {});
    const s = { ...PADRAO, ...(c.simples || {}) };
    for (const k of Object.keys(PADRAO)) if (novo[k] !== undefined) s[k] = typeof PADRAO[k] === 'number' ? Math.max(0, Number(novo[k]) || 0) : !!novo[k];
    c.simples = s; fs.writeFileSync(arq, JSON.stringify(c, null, 2));
    return s;
}

// faturamento da outra conta do SEVEN (o arquivo que o outro Dashboard grava)
function outraConta() {
    const app = path.basename(path.dirname(STORAGE()));
    const outro = app === 'dashboard-cordeiro' ? 'dashboard-ml' : 'dashboard-cordeiro';
    return { nome: outro === 'dashboard-cordeiro' ? 'Cordeiro' : 'Flavia', dados: lerJson(path.join(path.dirname(path.dirname(STORAGE())), outro, 'storage', 'simples_faturamento.json'), null) };
}

// le do ML o faturamento dos 13 meses anteriores + o mes atual (RBT12 do mes atual e do mes passado) (mes fechado ja lido nao volta a ser buscado)
const estado = { rodando: false, feito: 0, total: 0, mes: null, erro: null };
function coletar() {
    if (estado.rodando) return { ok: false, erro: 'Já está lendo o faturamento.' };
    const atual = hojeBR().slice(0, 7);
    const meses = Array.from({ length: 14 }, (_, i) => mesAnt(atual, 13 - i));   // 13 meses + o atual: da para calcular tambem o mes passado
    const D = lerJson(ARQ(), { porMes: {} });
    const faltam = meses.filter(m => m === atual || !D.porMes[m] || !D.porMes[m].fechado);
    Object.assign(estado, { rodando: true, feito: 0, total: faltam.length, erro: null });
    (async () => {
        try {
            const inicio = require('./inicio');
            for (const m of faltam) {
                estado.mes = m;
                const ate = m === atual ? hojeBR() : fimDoMes(m);
                const r = await inicio.faturamento(m + '-01', ate);
                D.porMes[m] = { valor: r.valor, pedidos: r.pedidos, fechado: m !== atual, lido_em: new Date().toISOString() };
                D.atualizado_em = new Date().toISOString();
                fs.writeFileSync(ARQ(), JSON.stringify(D, null, 1));
                estado.feito++;
            }
        } catch (e) { estado.erro = e.message; }
        finally { estado.rodando = false; estado.mes = null; }
    })();
    return { ok: true };
}

// aliquota efetiva do mes (null quando faltam meses para o RBT12)
function aliquota(mes, cfg = config()) {
    const D = lerJson(ARQ(), { porMes: {} }), O = cfg.somar_outra_conta ? outraConta() : null;
    const anteriores = Array.from({ length: 12 }, (_, i) => mesAnt(mes, i + 1));
    const faltam = anteriores.filter(m => !D.porMes[m] || (O && (!O.dados || !O.dados.porMes[m])));
    const porMes = anteriores.map(m => ({ mes: m, propria: D.porMes[m] ? D.porMes[m].valor : null, outra: O && O.dados && O.dados.porMes[m] ? O.dados.porMes[m].valor : null, outras: cfg.outras_receitas_mes }));
    if (faltam.length) return { mes, completo: false, faltam, porMes };
    const rbt12 = r2(porMes.reduce((s, x) => s + x.propria + (x.outra || 0) + (x.outras || 0), 0));
    const f = ANEXO_I.find(x => rbt12 <= x.ate) || ANEXO_I[ANEXO_I.length - 1];
    const efetiva = rbt12 > 0 ? Math.max(0, (rbt12 * f.nominal / 100 - f.deduzir) / rbt12 * 100) : ANEXO_I[0].nominal;
    // partes do DAS em % da receita. Na 6a faixa a tabela nao tem ICMS: enquanto a empresa ainda recolhe o ICMS no
    // Simples (ano em que passou do sublimite), o ICMS e calculado pela 5a faixa: (RBT12 x 14,3% - 87.300) / RBT12 x 33,5%.
    const partes = {};
    for (const [k, v] of Object.entries(f.partilha)) partes[k] = efetiva * v / 100;
    if (ANEXO_I.indexOf(f) === 5) { const f5 = ANEXO_I[4]; partes.icms = (rbt12 * f5.nominal / 100 - f5.deduzir) / rbt12 * 100 * f5.partilha.icms / 100; }
    const total = Object.values(partes).reduce((s, v) => s + v, 0);
    let aplicada = total; const tirou = [];
    if (cfg.icms_st && partes.icms) { aplicada -= partes.icms; tirou.push(`ICMS (${partes.icms.toFixed(2).replace('.', ',')}% da receita, já pago por ST)`); }
    if (cfg.monofasico) { aplicada -= partes.pis + partes.cofins; tirou.push(`PIS/COFINS (${(partes.pis + partes.cofins).toFixed(2).replace('.', ',')}% da receita, monofásico)`); }
    return { mes, completo: true, rbt12, faixa: ANEXO_I.indexOf(f) + 1, nominal: f.nominal, deduzir: f.deduzir, efetiva: r4(total), efetiva_federal: r4(efetiva), aplicada: r4(aplicada), tirou, partilha: f.partilha, partes: Object.fromEntries(Object.entries(partes).map(([k, v]) => [k, r4(v)])),
        sublimite_icms: rbt12 > 3600000, outra_conta: O ? O.nome : null, porMes };
}

function resumo() {
    const cfg = config(), atual = hojeBR().slice(0, 7), D = lerJson(ARQ(), { porMes: {} }), O = outraConta();
    const meses = Array.from({ length: 4 }, (_, i) => mesAnt(atual, 3 - i)).map(m => aliquota(m, cfg));
    return { config: cfg, atual: aliquota(atual, cfg), meses, faturamento: D.porMes, atualizado_em: D.atualizado_em || null,
        outra_conta: { nome: O.nome, tem_dados: !!O.dados, meses: O.dados ? Object.keys(O.dados.porMes).length : 0 },
        com_outra_conta: aliquota(atual, { ...cfg, somar_outra_conta: true }), so_esta_conta: aliquota(atual, { ...cfg, somar_outra_conta: false }),
        coleta: { ...estado } };
}

module.exports = { ANEXO_I, aliquota, coletar, resumo, config, configurar, estado };
