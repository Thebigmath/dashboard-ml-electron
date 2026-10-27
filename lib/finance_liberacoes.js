// Calendario de liberacoes do Mercado Pago (20/10/2026): quanto dinheiro das vendas do ML vai cair na conta, dia a dia,
// como o "Calendario" do app do Mercado Pago. Vem dos pagamentos que o Finance ja le (GET /v1/payments/{id}):
//   money_release_date (data da liberacao), money_release_status (pending / released) e net_received_amount (liquido).
// Diferenca para o app do MP: aqui entram as VENDAS do ML. Cobrancas avulsas que o MP desconta no mesmo dia (frete
// cobrado a parte no Flex/Full, devolucoes, retencoes de mediacao) e a antecipacao nao aparecem pela API de pagamentos.
const fs = require('fs');
const path = require('path');

const STORAGE = () => process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const diaBR = (iso) => new Date(new Date(iso).getTime() - 3 * 3600000).toISOString().slice(0, 10);
const mesAnt = (mes, n) => { const [a, m] = mes.split('-').map(Number); return new Date(Date.UTC(a, m - 1 - n, 1)).toISOString().slice(0, 7); };

function calendario({ dias = 45, de = null, ate = null } = {}) {
    const hoje = diaBR(new Date().toISOString());
    const meses = [0, 1, 2].map(n => mesAnt(hoje.slice(0, 7), n));
    const pagamentos = {}, pedidoDo = {}, atualizado = [], lidoEm = {};
    for (const m of meses) {
        const d = lerJson(path.join(STORAGE(), 'finance', m + '.json'), null);
        if (!d) continue;
        atualizado.push({ mes: m, em: d.atualizado_em || null });
        for (const [id, p] of Object.entries(d.pagamentos || {})) { pagamentos[id] = p; lidoEm[id] = p.lido_em || d.atualizado_em || null; }
        for (const o of d.pedidos || []) for (const pg of o.pagamentos || []) pedidoDo[pg.id] = { pedido: o.id, data: o.data, envio: o.envio,
            produtos: (o.itens || []).map(i => `${i.sku || '—'} ×${i.qtd}`).join(', '), titulo: ((o.itens || [])[0] || {}).titulo || '' };
    }
    // busca rapida do MP (atualizar): mais nova que a coleta do DRE e cobre vendas que o DRE ainda nao leu
    const mp = lerJson(ARQ_MP(), null);
    if (mp) for (const [id, p] of Object.entries(mp.pagamentos || {})) {
        pagamentos[id] = { ...(pagamentos[id] || {}), ...p }; lidoEm[id] = mp.atualizado_em;
        if (!pedidoDo[id]) pedidoDo[id] = { pedido: p.pedido, data: null, envio: null, produtos: '', titulo: p.titulo || '' };
    }
    const limite = new Date(Date.parse(hoje + 'T12:00:00Z') + dias * 86400000).toISOString().slice(0, 10);
    const porDia = {}, retidos = [], vencidos = [], linhas = [];
    const deL = de || new Date(Date.now() - 3 * 3600000 - 7 * 86400000).toISOString().slice(0, 10), ateL = ate || null;
    let liberadoHoje = 0;
    for (let [id, p] of Object.entries(pagamentos)) {
        // estornadas/canceladas: so para a aba "canceladas" da tela (fora de todos os totais)
        if (p.liberacao_data && ['cancelled', 'refunded', 'charged_back'].includes(p.status)) { const d0 = diaBR(p.liberacao_data);
            if (d0 >= deL && (!ateL || d0 <= ateL)) linhas.push({ pagamento: id, ...(pedidoDo[id] || {}), valor: r2(p.liquido || 0), status: p.liberacao, dia: d0, situacao: 'cancelado' }); continue; }
        if (!p.liberacao_data || p.liquido == null || p.status === 'rejected') continue;
        const dia = diaBR(p.liberacao_data), info = pedidoDo[id] || {};
        // a API de pagamentos do MP demora dias para trocar "pending" por "released" depois que o dinheiro cai: o relatorio
        // oficial de liberacoes mostrou 70 de 70 "data passou" da Cordeiro ja liberados (23/10). Aprovado, sem mediacao e com
        // a data de liberacao passada = liberado (mediacao/estorno nao ficam "approved")
        if (p.liberacao !== 'released' && p.status === 'approved' && dia < hoje) p = { ...p, liberacao: 'released' };
        const linha = { pagamento: id, ...info, valor: r2(p.liquido), status: p.liberacao, mediacao: p.status === 'in_mediation' };
        // lista plana (tabela): tudo do periodo, com a situacao
        const noPeriodo = dia >= deL && (!ateL || dia <= ateL);
        const sit = p.liberacao === 'released' ? 'liberado' : p.status === 'in_mediation' ? 'mediacao' : dia >= hoje ? 'a_liberar' : null;
        if (p.liberacao === 'released') { if (dia === hoje) liberadoHoje += p.liquido; if (noPeriodo) linhas.push({ ...linha, dia, situacao: 'liberado' }); continue; }
        // data passou: retido so se ja tinha passado mais de 1 dia quando o pagamento foi lido (senao e so leitura antiga)
        if (dia < hoje) { const lido = lidoEm[id] ? diaBR(lidoEm[id]) : hoje; const lim = new Date(Date.parse(lido + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
            if (dia < lim) retidos.push({ ...linha, dia }); else vencidos.push({ ...linha, dia });   // provavelmente ja liberou: falta reler
            if (noPeriodo) linhas.push({ ...linha, dia, situacao: sit === 'mediacao' ? 'mediacao' : dia < lim ? 'retido' : 'vencido' });
            continue; }
        if (noPeriodo) linhas.push({ ...linha, dia, situacao: sit || 'a_liberar' });
        if (dia > limite) continue;
        (porDia[dia] ||= []).push(linha);
    }
    const diasL = Object.keys(porDia).sort().map(d => ({ dia: d, total: r2(porDia[d].reduce((s, x) => s + x.valor, 0)), qtd: porDia[d].length,
        itens: porDia[d].sort((a, b) => b.valor - a.valor) }));
    const soma = (L) => r2(L.reduce((s, x) => s + x.total, 0));
    const amanha = new Date(Date.parse(hoje + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
    const sete = new Date(Date.parse(hoje + 'T12:00:00Z') + 7 * 86400000).toISOString().slice(0, 10);
    return {
        hoje, dias: diasL, atualizado, rapido_em: mp?.atualizado_em || null,
        resumo: { hoje: soma(diasL.filter(x => x.dia === hoje)), liberado_hoje: r2(liberadoHoje), amanha: soma(diasL.filter(x => x.dia === amanha)),
            sete_dias: soma(diasL.filter(x => x.dia <= sete)), total: soma(diasL), pagamentos: diasL.reduce((s, x) => s + x.qtd, 0),
            banco_hoje: (() => { try { const E = require('./belvo').extrato({ de: hoje, ate: hoje, tipo: 'INFLOW' }); return E.lido ? { liberado: r2(E.linhas.filter(x => /^Vendas/.test(x.grupo)).reduce((s, x) => s + x.valor, 0)), qtd: E.linhas.filter(x => /^Vendas/.test(x.grupo)).length, em: E.atualizado_em } : null; } catch { return null; } })(),
            retido: r2(retidos.reduce((s, x) => s + x.valor, 0)), retidos: retidos.length, vencidos: vencidos.length, valor_vencidos: r2(vencidos.reduce((s, x) => s + x.valor, 0)) },
        retidos: retidos.sort((a, b) => a.dia.localeCompare(b.dia)),
        periodo: { de: deL, ate: ateL }, linhas: linhas.sort((a, b) => a.dia.localeCompare(b.dia) || b.valor - a.valor),
    };
}

// rele no Mercado Pago so os pagamentos ainda a liberar (dos ultimos 3 meses) e grava nos meses do Finance
// atualizar: UMA busca no Mercado Pago pelos pagamentos com liberacao de 45 dias atras ate 60 dias a frente
// (GET /v1/payments/search?range=money_release_date): segundos, em vez de recoletar o mes inteiro do DRE.
// Entram so os pagamentos de vendas do ML (order.type = mercadolibre), como no resto da pagina.
const ARQ_MP = () => path.join(STORAGE(), 'finance', 'liberacoes_mp.json');
const est = { rodando: false, etapa: '', feito: 0, total: 0, erro: null, em: null };
function atualizar() {
    if (est.rodando) return { ok: false, erro: 'Já está atualizando.' };
    Object.assign(est, { rodando: true, etapa: 'Buscando as liberações no Mercado Pago…', feito: 0, total: 0, erro: null });
    (async () => {
        try {
            const axios = require('axios'), P = require('./precificador');
            const { headers } = await P.auth();
            const pagamentos = {}, lim = 1000;
            for (let off = 0; ; off += lim) {
                let d;
                for (let t = 1; ; t++) {
                    try { d = (await axios.get('https://api.mercadopago.com/v1/payments/search', { headers, timeout: 60000,
                        params: { range: 'money_release_date', begin_date: 'NOW-45DAYS', end_date: 'NOW+60DAYS', sort: 'money_release_date', criteria: 'asc', limit: lim, offset: off } })).data; break; }
                    catch (e) { const s = e.response?.status; if ((s === 429 || s >= 500 || !e.response) && t < 4) { await new Promise(r => setTimeout(r, 1500 * t)); continue; } throw e; }
                }
                for (const m of d.results || []) {
                    if (m.order?.type !== 'mercadolibre') continue;
                    pagamentos[String(m.id)] = { status: m.status, detalhe: m.status_detail, devolvido: m.transaction_amount_refunded || 0, liquido: m.transaction_details?.net_received_amount ?? null,
                        liberacao: m.money_release_status || null, liberacao_data: m.money_release_date || null, pedido: m.order?.id ? String(m.order.id) : null, titulo: m.description || '' };
                }
                est.total = d.paging?.total || 0; est.feito = Math.min(off + lim, est.total);
                if (off + lim >= est.total || !(d.results || []).length) break;
            }
            fs.mkdirSync(path.dirname(ARQ_MP()), { recursive: true });
            fs.writeFileSync(ARQ_MP(), JSON.stringify({ atualizado_em: new Date().toISOString(), pagamentos }));
            est.em = new Date().toISOString();
        } catch (e) { est.erro = e.response?.data?.message || e.message; }
        finally { Object.assign(est, { rodando: false, etapa: '' }); }
    })();
    return { ok: true };
}
const estado = () => ({ ...est });

module.exports = { calendario, atualizar, estado };
