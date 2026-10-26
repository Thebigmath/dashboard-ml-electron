// Previsao da reputacao / Platinum (26/10/2026): "vamos perder o selo?" com base nos casos abertos e no historico.
//
// Como o Mercado Livre calcula (conferido contra a API em 26/10/2026: bateu 23 na Cordeiro e 30 na Flavia):
//   reclamacoes ... so as que o ML marca "afeta a reputacao" (/post-purchase/v1/claims/{id}/affects-reputation), contadas pela
//                   DATA DO PEDIDO (nao pela data da reclamacao), numa janela movel de 60 dias, sobre o total de pedidos da janela
//   cancelamentos . so os causados pelo vendedor (order.cancel_detail.group = 'seller')
//   atraso ........ envios fora do prazo de postagem (so a taxa do ML: o historico por envio nao e lido)
// O denominador do ML e ~2% maior que a contagem de pedidos da API: o modelo se calibra todo dia pela taxa que o ML informa (kappa).
// O flag "afeta" e PROVISORIO: disputas novas aparecem marcadas (~30% das criadas ha menos de 14 dias) e muitas saem da conta quando sao
// resolvidas (12 a 14% das antigas). Por isso o modelo nao pergunta "como a reclamacao termina?", e sim "qual a chance de uma reclamacao
// dessa idade estar sendo contada naquele dia?" (tabela por tipo e idade, medida nas reclamacoes da janela).
//
// Previsao (Monte Carlo, escalada de prata: motor sem IA): para cada dia dos proximos H dias, simula
//   1. as reclamacoes ja abertas (cada uma com o estado de hoje) envelhecendo
//   2. as reclamacoes NOVAS dos pedidos recentes que ainda nao amadureceram (curva de atraso entre o pedido e a reclamacao)
//   3. os pedidos que saem da janela e os que entram (volume dos ultimos 14 dias)
// e devolve a chance de a taxa passar do limite em cada dia, a folga (quantas reclamacoes ainda cabem) e a faixa p10-p90.
// Os limites vem de reputacao_config.json (padrao: os do Harvey, 1% / 1% / 5%, definidos pelo usuario em 12/10/2026; NAO confirmados
// no painel do ML: a documentacao oficial bloqueia a leitura automatica e os guias de terceiros divergem).
// Arquivos em STORAGE: reputacao_dados.json (cache), reputacao_historico.json (foto por dia), reputacao_previsao.json,
// reputacao_previsoes.jsonl (cada previsao do dia, para conferir depois com o que aconteceu), reputacao_config.json.
// So le o Mercado Livre: nada e alterado na conta.
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const STORAGE = () => process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ARQ = (n) => path.join(STORAGE(), n);
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
const gravar = (arq, v) => { fs.mkdirSync(path.dirname(arq), { recursive: true }); fs.writeFileSync(arq, JSON.stringify(v)); };
const dormir = (ms) => new Promise(r => setTimeout(r, ms));
const r4 = (v) => Math.round(v * 10000) / 10000;
const diaBR = (iso) => new Date(new Date(iso).getTime() - 3 * 3600000).toISOString().slice(0, 10);
const hojeBR = () => diaBR(new Date().toISOString());
const add = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const dif = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
// indice numerico do dia (a simulacao roda milhares de vezes: nada de string de data no laco)
const num = (d) => Math.floor(Date.parse(d + 'T00:00:00Z') / 864e5);
const str = (n) => new Date(n * 864e5).toISOString().slice(0, 10);

const JANELA = 60;
const PADRAO = { limite_reclamacoes: 0.01, limite_cancelamentos: 0.01, limite_atraso: 0.05, horizonte_dias: 30, simulacoes: 4000, minimo_vendas_60d: null };
const configuracao = () => ({ ...PADRAO, ...lerJson(ARQ('reputacao_config.json'), {}) });

let authFn = () => require('./precificador').auth();
const usarAuth = (fn) => { authFn = fn; };

// ---------------------------------------------------------------- coleta
const est = { rodando: false, etapa: '', erro: null, em: null };

async function ml(headers, url, params) {
    for (let t = 1; t <= 5; t++) {
        try { return (await axios.get('https://api.mercadolibre.com' + url, { headers, params, timeout: 30000 })).data; }
        catch (e) { const s = e.response && e.response.status; if (s && [400, 403, 404].includes(s)) return null; await dormir(1200 * t); }
    }
    return null;
}
async function emParalelo(L, k, fn) { let i = 0; await Promise.all(Array.from({ length: k }, async () => { while (i < L.length) await fn(L[i++]); })); }

async function coletarClaims(D, h, uid, hoje) {
    const desde = add(hoje, -100), recente = add(hoje, -45);
    let off = 0, total = 1;
    while (off < total) {
        const r = await ml(h, '/post-purchase/v1/claims/search', { limit: 50, offset: off, player_role: 'respondent', player_user_id: uid, sort: 'date_created:desc' });
        if (!r) break;
        total = r.paging.total;
        for (const c of r.data) {
            const x = D.claims[c.id] || (D.claims[c.id] = { id: c.id });
            Object.assign(x, { criada: c.date_created, atualizada: c.last_updated, tipo: c.type, estagio: c.stage, status: c.status, motivo: c.reason_id, recurso: c.resource, recurso_id: c.resource_id,
                fechada: c.resolution && c.resolution.date_created ? c.resolution.date_created : null });
        }
        off += 50;
        const ult = r.data[r.data.length - 1];
        // depois da primeira coleta, so as paginas recentes (o que e mais velho e fechado nao muda)
        if (!ult || diaBR(ult.date_created) < (D.claims_ate ? recente : desde)) break;
    }
    // abertas mais velhas que a pagina recente: reler uma a uma
    for (const x of Object.values(D.claims).filter(c => c.status === 'opened' && diaBR(c.criada) < recente)) {
        const r = await ml(h, '/post-purchase/v1/claims/' + x.id); if (r) Object.assign(x, { status: r.status, atualizada: r.last_updated, fechada: r.resolution && r.resolution.date_created ? r.resolution.date_created : null });
    }
    D.claims_ate = hoje;
    // "afeta a reputacao": so importa para quem foi criada na janela (o flag so vale para pedidos dos ultimos 60 dias); o flag e provisorio: relê as abertas
    const L = Object.values(D.claims).filter(c => diaBR(c.criada) >= add(hoje, -(JANELA + 3)));
    await emParalelo(L.filter(c => c.afeta == null || c.status === 'opened' || (c.afeta_em || '') < (c.atualizada || '')), 4, async (c) => {
        const r = await ml(h, `/post-purchase/v1/claims/${c.id}/affects-reputation`);
        if (r) Object.assign(c, { afeta: r.affects_reputation || 'undefined', prazo: r.due_date || null, incentivo: r.has_incentive ?? null, afeta_em: new Date().toISOString() });
    });
    // data do pedido de cada reclamacao (a reputacao conta pela data da venda); 100 dias: a curva de atraso precisa dos pedidos mais velhos
    await emParalelo(Object.values(D.claims).filter(c => c.recurso === 'order' && !D.ordens[c.recurso_id] && diaBR(c.criada) >= add(hoje, -100)), 4, async (c) => {
        const o = await ml(h, '/orders/' + c.recurso_id); if (o) D.ordens[c.recurso_id] = { criada: o.date_created };
    });
    // sem a data do pedido (reclamacao de envio, ou antiga demais) fica sem: nao entra na curva de atraso
    for (const c of Object.values(D.claims)) c.pedido_em = (c.recurso === 'order' ? D.ordens[c.recurso_id] && D.ordens[c.recurso_id].criada : c.criada) || null;
}

async function coletarPedidos(D, h, uid, hoje) {
    // sempre relê os ultimos 14 dias: cancelamento e status mudam depois da venda
    const de = D.pedidos_ate ? add(D.pedidos_ate, -14) : add(hoje, -80);
    const P = D.pedidos;
    for (const d of Object.keys(P)) if (d >= de) delete P[d];
    const vistos = new Set();   // o pedido na virada da semana pode vir nas duas buscas
    for (let a = de; a <= hoje; a = add(a, 7)) {
        const b = add(a, 7) > add(hoje, 1) ? add(hoje, 1) : add(a, 7);
        for (let o = 0; ; o += 50) {
            const r = await ml(h, '/orders/search', { seller: uid, 'order.date_created.from': a + 'T00:00:00.000-03:00', 'order.date_created.to': b + 'T00:00:00.000-03:00', sort: 'date_asc', limit: 50, offset: o });
            if (!r || !(r.results || []).length) break;
            for (const x of r.results) {
                if (vistos.has(x.id)) continue; vistos.add(x.id);
                const d = diaBR(x.date_created); if (d < de) continue;
                const p = P[d] || (P[d] = { total: 0, cancelados: 0, cancel_vendedor: 0 });
                p.total++;
                if (x.status === 'cancelled') { p.cancelados++; if (x.cancel_detail && x.cancel_detail.group === 'seller') p.cancel_vendedor++; }
            }
            if (o + 50 >= (r.paging.total || 0)) break;
        }
    }
    D.pedidos_ate = hoje;
}

async function coletar() {
    if (est.rodando) return { ok: false, erro: 'Já está coletando.' };
    Object.assign(est, { rodando: true, etapa: 'Lendo a reputação…', erro: null });
    (async () => {
        try {
            const { headers, userId } = await authFn(), hoje = hojeBR();
            const D = lerJson(ARQ('reputacao_dados.json'), { claims: {}, pedidos: {}, ordens: {} });
            const u = await ml(headers, '/users/' + userId);
            if (u && u.seller_reputation) {
                const hist = lerJson(ARQ('reputacao_historico.json'), { dias: {} }), r = u.seller_reputation, m = r.metrics || {};
                hist.dias[hoje] = { em: new Date().toISOString(), nivel: r.level_id, medalha: r.power_seller_status, vendas60: (m.sales || {}).completed ?? null,
                    reclamacoes: { v: (m.claims || {}).value ?? null, r: (m.claims || {}).rate ?? null }, cancelamentos: { v: (m.cancellations || {}).value ?? null, r: (m.cancellations || {}).rate ?? null },
                    atraso: { v: (m.delayed_handling_time || {}).value ?? null, r: (m.delayed_handling_time || {}).rate ?? null } };
                gravar(ARQ('reputacao_historico.json'), hist);
                D.nickname = u.nickname;
            }
            est.etapa = 'Lendo as reclamações…'; await coletarClaims(D, headers, userId, hoje);
            est.etapa = 'Lendo os pedidos dos últimos dias…'; await coletarPedidos(D, headers, userId, hoje);
            D.atualizado_em = new Date().toISOString();
            gravar(ARQ('reputacao_dados.json'), D);
            est.etapa = 'Calculando a previsão…';
            const P = prever(D);
            gravar(ARQ('reputacao_previsao.json'), P);
            // guarda cada previsao do dia: depois se compara com o que o ML mostrou de fato (teste retroativo honesto)
            fs.appendFileSync(ARQ('reputacao_previsoes.jsonl'), JSON.stringify({ gerado_em: P.gerado_em, hoje: P.hoje, agora: P.agora, dias: P.dias.map(x => ({ dia: x.dia, c50: x.contagem_p50, c90: x.contagem_p90, t50: x.taxa_p50, p: x.p_qualquer })) }) + '\n');
            est.em = new Date().toISOString();
        } catch (e) { est.erro = (e.response && e.response.data && e.response.data.message) || e.message; }
        finally { Object.assign(est, { rodando: false, etapa: '' }); }
    })();
    return { ok: true };
}

// ---------------------------------------------------------------- estatistica
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function normal(R) { let u = 0, v = 0; while (!u) u = R(); v = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function gama(R, k) { if (k < 1) return gama(R, k + 1) * Math.pow(R(), 1 / k); const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d); for (;;) { let x, v; do { x = normal(R); v = 1 + c * x; } while (v <= 0); v = v * v * v; const u = R(); if (u < 1 - 0.0331 * x * x * x * x || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v; } }
function poisson(R, l) { if (l <= 0) return 0; if (l > 30) return Math.max(0, Math.round(l + Math.sqrt(l) * normal(R))); const L = Math.exp(-l); let k = 0, p = 1; do { k++; p *= R(); } while (p > L); return k - 1; }
function sortear(R, pmf) { let u = R(), s = 0; for (let i = 0; i < pmf.length; i++) { s += pmf[i]; if (u <= s) return i; } return pmf.length - 1; }
const quantil = (A, p) => { const L = [...A].sort((a, b) => a - b); return L.length ? L[Math.min(L.length - 1, Math.floor(p * L.length))] : null; };

const GRUPOS = ['disputa', 'devolucao', 'recontato', 'outros'];
const grupoDe = (c) => c.tipo === 'returns' ? 'devolucao' : c.estagio === 'dispute' ? 'disputa' : c.estagio === 'recontact' ? 'recontato' : 'outros';
const binDe = (a) => a <= 3 ? 0 : a <= 7 ? 1 : a <= 14 ? 2 : a <= 21 ? 3 : 4;   // idade da reclamacao em dias: 0-3, 4-7, 8-14, 15-21, 22+
const IDADE_MAX = 80;

// retrato dos dados como estavam em T0 (para o teste retroativo): so o que existia. As reclamacoes que fecharam depois de T0 estavam abertas
// em T0 com um flag que nao foi guardado: "otimista" supoe o flag final, o pessimista supoe sem flag (a verdade fica entre os dois)
function visaoEm(D, T0, otimista) {
    const claims = {};
    for (const [id, c] of Object.entries(D.claims)) {
        if (diaBR(c.criada) > T0) continue;
        const fechouAntes = c.status === 'closed' && c.fechada && diaBR(c.fechada) <= T0;
        claims[id] = fechouAntes || c.status === 'opened' ? c : { ...c, status: 'opened', fechada: null, afeta: otimista ? c.afeta : 'not_affected' };
    }
    return { ...D, claims, pedidos: Object.fromEntries(Object.entries(D.pedidos).filter(([d]) => d <= T0)) };
}

// parametros estimados dos dados (so o que existe ate "hoje")
function parametros(D, hoje) {
    const hojeI = num(hoje), ini = hojeI - JANELA + 1;
    const cl = Object.values(D.claims).filter(c => c.pedido_em);
    // curva de atraso entre o pedido e a reclamacao (qualquer tipo; amostra grande)
    const LAGMAX = 40, cont = new Array(LAGMAX + 1).fill(0.5);
    for (const c of cl) { const p = num(diaBR(c.pedido_em)); if (p < hojeI - 100) continue; cont[Math.min(LAGMAX, Math.max(0, num(diaBR(c.criada)) - p))]++; }
    const tot = cont.reduce((a, b) => a + b, 0), pmf = cont.map(x => x / tot), F = []; pmf.reduce((s, x, i) => (F[i] = s + x), 0);
    // reclamacoes por pedido (chain ladder): observadas / pedidos x fracao ja amadurecida
    let obs = 0, expo = 0; const semanas = {}, sem = (d) => Math.floor((num(d) + 3) / 7);
    for (const [d, p] of Object.entries(D.pedidos)) {
        const idade = hojeI - num(d); if (idade < 0 || idade > 80) continue;
        const e = p.total * F[Math.min(LAGMAX, idade)]; expo += e; (semanas[sem(d)] ||= { exp: 0, obs: 0 }).exp += e;
    }
    for (const c of cl) { const p = diaBR(c.pedido_em), idade = hojeI - num(p); if (idade >= 0 && idade <= 80) { obs++; if (semanas[sem(p)]) semanas[sem(p)].obs++; } }
    const lambda = expo ? obs / expo : 0;
    // dispersao entre semanas (acima de Poisson): infla a incerteza do lambda
    let chi = 0, n = 0; for (const s of Object.values(semanas)) if (s.exp > 20) { chi += Math.pow(s.obs - lambda * s.exp, 2) / (lambda * s.exp); n++; }
    const fi = Math.min(4, Math.max(1, n > 1 ? chi / (n - 1) : 1));
    // chance de a reclamacao ESTAR SENDO CONTADA, por tipo e idade (so as da janela, onde o flag vale), encolhida para a media da idade
    const naJanela = cl.filter(c => num(diaBR(c.pedido_em)) >= ini), cnt = GRUPOS.map(() => new Array(5).fill(0)), af = GRUPOS.map(() => new Array(5).fill(0));
    for (const c of naJanela) { const g = GRUPOS.indexOf(grupoDe(c)), b = binDe(Math.max(0, hojeI - num(diaBR(c.criada)))); cnt[g][b]++; if (c.afeta === 'affected') af[g][b]++; }
    const K = 8, f = GRUPOS.map(() => new Array(5).fill(0));
    for (let b = 0; b < 5; b++) {
        const pn = cnt.reduce((s, x) => s + x[b], 0), pa = af.reduce((s, x) => s + x[b], 0), pool = (pa + 0.3) / (pn + 3);
        for (let g = 0; g < GRUPOS.length; g++) f[g][b] = (af[g][b] + K * pool) / (cnt[g][b] + K);
    }
    const tabela = GRUPOS.map((_, g) => { const L = []; for (let a = 0; a <= IDADE_MAX; a++) L.push(f[g][binDe(a)]); return L; });
    const mix = { disputa: 0, devolucao: 0, recontato: 0, outros: 0 }; for (const c of naJanela) mix[grupoDe(c)]++;
    const somaMix = Object.values(mix).reduce((a, b) => a + b, 0) || 1; for (const g of GRUPOS) mix[g] /= somaMix;
    const mixV = GRUPOS.map(g => mix[g]);
    // cancelamentos causados pelo vendedor: por pedido, dos pedidos mais velhos que 7 dias
    let cv = 0, cp = 0; for (const [d, x] of Object.entries(D.pedidos)) if (hojeI - num(d) >= 7) { cv += x.cancel_vendedor || 0; cp += x.total; }
    return { pmf, F, lambda, obs, expo, fi, tabela, f, mixV, nJanela: naJanela.length, lambdaCancel: cp ? cv / cp : 0 };
}

// ---------------------------------------------------------------- previsao
// Reclamacoes que ainda podem contar, sorteadas para UMA simulacao. Cada uma vira [dia do pedido, dia da reclamacao, tipo, U]:
// ela esta sendo contada no dia s se U < f[tipo][idade em s]. Para as ja abertas, U sai condicionado ao estado de hoje (marcada ou nao).
function reclamacoesDinamicas(R, par, lam, ped, baseI, hojeI, fimI, abertas) {
    const ev = [];
    for (const a of abertas) {
        const f0 = Math.min(0.999, Math.max(0.001, par.tabela[a.g][Math.min(IDADE_MAX, a.idade)]));
        ev.push(a.od, hojeI - a.idade, a.g, a.marcada ? R() * f0 : f0 + R() * (1 - f0));
    }
    for (let d = hojeI - 40; d <= fimI; d++) {
        const idade = hojeI - d, resta = idade < 0 ? 1 : 1 - par.F[Math.min(40, idade)];
        const n = poisson(R, (ped[d - baseI] || 0) * lam * Math.max(0, resta));
        for (let i = 0; i < n; i++) {
            let lag; do { lag = sortear(R, par.pmf); } while (idade >= 0 && idade < 40 && lag <= idade);
            ev.push(d, d + lag, sortear(R, par.mixV), R());
        }
    }
    return ev;
}
const lambdaSim = (R, par) => par.lambda ? gama(R, Math.max(0.5, (par.obs + 0.5) / par.fi)) / (par.expo / par.fi) : 0;
// quantas das reclamacoes sorteadas estao sendo contadas no dia "fim" para os pedidos de [ini, fim]
function contadasEm(ev, par, ini, fim) {
    let n = 0;
    for (let k = 0; k < ev.length; k += 4) if (ev[k] >= ini && ev[k] <= fim && ev[k + 1] <= fim && ev[k + 3] < par.tabela[ev[k + 2]][Math.min(IDADE_MAX, fim - ev[k + 1])]) n++;
    return n;
}

function prever(D, opc = {}) {
    const cfg = configuracao(), hoje = opc.hoje || hojeBR(), H = opc.horizonte || cfg.horizonte_dias, N = opc.simulacoes || cfg.simulacoes;
    const hist = lerJson(ARQ('reputacao_historico.json'), { dias: {} });
    const snap = opc.snap !== undefined ? opc.snap : hist.dias[hoje] || hist.dias[Object.keys(hist.dias).sort().pop()] || null;
    const P = D.pedidos, par = parametros(D, hoje), hojeI = num(hoje), baseI = hojeI - (JANELA + 45), LEN = JANELA + 45 + H + 1;
    const pedReal = new Float64Array(LEN), cancReal = new Float64Array(LEN);
    for (let i = 0; i < LEN && baseI + i <= hojeI; i++) { const x = P[str(baseI + i)]; if (x) { pedReal[i] = x.total; cancReal[i] = x.cancel_vendedor || 0; } }
    let pedHoje = 0; for (let d = hojeI - JANELA + 1; d <= hojeI; d++) pedHoje += pedReal[d - baseI];
    // kappa: o denominador do ML e ~2% maior que a contagem da API; calibra pela taxa que o ML informa (so com amostra boa)
    let kappa = 1.02;
    if (snap && snap.reclamacoes && snap.reclamacoes.v >= 10 && snap.reclamacoes.r > 0 && pedHoje) kappa = Math.min(1.08, Math.max(0.95, snap.reclamacoes.v / snap.reclamacoes.r / pedHoje));
    let s14 = 0; for (let d = hojeI - 13; d <= hojeI; d++) s14 += pedReal[d - baseI]; const media14 = s14 / 14;
    const R = rng(hojeI * 7 + (opc.sementeExtra || 0)), lim = { rec: cfg.limite_reclamacoes, can: cfg.limite_cancelamentos, atr: cfg.limite_atraso };
    // reclamacoes da janela: as fechadas ficam fixas (contam se "afeta"); as abertas envelhecem na simulacao
    const fixas = [], abertas = [];
    for (const c of Object.values(D.claims)) {
        if (!c.pedido_em) continue;
        const od = num(diaBR(c.pedido_em)); if (od < hojeI - JANELA + 1) continue;
        if (c.status === 'opened') abertas.push({ od, g: GRUPOS.indexOf(grupoDe(c)), idade: Math.max(0, hojeI - num(diaBR(c.criada))), marcada: c.afeta === 'affected', id: c.id });
        else if (c.afeta === 'affected') fixas.push(od);
    }
    const atrasoR = snap && snap.atraso && snap.atraso.r != null ? snap.atraso.r : 0;
    const taxaRec = [], taxaCan = [], cntRec = [], est1 = [], estAte = new Array(H + 1).fill(0);
    for (let t = 0; t <= H; t++) { taxaRec.push([]); taxaCan.push([]); cntRec.push([]); est1.push({ rec: 0, can: 0, atr: 0, qualquer: 0 }); }
    const cumPed = new Float64Array(LEN + 1), cumCan = new Float64Array(LEN + 1), ped = new Float64Array(LEN), canc = new Float64Array(LEN);
    for (let s = 0; s < N; s++) {
        const lam = lambdaSim(R, par), mult = Math.max(0.5, 1 + 0.15 * normal(R));
        for (let i = 0; i < LEN; i++) {
            const d = baseI + i;
            if (d <= hojeI) { ped[i] = pedReal[i]; const idade = hojeI - d; canc[i] = cancReal[i] + (idade < 7 ? poisson(R, ped[i] * par.lambdaCancel * (1 - (idade + 1) / 7)) : 0); }
            else { ped[i] = poisson(R, media14 * mult); canc[i] = poisson(R, ped[i] * par.lambdaCancel); }
            cumPed[i + 1] = cumPed[i] + ped[i]; cumCan[i + 1] = cumCan[i] + canc[i];
        }
        const ev = reclamacoesDinamicas(R, par, lam, ped, baseI, hojeI, hojeI + H, abertas);
        let algum = false;
        for (let t = 0; t <= H; t++) {
            const fim = hojeI + t, ini = fim - JANELA + 1, den = Math.max(1, kappa * (cumPed[fim - baseI + 1] - cumPed[ini - baseI]));
            let cr = contadasEm(ev, par, ini, fim); for (const od of fixas) if (od >= ini && od <= fim) cr++;
            const cc = cumCan[fim - baseI + 1] - cumCan[ini - baseI], ca = poisson(R, atrasoR * den);   // atraso: so a taxa de hoje (o historico por envio nao e lido)
            const tr = cr / den, tc = cc / den, ta = ca / den;
            taxaRec[t].push(tr); taxaCan[t].push(tc); cntRec[t].push(cr);
            const e1 = tr > lim.rec, e2 = tc > lim.can, e3 = ta > lim.atr;
            if (e1) est1[t].rec++; if (e2) est1[t].can++; if (e3) est1[t].atr++;
            if (e1 || e2 || e3) { est1[t].qualquer++; algum = true; }
            if (algum) estAte[t]++;
        }
    }
    const porDia = [];
    for (let t = 0; t <= H; t++) {
        const fim = hojeI + t, ini = fim - JANELA + 1; let pedJ = 0; for (let d = ini; d <= fim; d++) pedJ += d <= hojeI ? pedReal[d - baseI] : media14;
        porDia.push({ dia: str(fim), p_reclamacoes: r4(est1[t].rec / N), p_cancelamentos: r4(est1[t].can / N), p_atraso: r4(est1[t].atr / N), p_qualquer: r4(est1[t].qualquer / N), p_ate_aqui: r4(estAte[t] / N),
            taxa_p10: r4(quantil(taxaRec[t], 0.1)), taxa_p50: r4(quantil(taxaRec[t], 0.5)), taxa_p90: r4(quantil(taxaRec[t], 0.9)), contagem_p50: quantil(cntRec[t], 0.5), contagem_p90: quantil(cntRec[t], 0.9),
            pedidos_janela: Math.round(pedJ), limite_contagem: Math.floor(lim.rec * kappa * pedJ) });
    }
    const contaHoje = fixas.length + abertas.filter(a => a.marcada).length, denHoje = kappa * pedHoje, folga = Math.floor(lim.rec * denHoje) - contaHoje;
    const pAte = (h) => porDia[Math.min(H, h)].p_ate_aqui, risco = pAte(14);
    const status = risco >= 0.6 ? 'critico' : risco >= 0.3 ? 'alto' : risco >= 0.1 ? 'atencao' : 'seguro';
    const topo = porDia.reduce((a, b) => (b.p_qualquer > a.p_qualquer ? b : a), porDia[0]), primeiro = porDia.find(x => x.p_qualquer >= 0.5) || null;
    // reclamacoes abertas ainda nao marcadas que podem entrar na conta (as mais provaveis primeiro)
    const ameaca = Object.values(D.claims).filter(c => c.status === 'opened' && c.afeta !== 'affected' && c.pedido_em && num(diaBR(c.pedido_em)) >= hojeI - JANELA + 1)
        .map(c => { const g = GRUPOS.indexOf(grupoDe(c)), idade = Math.max(0, hojeI - num(diaBR(c.criada))); return { id: c.id, tipo: c.tipo, estagio: c.estagio, motivo: c.motivo, aberta_ha_dias: idade, pedido: c.recurso_id, pedido_em: diaBR(c.pedido_em), prazo: c.prazo, p_contar: r4(par.tabela[g][Math.min(IDADE_MAX, idade)]) }; })
        .sort((a, b) => b.p_contar - a.p_contar || b.aberta_ha_dias - a.aberta_ha_dias);
    const marcadasAbertas = abertas.filter(a => a.marcada).length;
    return {
        gerado_em: new Date().toISOString(), hoje, horizonte: H, simulacoes: N, status,
        resumo: { p_7d: pAte(7), p_14d: pAte(14), p_30d: pAte(H), primeiro_dia_risco_alto: primeiro ? primeiro.dia : null, dia_de_maior_risco: topo.dia, maior_risco: topo.p_qualquer },
        agora: { contagem: contaHoje, pedidos_janela: pedHoje, taxa_calculada: r4(contaHoje / denHoje), taxa_ml: snap && snap.reclamacoes ? snap.reclamacoes.r : null, limite: lim.rec, folga,
            uso_do_limite: r4(contaHoje / denHoje / lim.rec), abertas_marcadas: marcadasAbertas, abertas_total: abertas.length, abertas_que_podem_entrar: ameaca.length },
        ml: snap ? { nivel: snap.nivel, medalha: snap.medalha, vendas60: snap.vendas60, reclamacoes: snap.reclamacoes, cancelamentos: snap.cancelamentos, atraso: snap.atraso, foto_em: snap.em } : null,
        limites: { reclamacoes: lim.rec, cancelamentos: lim.can, atraso: lim.atr, minimo_vendas_60d: cfg.minimo_vendas_60d },
        modelo: { kappa: r4(kappa), reclamacoes_por_pedido: r4(par.lambda), dispersao: r4(par.fi), reclamacoes_na_janela: par.nJanela, pedidos_dia_14d: Math.round(media14 * 10) / 10, cancel_vendedor_por_pedido: r4(par.lambdaCancel),
            chance_de_contar: Object.fromEntries(GRUPOS.map((g, i) => [g, par.f[i].map(r4)])), faixas_de_idade: ['0-3 dias', '4-7', '8-14', '15-21', '22+'] },
        dias: porDia, ameacas: ameaca.slice(0, 40),
    };
}

// ---------------------------------------------------------------- teste retroativo
// Volta N dias, esconde o que veio depois, preve a contagem de hoje e compara com a contagem real (a que o ML mostra).
// Vale so para pedidos da janela de hoje (o flag "afeta" de pedidos mais velhos nao e confiavel), por isso o alvo e sempre hoje.
// Mostra dois cenarios para o estado que as reclamacoes tinham em T0 (que nao foi guardado): pessimista (sem flag) e otimista (flag final).
function testeRetroativo(D, hoje = hojeBR(), leads = [7, 14, 21]) {
    const hojeI = num(hoje), iniI = hojeI - JANELA + 1;
    const real = Object.values(D.claims).filter(c => c.afeta === 'affected' && c.pedido_em && num(diaBR(c.pedido_em)) >= iniI).length, out = [];
    for (const lead of leads) {
        const T0 = add(hoje, -lead), cen = {};
        for (const [nome, ot] of [['pessimista', false], ['otimista', true]]) cen[nome] = preverContagem(visaoEm(D, T0, ot), T0, lead, D);
        out.push({ dias_antes: lead, data: T0, real, cenarios: Object.fromEntries(Object.entries(cen).map(([k, v]) => [k, { ...v, dentro: real >= v.p10 && real <= v.p90, erro_mediana: v.p50 - real }])) });
    }
    return { alvo: hoje, real, testes: out };
}
// contagem de reclamacoes que contam, para os pedidos da janela de "hoje", prevista como se estivessemos em T0 (usa os pedidos reais para isolar o modelo de reclamacoes)
function preverContagem(V, T0, lead, Dfull) {
    const par = parametros(V, T0), R = rng(12345 + lead), N = 2000, hojeI = num(T0), alvoI = hojeI + lead, iniI = alvoI - JANELA + 1;
    const baseI = hojeI - 60, LEN = 60 + lead + 1, ped = new Float64Array(LEN);
    for (let i = 0; i < LEN; i++) { const x = Dfull.pedidos[str(baseI + i)]; ped[i] = x ? x.total : 0; }
    const fixas = [], abertas = [];
    for (const c of Object.values(V.claims)) {
        if (!c.pedido_em) continue; const od = num(diaBR(c.pedido_em)); if (od < iniI || od > alvoI) continue;
        if (c.status === 'opened') abertas.push({ od, g: GRUPOS.indexOf(grupoDe(c)), idade: Math.max(0, hojeI - num(diaBR(c.criada))), marcada: c.afeta === 'affected' });
        else if (c.afeta === 'affected') fixas.push(od);
    }
    const res = [];
    for (let s = 0; s < N; s++) {
        const ev = reclamacoesDinamicas(R, par, lambdaSim(R, par), ped, baseI, hojeI, alvoI, abertas);
        res.push(fixas.length + contadasEm(ev, par, iniI, alvoI));
    }
    return { p10: quantil(res, 0.1), p50: quantil(res, 0.5), p90: quantil(res, 0.9), media: Math.round(res.reduce((a, b) => a + b, 0) / N * 10) / 10 };
}

// ---------------------------------------------------------------- camada prata (IA do ADS Health)
// O agente "Atendimento" do ADS Health (reclamacoes que afetam a reputacao) le os numeros prontos do motor e escreve o diagnostico e o que
// fazer. Nunca inventa numero: so usa o JSON. Roda sozinho depois da coleta quando o risco passa de "seguro" (1x por dia) e pelo botao.
const estIA = { rodando: false, erro: null };
const SISTEMA_IA = 'Você é o agente de Atendimento do ADS Health de uma loja de autopeças no Mercado Livre. Recebe números prontos de um modelo estatístico que prevê se a conta vai passar dos limites de reputação (reclamações, cancelamentos, atraso) que mantêm o selo MercadoLíder Platinum. Escreva o diagnóstico e o que fazer. Regras: nunca invente número, use só os do JSON; escreva taxas em porcentagem (0,89%, não 0,0089) e chances em porcentagem inteira; os limites são os configurados e podem não ser os oficiais, então não prometa que o Mercado Livre manterá ou tirará o selo; explique em português do Brasil, direto, para um dono de loja; só recomende ações que a loja controla (responder e resolver as disputas abertas mais antigas primeiro, cumprir o prazo de postagem, evitar cancelar por falta de estoque, repor o Full, conferir anúncios com muita reclamação). Se o risco for baixo, diga isso sem alarme.';
function analisarIA() {
    if (estIA.rodando) return { ok: false, erro: 'A IA já está analisando.' };
    const P = lerJson(ARQ('reputacao_previsao.json'), null); if (!P) return { ok: false, erro: 'Atualize a previsão primeiro.' };
    Object.assign(estIA, { rodando: true, erro: null });
    (async () => {
        try {
            const marcos = [3, 7, 14, 21, 30].filter(h => h < P.dias.length).map(h => { const d = P.dias[h]; return { em_dias: h, dia: d.dia, chance_de_passar_o_limite_nesse_dia: d.p_qualquer, chance_de_ter_passado_ate_la: d.p_ate_aqui, taxa_reclamacoes_provavel: d.taxa_p50, taxa_reclamacoes_pior_caso: d.taxa_p90, reclamacoes_provaveis: d.contagem_p50, reclamacoes_no_limite: d.limite_contagem }; });
            const dados = { hoje: P.hoje, risco: P.status, chance_de_passar_algum_limite: P.resumo, situacao_hoje: P.agora, reputacao_no_mercado_livre: P.ml, limites_usados: P.limites,
                pedidos_por_dia_recentes: P.modelo.pedidos_dia_14d, previsao_por_data: marcos,
                reclamacoes_abertas_que_ainda_podem_entrar_na_conta: P.ameacas.slice(0, 10).map(a => ({ tipo: a.tipo, fase: a.estagio, aberta_ha_dias: a.aberta_ha_dias, chance_de_contar: a.p_contar })) };
            const prompt = `DADOS (JSON):\n${JSON.stringify(dados)}\n\nResponda com este JSON exato:\n{"diagnostico":"2 a 3 frases: onde a conta está, qual o risco nos próximos 14 e 30 dias e por quê","o_que_fazer":[{"acao":"verbo no imperativo, curta","porque":"1 frase com o número que justifica"}],"atencao":"1 frase sobre o ponto mais frágil do modelo ou dos limites"}\nAté 4 ações, da mais importante para a menos.`;
            const ia = require('./ia');
            const g = await Promise.race([ia.gerarGemini(SISTEMA_IA, prompt, 1500, 'gemini-3.1-flash-lite', { json: true, area: 'ads_health', agente: 'ads_atendimento', tarefa: 'Reputação: diagnóstico da previsão do Platinum' }),
                new Promise((_, rej) => setTimeout(() => rej(new Error('a IA demorou mais de 60 s')), 60000))]);
            const j = JSON.parse(String(g.texto).replace(/^```(json)?|```$/g, '').trim());
            gravar(ARQ('reputacao_ia.json'), { em: new Date().toISOString(), previsao_de: P.gerado_em, risco: P.status, agente: g.agente || null, modelo: g.modelo,
                diagnostico: String(j.diagnostico || '').slice(0, 700), o_que_fazer: (j.o_que_fazer || []).slice(0, 4).map(x => ({ acao: String(x.acao || '').slice(0, 160), porque: String(x.porque || '').slice(0, 260) })), atencao: String(j.atencao || '').slice(0, 300) });
        } catch (e) { estIA.erro = e.message; }
        finally { estIA.rodando = false; }
    })();
    return { ok: true };
}

// ---------------------------------------------------------------- uso pela tela
// previsoes antigas (guardadas a cada coleta) contra o que o ML mostrou depois: o teste honesto, que melhora com o tempo
function acompanhamento() {
    const hist = lerJson(ARQ('reputacao_historico.json'), { dias: {} }).dias;
    let linhas = []; try { linhas = fs.readFileSync(ARQ('reputacao_previsoes.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch {}
    const out = [];
    for (const p of linhas) for (const d of p.dias) { const r = hist[d.dia]; if (d.dia > p.hoje && r && r.reclamacoes && r.reclamacoes.v != null) out.push({ feita_em: p.hoje, dia: d.dia, antecedencia: dif(p.hoje, d.dia), previsto: d.c50, p90: d.c90, real: r.reclamacoes.v }); }
    return out.slice(-60);
}
function resultado() {
    const P = lerJson(ARQ('reputacao_previsao.json'), null), D = lerJson(ARQ('reputacao_dados.json'), null);
    const hist = lerJson(ARQ('reputacao_historico.json'), { dias: {} });
    return { previsao: P, coleta_em: D ? D.atualizado_em : null, nickname: D ? D.nickname : null, config: configuracao(), estado: { ...est }, historico: Object.entries(hist.dias).sort().slice(-90).map(([dia, x]) => ({ dia, ...x })),
        teste: lerJson(ARQ('reputacao_teste.json'), null), acompanhamento: acompanhamento(), ia: { ...lerJson(ARQ('reputacao_ia.json'), null), estado: { ...estIA } } };
}
function salvarConfig(c) {
    const n = { ...configuracao() };
    for (const k of ['limite_reclamacoes', 'limite_cancelamentos', 'limite_atraso']) if (c[k] != null) { const v = Number(c[k]); if (!(v > 0 && v < 0.5)) throw new Error('Limite inválido: ' + k); n[k] = v; }
    if (c.minimo_vendas_60d !== undefined) n.minimo_vendas_60d = c.minimo_vendas_60d === null || c.minimo_vendas_60d === '' ? null : Number(c.minimo_vendas_60d);
    gravar(ARQ('reputacao_config.json'), n);
    const D = lerJson(ARQ('reputacao_dados.json'), null); if (D) gravar(ARQ('reputacao_previsao.json'), prever(D));
    return configuracao();
}
function rodarTeste() {
    const D = lerJson(ARQ('reputacao_dados.json'), null); if (!D) return { ok: false, erro: 'Ainda não há dados coletados.' };
    const t = testeRetroativo(D); t.gerado_em = new Date().toISOString(); gravar(ARQ('reputacao_teste.json'), t); return { ok: true, teste: t };
}

// a cada 6 h (a partir das 7h) e 3 min depois de abrir: coleta e preve; avisa no Windows se o risco subir
let timer = null; const avisouEm = {};
function avisar(P) {
    if (!P || !['alto', 'critico'].includes(P.status)) return;
    if (avisouEm[P.hoje + P.status]) return; avisouEm[P.hoje + P.status] = 1;
    try { require('./notificar').notificar(`Reputação: risco ${P.status === 'critico' ? 'CRÍTICO' : 'alto'} de perder o Platinum`, `Chance de passar do limite nos próximos 14 dias: ${Math.round(P.resumo.p_14d * 100)}%. Folga hoje: ${P.agora.folga} reclamação(ões).`, '/reputacao'); } catch {}
}
function iniciarAgendador() {
    if (timer) return;
    const checar = async () => {
        const h = Number(new Date(Date.now() - 3 * 3600000).toISOString().slice(11, 13)), P = lerJson(ARQ('reputacao_previsao.json'), null);
        const velho = !P || Date.now() - Date.parse(P.gerado_em) > 6 * 3600000;   // as reclamacoes mudam durante o dia
        if (h >= 7 && velho && !est.rodando) {
            await coletar(); for (let i = 0; i < 120 && est.rodando; i++) await dormir(5000);
            const novo = lerJson(ARQ('reputacao_previsao.json'), null); avisar(novo);
            const ia = lerJson(ARQ('reputacao_ia.json'), null);
            if (novo && novo.status !== 'seguro' && !estIA.rodando && (!ia || ia.em.slice(0, 10) !== new Date().toISOString().slice(0, 10) || ia.risco !== novo.status)) analisarIA();
        }
    };
    setTimeout(() => checar().catch(() => {}), 3 * 60 * 1000);
    timer = setInterval(() => checar().catch(() => {}), 30 * 60 * 1000);
}
function pararAgendador() { if (timer) clearInterval(timer); timer = null; }

module.exports = { analisarIA, coletar, prever, testeRetroativo, resultado, salvarConfig, rodarTeste, iniciarAgendador, pararAgendador, usarAuth, parametros, visaoEm, configuracao };
