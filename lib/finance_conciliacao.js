// Conciliacao entre as APIs (19/10/2026), no modelo da Escalada de Prata:
//   1. MOTOR (regras fixas, sem IA) confere cada pedido do Mercado Livre em 4 trilhas e marca ok / aguardando / divergente
//        ML x Mercado Pago ... o liquido que caiu no MP bate com o esperado (venda + comissao + diferenca do frete)?
//        ML x NF-e (Olist) ... o pedido tem nota autorizada e o valor da nota bate com o valor dos produtos?
//                              (notas pelo Olist so a partir de 13/10/2026: antes eram do Bling e ficam "fora")
//        Pedido x envio ...... o envio foi lido (frete pago, cidade, status)?
//        SKU x custo ......... todos os produtos do pedido tem custo na planilha?
//   2. IA (agente fin_conciliacao do Complexo) recebe SO as excecoes: explica a causa provavel e sugere a acao.
//   3. VOCE decide. Nada e alterado no ML, no MP ou no Olist: a conciliacao so le (reversivel por natureza).
// Toda rodada fica registrada em STORAGE/conciliacao_log.json (metricas da escalada: taxa de delegacao = pedidos
// resolvidos pelo motor sem precisar de ninguem).
const fs = require('fs');
const path = require('path');
const PL = require('./finance_planilha');

const STORAGE = () => process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ARQ_LOG = () => path.join(STORAGE(), 'conciliacao_log.json');
const ARQ_IA = () => path.join(STORAGE(), 'conciliacao_ia.json');
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
const gravarJson = (arq, o) => fs.writeFileSync(arq, JSON.stringify(o, null, 1));
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const INICIO_OLIST = '2026-10-13';
const TOL = 0.10;   // tolerancia de centavos
const TRILHAS = { mp: 'ML × Mercado Pago', nfe: 'ML × NF-e (Olist)', envio: 'Pedido × envio', custo: 'SKU × custo' };

function conferir(p, hoje) {
    const idade = (new Date(hoje) - new Date(p.dia)) / 86400000;
    const dev = p.status === 'Devolvido';
    const t = {};
    // ML x Mercado Pago
    if (p.repasse_mp == null) t.mp = { s: /approved/.test(p.pedido_pago_status || '') && idade > 2 ? 'divergente' : 'aguardando', motivo: 'Pagamento ainda não lido no Mercado Pago', valor: 0 };
    else if (dev) t.mp = { s: 'ok', motivo: 'Estornado', valor: 0 };
    else {
        const d = r2(p.repasse_mp - p.repasse_esperado), cob = p.mp_cobrancas;
        const dTarifa = cob ? r2(cob.tarifa + p.allCommissionValue) : 0;   // tarifa do pedido x tarifa cobrada no MP
        if (cob && Math.abs(dTarifa) > TOL) t.mp = { s: 'divergente', motivo: `Tarifa cobrada no MP ${dTarifa > 0 ? 'maior' : 'menor'} que a do pedido`, valor: -dTarifa, detalhe: { tarifa_mp: cob.tarifa, tarifa_pedido: -p.allCommissionValue } };
        else if (Math.abs(d) > TOL) t.mp = { s: 'divergente', motivo: `Caiu ${d > 0 ? 'a mais' : 'a menos'} no MP do que o esperado`, valor: d,
            detalhe: { mp: p.repasse_mp, esperado: p.repasse_esperado, liberacao: p.pagamento_liberacao, cobrancas: cob } };
        else t.mp = p.frete_fora > TOL ? { s: 'ok', motivo: `Frete de R$ ${p.frete_fora.toFixed(2).replace('.', ',')} cobrado à parte (fora do pagamento): sai no extrato de liberações`, valor: 0, frete_fora: p.frete_fora }
            : { s: 'ok', valor: 0 };
    }
    // ML x NF-e
    if (p.dia < INICIO_OLIST) t.nfe = { s: 'fora', motivo: 'Antes de 13/10: nota emitida pelo Bling', valor: 0 };
    else if (!p.invoiceNumberWithSerie) t.nfe = dev ? { s: 'ok', motivo: 'Estornado antes da nota', valor: 0 }
        : idade <= 3 || /Pronto|Pendente|prepara/.test(p.status) ? { s: 'aguardando', motivo: 'Nota ainda não emitida (até 3 dias, no Full a nota sai depois)', valor: 0 }
        : { s: 'divergente', motivo: 'Pedido enviado sem nota no Olist', valor: p.valueWithDiscount };
    else if (dev) t.nfe = { s: 'divergente', motivo: 'Venda devolvida com nota ativa (falta nota de devolução/entrada)', valor: p.nota_valor };
    else {
        const d = r2(p.nota_valor - (p.valueWithoutDiscount + p.salesDiscount));
        t.nfe = Math.abs(d) <= TOL ? { s: 'ok', valor: 0 } : { s: 'divergente', motivo: `Valor da nota ${d > 0 ? 'maior' : 'menor'} que a venda`, valor: d,
            detalhe: { nota: p.nota_valor, venda: r2(p.valueWithoutDiscount + p.salesDiscount), nf: p.invoiceNumberWithSerie } };
    }
    // Pedido x envio
    t.envio = p.sem_frete ? { s: idade > 1 ? 'divergente' : 'aguardando', motivo: 'Envio não lido (sem frete e sem cidade)', valor: 0 } : { s: 'ok', valor: 0 };
    // SKU x custo
    t.custo = p.sem_custo ? { s: 'divergente', motivo: 'Produto sem custo na planilha: ' + p.products.filter(x => x.custo_unit == null).map(x => x.sku || '(sem SKU)').join(', '), valor: 0 } : { s: 'ok', valor: 0 };
    const ss = Object.values(t).map(x => x.s);
    return { trilhas: t, status: ss.includes('divergente') ? 'divergente' : ss.includes('aguardando') ? 'aguardando' : 'conciliado' };
}

function conciliar({ de, ate, registrar = false } = {}) {
    const P = PL.planilha({ de, ate });
    const hoje = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
    const linhas = P.pedidos.map(p => {
        const c = conferir(p, hoje);
        return { id: p.id, dia: p.dia, date: p.date, status_pedido: p.status, envio: p.shippingMethod, nf: p.invoiceNumberWithSerie, venda: p.totalSale,
            produtos: p.products.map(x => `${x.sku} x${x.quantidade}`).join(', '), ...c };
    });
    const trilhas = Object.entries(TRILHAS).map(([k, nome]) => {
        const L = linhas.map(l => l.trilhas[k]);
        const div = L.filter(x => x.s === 'divergente');
        const motivos = {}; for (const x of div) { const m = x.motivo.replace(/: .*/, ''); motivos[m] = (motivos[m] || 0) + 1; }
        return { id: k, nome, ok: L.filter(x => x.s === 'ok').length, aguardando: L.filter(x => x.s === 'aguardando').length, divergente: div.length, fora: L.filter(x => x.s === 'fora').length,
            valor: r2(div.reduce((s, x) => s + Math.abs(x.valor || 0), 0)), motivos };
    });
    const n = linhas.length, conc = linhas.filter(l => l.status === 'conciliado').length, ag = linhas.filter(l => l.status === 'aguardando').length;
    const resumo = { pedidos: n, conciliados: conc, aguardando: ag, divergentes: n - conc - ag,
        // Escalada de Prata: o motor resolve sozinho os conciliados e os que so estao aguardando o tempo normal
        taxa_delegacao: n ? r2((conc + ag) / n * 100) : null, excecoes: n - conc - ag };
    const out = { de, ate, em: new Date().toISOString(), resumo, trilhas, linhas, fiscal: P.fiscal, meses: P.meses };
    if (registrar) {
        const log = lerJson(ARQ_LOG(), []);
        log.unshift({ em: out.em, de, ate, resumo, trilhas: trilhas.map(({ id, ok, aguardando, divergente, fora, valor }) => ({ id, ok, aguardando, divergente, fora, valor })) });
        gravarJson(ARQ_LOG(), log.slice(0, 200));
    }
    return out;
}

// IA: so as excecoes, agrupadas, para o agente de conciliacao explicar e sugerir
const estIA = { rodando: false, erro: null };
function analisar({ de, ate }) {
    if (estIA.rodando) return { ok: false, erro: 'A IA já está analisando.' };
    Object.assign(estIA, { rodando: true, erro: null });
    (async () => {
        try {
            const C = conciliar({ de, ate, registrar: true });
            const ex = C.linhas.filter(l => l.status === 'divergente');
            const grupos = {};
            for (const l of ex) for (const [k, t] of Object.entries(l.trilhas)) if (t.s === 'divergente') {
                const g = (grupos[`${TRILHAS[k]} · ${t.motivo.replace(/: .*/, '')}`] ||= { qtd: 0, valor: 0, exemplos: [] });
                g.qtd++; g.valor = r2(g.valor + Math.abs(t.valor || 0));
                if (g.exemplos.length < 6) g.exemplos.push({ pedido: l.id, dia: l.dia, envio: l.envio, status: l.status_pedido, produtos: l.produtos, motivo: t.motivo, ...(t.detalhe || {}) });
            }
            const dados = { periodo: { de, ate }, resumo: C.resumo, trilhas: C.trilhas.map(({ nome, ok, aguardando, divergente, fora, valor }) => ({ nome, ok, aguardando, divergente, fora, valor_divergente: valor })), excecoes: grupos };
            const sistema = 'Você é o agente de Conciliação da área Finance de uma loja de autopeças no Mercado Livre (empresa do Simples Nacional, em SP; NF-e emitidas pelo Olist desde 13/10/2026, antes pelo Bling). '
                + 'Um motor de regras já conferiu cada pedido (Mercado Livre x Mercado Pago x NF-e do Olist x envio x planilha de custos). Você recebe SÓ as exceções. Explique a causa mais provável de cada grupo e diga a ação, quem faz (motor, financeiro, fiscal/contador, compras) e se o motor pode passar a resolver sozinho (regra nova). Nunca invente número. Português do Brasil, direto. Responda SÓ com o JSON pedido.';
            const prompt = `DADOS (JSON):\n${JSON.stringify(dados)}\n\nResponda com este JSON exato:\n{"resumo":"2 a 3 linhas com o quadro da conciliação","grupos":[{"grupo":"nome do grupo igual ao recebido","causa":"causa provável em 1 linha","acao":"o que fazer em 1 linha","quem":"motor|financeiro|fiscal|compras","nova_regra":"regra que o motor poderia aplicar sozinho, ou vazio"}],"prioridade":["até 4 itens, do maior impacto em R$ para o menor"]}`;
            const ia = require('./ia');
            const g = await Promise.race([ia.gerarGemini(sistema, prompt, 3000, 'gemini-3.1-flash-lite', { json: true, area: 'finance', agente: 'fin_conciliacao', tarefa: 'Conciliação ML × MP × NF-e: exceções' }),
                new Promise((_, rej) => setTimeout(() => rej(new Error('a IA demorou mais de 60 s')), 60000))]);
            const j = JSON.parse(String(g.texto).replace(/^```(json)?|```$/g, '').trim());
            gravarJson(ARQ_IA(), { em: new Date().toISOString(), de, ate, agente: g.agente || null, modelo: g.modelo, excecoes: C.resumo.excecoes, ...j });
        } catch (e) { estIA.erro = e.message; }
        finally { estIA.rodando = false; }
    })();
    return { ok: true };
}

const historico = () => lerJson(ARQ_LOG(), []).slice(0, 30);
const analiseIA = () => ({ ...lerJson(ARQ_IA(), {}), estado: { ...estIA } });

module.exports = { conciliar, analisar, historico, analiseIA, TRILHAS };
