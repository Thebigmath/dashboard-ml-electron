// Fluxo de caixa (27/10/2026): o que ainda vai entrar menos o que ainda vai sair, dia a dia, a partir do saldo da conta do Mercado Pago.
//   A receber ... calendario de liberacoes do Mercado Pago (lib/finance_liberacoes.js): vendas do ML, valor liquido, no dia em que o MP libera
//   A pagar ..... contas a pagar do Olist (lib/finance_contas_pagar.js): em aberto, no vencimento; as atrasadas entram no dia de hoje
//   Saldo ....... saldo da conta do Mercado Pago (lib/finance_saldo_mp.js: oficial + bots). Se o app nao consegue le-lo (a Flavia nao tem a
//                 credencial propria do MP e o app so le o MP), vale o saldo informado a mao, que fica guardado com a data.
// Saldo projetado do dia = saldo de hoje + tudo que entra - tudo que sai ate o fim do dia. So le os dados que o app ja tem: nada e criado, pago ou movido.
const fs = require('fs');
const path = require('path');

const STORAGE = () => process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ARQ = () => path.join(STORAGE(), 'fluxo_caixa.json');
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const hojeBR = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
const soma = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const ABERTAS = ['aberta', 'parcial', 'vence_hoje', 'atrasada'];

function saldoInicial() {
    let S = {}; try { S = require('./finance_saldo_mp').resultado() || {}; } catch {}
    const auto = S.delta && S.delta.saldo_estimado != null ? { valor: S.delta.saldo_estimado, fonte: 'Mercado Pago (estimado agora)', em: S.delta.em }
        : S.ancora && S.ancora.saldo != null ? { valor: S.ancora.saldo, fonte: 'Mercado Pago (saldo oficial)', em: S.ancora.gerado_em } : null;
    const manual = lerJson(ARQ(), {}).saldo_manual || null;
    // saldo automatico de dias atras nao vale mais que um saldo informado hoje
    if (auto && (!manual || (auto.em || '') >= (manual.em || ''))) return { ...auto, automatico: true, erro: null };
    if (manual) return { valor: Number(manual.valor), fonte: 'Informado por você', em: manual.em, automatico: false, erro: S.estado && S.estado.erro || null };
    return { valor: null, fonte: null, em: null, automatico: false, erro: S.estado && S.estado.erro || null };
}

function fluxo({ dias = 60 } = {}) {
    dias = Math.max(7, Math.min(180, Number(dias) || 60));
    const hoje = hojeBR(), fim = soma(hoje, dias);
    const saldo = saldoInicial();

    // a receber: liberacoes do MP de hoje em diante
    let L = null; try { L = require('./finance_liberacoes').calendario({ dias }); } catch {}
    const receberPor = {};
    for (const x of (L && L.dias) || []) if (x.dia >= hoje && x.dia <= fim) receberPor[x.dia] = { total: x.total, qtd: x.qtd };

    // a pagar: contas em aberto do Olist (atrasadas entram hoje)
    let P = null; try { P = require('./finance_contas_pagar').listar({}); } catch {}
    const pagarLido = !!(P && P.lido), pagarPor = {};
    let atrasadas = 0, valorAtrasadas = 0, foraDaJanela = 0;
    for (const l of (pagarLido ? P.linhas : [])) {
        if (!ABERTAS.includes(l.situacao)) continue;
        if (l.vencimento > fim) { foraDaJanela++; continue; }
        const d = l.vencimento < hoje ? hoje : l.vencimento;
        if (l.vencimento < hoje) { atrasadas++; valorAtrasadas += l.valor; }
        (pagarPor[d] ||= []).push({ id: l.id, fornecedor: l.fornecedor, documento: l.documento, historico: l.historico, vencimento: l.vencimento, valor: l.valor, atrasada: l.vencimento < hoje });
    }
    // a lista de contas do app cobre uma janela de vencimentos: se ela acaba antes do fim do fluxo, avisa
    const cobre = pagarLido && P.periodo && P.periodo.ate ? P.periodo.ate : null;

    // o MP so conhece as liberacoes das vendas JA feitas (cerca de 3 semanas a frente): depois dessa data o a receber some e o saldo fica pessimista
    const receberAte = Object.keys(receberPor).sort().pop() || null;
    const out = []; let acum = saldo.valor == null ? 0 : saldo.valor;
    let totRec = 0, totPag = 0, menor = null, primeiroNegativo = null, diasNegativos = 0;
    for (let i = 0; i <= dias; i++) {
        const d = soma(hoje, i), rec = receberPor[d] || { total: 0, qtd: 0 }, pg = pagarPor[d] || [];
        const pagar = r2(pg.reduce((s, x) => s + x.valor, 0)), receber = r2(rec.total), liquido = r2(receber - pagar);
        acum = r2(acum + liquido); totRec += receber; totPag += pagar;
        if (saldo.valor != null) { if (!menor || acum < menor.saldo) menor = { dia: d, saldo: acum }; if (acum < 0) { diasNegativos++; if (!primeiroNegativo) primeiroNegativo = d; } }
        out.push({ dia: d, receber, qtd_receber: rec.qtd, pagar, qtd_pagar: pg.length, liquido, saldo: saldo.valor == null ? null : acum, itens_pagar: pg.sort((a, b) => b.valor - a.valor) });
    }
    return {
        hoje, ate: fim, dias: out, saldo_hoje: saldo,
        resumo: {
            saldo_inicial: saldo.valor, a_receber: r2(totRec), a_pagar: r2(totPag), diferenca: r2(totRec - totPag),
            saldo_final: saldo.valor == null ? null : r2(saldo.valor + totRec - totPag),
            menor_saldo: menor, primeiro_dia_negativo: primeiroNegativo, dias_negativos: diasNegativos,
            atrasadas, valor_atrasadas: r2(valorAtrasadas),
        },
        avisos: {
            saldo_sem_leitura: saldo.valor == null,
            pagar_nao_lido: !pagarLido, pagar_ate: cobre, pagar_incompleto: pagarLido && !!cobre && cobre < fim, contas_alem_do_fluxo: foraDaJanela,
            receber_nao_lido: !L || !(L.atualizado || []).length, receber_ate: receberAte,
            receber_atualizado_em: L ? (L.rapido_em || null) : null, pagar_atualizado_em: P && P.atualizado_em || null,
            fonte_pagar: P && P.fonte || null,
        },
    };
}

// saldo da conta do Mercado Pago informado a mao (so vale como ponto de partida; o saldo automatico, quando existe e e mais novo, tem prioridade)
function salvarSaldo({ valor } = {}) {
    const v = Number(String(valor == null ? '' : valor).replace(/\./g, '').replace(',', '.'));
    if (!isFinite(v)) throw new Error('Valor inválido.');
    const d = lerJson(ARQ(), {}); d.saldo_manual = { valor: r2(v), em: new Date().toISOString() };
    fs.mkdirSync(STORAGE(), { recursive: true }); fs.writeFileSync(ARQ(), JSON.stringify(d));
    return { ok: true, saldo: d.saldo_manual };
}
function limparSaldo() { const d = lerJson(ARQ(), {}); delete d.saldo_manual; fs.writeFileSync(ARQ(), JSON.stringify(d)); return { ok: true }; }

module.exports = { fluxo, salvarSaldo, limparSaldo };
