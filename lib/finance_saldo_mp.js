// Saldo do Mercado Pago (22/10/2026, Plano A). O MP nao libera o saldo direto pela API (/mercadopago_account/balance
// da 403 mesmo com a credencial da propria conta), entao:
//   ANCORA ... relatorio de liberacoes (/v1/account/release_report): cada movimento traz BALANCE_AMOUNT, o saldo da
//              conta depois dele. O MP leva ~8 min para gerar e cada geracao cria um arquivo na area Relatorios do MP.
//              Gera sozinho 1x por dia (a partir das 7h) e pelo botao da tela.
//   BOTS ..... a cada 3 min, a API de pagamentos (segundos) soma o que mudou desde a ancora: vendas liberadas (+liquido)
//              e pagamentos feitos com o saldo (-valor) e devolucoes (-valor devolvido). Saque e mediacao nao aparecem nessa API:
//              entram so na proxima ancora. Por isso a tela mostra "saldo oficial" (ancora) e "estimado agora".
// Credencial: ~/.seven/mercadopago_<conta>.json (aplicacao de producao da conta, user_id igual ao do app); sem ela,
// usa o token do Mercado Livre do app, que tambem le o relatorio e os pagamentos. So le: nada e pago ou movido.
const fs = require('fs');
const os = require('os');
const path = require('path');

const STORAGE = () => process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ARQ = () => path.join(STORAGE(), 'saldo_mp.json');
const MP = 'https://api.mercadopago.com';
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
const gravar = (o) => fs.writeFileSync(ARQ(), JSON.stringify(o));
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const dormir = (ms) => new Promise(r => setTimeout(r, ms));
const hojeBR = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
const TIPOS = { payment: 'Venda liberada', payout: 'Saque', mediation: 'Mediação', mediation_cancel: 'Mediação cancelada', refund: 'Devolução',
    shipping: 'Frete', reserve_for_dispute: 'Reserva por disputa', reserve_for_payout: 'Reserva para saque', reserve_for_payment: 'Reserva para pagamento',
    reserve_for_refund: 'Reserva para devolução', reserve_for_bpp_shipping_return: 'Reserva de frete de devolução' };

async function credencial() {
    const { userId, headers } = await require('./precificador').auth();
    const pasta = path.join(os.homedir(), '.seven');
    for (const f of (() => { try { return fs.readdirSync(pasta); } catch { return []; } })().filter(f => /^mercadopago_.+\.json$/.test(f))) {
        const c = lerJson(path.join(pasta, f), {});
        if (c.access_token && String(c.user_id) === String(userId)) return { headers: { Authorization: 'Bearer ' + c.access_token }, userId, fonte: 'aplicação do Mercado Pago' };
    }
    return { headers, userId, fonte: 'token do Mercado Livre' };
}
async function req(url, h, opt = {}) {
    for (let t = 1; ; t++) {
        const r = await fetch(url, { ...opt, headers: { ...h, ...(opt.headers || {}) }, signal: AbortSignal.timeout(60000) });
        if ((r.status === 429 || r.status >= 500) && t < 4) { await dormir(2000 * t); continue; }
        return r;
    }
}

// ---- ancora: relatorio de liberacoes ----
function lerRelatorio(csv) {
    const L = csv.trim().split(/\r?\n/).map(l => l.split(';')), cab = L.shift();
    const i = (k) => cab.indexOf(k), c = { data: i('DATE'), id: i('SOURCE_ID'), desc: i('DESCRIPTION'), cred: i('NET_CREDIT_AMOUNT'), deb: i('NET_DEBIT_AMOUNT'), saldo: i('BALANCE_AMOUNT'), meio: i('PAYMENT_METHOD') };
    const mov = L.filter(l => l[c.data] && l[c.desc]).map(l => ({ data: l[c.data], id: l[c.id], tipo: l[c.desc], nome: TIPOS[l[c.desc]] || l[c.desc],
        entrada: r2(l[c.cred]), saida: r2(l[c.deb]), saldo: r2(l[c.saldo]), meio: l[c.meio] || '' }));
    const abertura = L.find(l => l[c.data] && !l[c.desc]);
    return { mov, saldo_inicial: abertura ? r2(abertura[c.saldo]) : null };
}
const est = { rodando: false, etapa: '', erro: null };
function gerarAncora() {
    if (est.rodando) return { ok: false, erro: 'Já está gerando o saldo oficial.' };
    Object.assign(est, { rodando: true, etapa: 'Pedindo o relatório ao Mercado Pago…', erro: null });
    (async () => {
        try {
            const { headers, fonte } = await credencial(), h = { ...headers, 'Content-Type': 'application/json' };
            const fim = new Date(), ini = new Date(Date.now() - 2 * 86400000);   // 2 dias: lista curta, o saldo vem na ultima linha
            const pedido = Date.now();
            const r = await req(`${MP}/v1/account/release_report`, h, { method: 'POST', body: JSON.stringify({ begin_date: ini.toISOString().slice(0, 19) + 'Z', end_date: fim.toISOString().slice(0, 19) + 'Z' }) });
            if (!r.ok) throw new Error(`O Mercado Pago recusou o relatório (${r.status})`);
            // espera o arquivo (~8 min); o mais novo da lista criado depois do pedido
            for (let t = 0; t < 40; t++) {
                est.etapa = `Mercado Pago gerando o relatório (${Math.round((Date.now() - pedido) / 60000)} min)…`;
                await dormir(30000);
                const lista = await (await req(`${MP}/v1/account/release_report/list`, headers)).json().catch(() => []);
                const x = (Array.isArray(lista) ? lista : []).filter(a => a.file_name && /manual/.test(a.file_name)).sort((a, b) => String(b.file_name).localeCompare(String(a.file_name)))[0];
                const quando = x && x.file_name.match(/(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})(\d{2})\.csv$/);
                if (!x || !quando || Date.parse(`${quando[1]}T${quando[2]}:${quando[3]}:${quando[4]}-03:00`) < pedido - 60000) continue;
                const csv = await (await req(`${MP}/v1/account/release_report/${x.file_name}`, headers)).text();
                const R = lerRelatorio(csv); if (!R.mov.length && R.saldo_inicial == null) throw new Error('Relatório vazio.');
                const ult = R.mov[R.mov.length - 1];
                const s = lerJson(ARQ(), {});
                s.ancora = { saldo: ult ? ult.saldo : R.saldo_inicial, ate: ult ? ult.data : fim.toISOString(), gerado_em: new Date().toISOString(), arquivo: x.file_name, fonte };
                s.movimentos = R.mov.slice(-300).reverse(); s.dia_ancora = hojeBR(); s.delta = null;
                gravar(s); est.etapa = '';
                await atualizarDelta();
                return;
            }
            throw new Error('O Mercado Pago não entregou o relatório em 20 min. Tente de novo mais tarde.');
        } catch (e) { est.erro = e.message; }
        finally { Object.assign(est, { rodando: false, etapa: '' }); }
    })();
    return { ok: true };
}

// ---- bots: o que mudou desde a ancora, pela API de pagamentos ----
let rodandoDelta = false;
async function atualizarDelta() {
    const s = lerJson(ARQ(), {}); if (!s.ancora || rodandoDelta) return;
    rodandoDelta = true;
    try {
        const { headers, userId } = await credencial(), desde = new Date(s.ancora.ate), mov = [];
        const busca = async (params) => { const out = []; for (let off = 0; off < 5000; off += 100) {
            const j = await (await req(`${MP}/v1/payments/search?` + new URLSearchParams({ ...params, limit: 100, offset: off }), headers)).json();
            out.push(...(j.results || [])); if (off + 100 >= (j.paging?.total || 0)) break; } return out; };
        const iso = desde.toISOString().slice(0, 19) + 'Z';
        // vendas liberadas depois da ancora: como no relatorio, conta na data de liberacao (o MP demora para trocar a
        // situacao de "pending" para "released" depois que a data passa)
        const agora = new Date();
        // a busca tambem traz o que a conta PAGOU com o saldo (boleto, conta): sem collector_id (o recebedor e outro) e
        // pago em account_money. Isso e saida, nao entrada (23/10: 4 boletos de R$ 25,5 mil entravam como venda)
        for (const p of await busca({ range: 'money_release_date', begin_date: iso, end_date: 'NOW' })) {
            if (p.status !== 'approved' || !(new Date(p.money_release_date) > desde && new Date(p.money_release_date) <= agora)) continue;
            if (String(p.collector_id || '') === String(userId)) mov.push({ data: p.money_release_date, id: String(p.id), tipo: 'payment', nome: 'Venda liberada', entrada: r2(p.transaction_details?.net_received_amount), saida: 0 });
            else if (p.payment_type_id === 'account_money') mov.push({ data: p.date_approved || p.money_release_date, id: String(p.id), tipo: 'pagamento', nome: 'Pago com o saldo' + (p.description ? ' · ' + p.description : ''), entrada: 0, saida: r2(p.transaction_amount) });
        }
        // devolucoes feitas depois da ancora (pagamentos alterados desde entao com valor devolvido)
        for (const p of await busca({ range: 'date_last_updated', begin_date: iso, end_date: 'NOW' })) {
            const dev = (p.refunds || []).filter(r => new Date(r.date_created) > desde).reduce((t, r) => t + Number(r.amount || 0), 0);
            if (dev > 0 && p.money_release_status === 'released') mov.push({ data: p.date_last_updated, id: String(p.id), tipo: 'refund', nome: 'Devolução', entrada: 0, saida: r2(dev) });
        }
        const entrada = r2(mov.reduce((t, m) => t + m.entrada, 0)), saida = r2(mov.reduce((t, m) => t + m.saida, 0));
        const atual = lerJson(ARQ(), s);
        delete atual.delta_erro;
        atual.delta = { em: new Date().toISOString(), entrada, saida, saldo_estimado: r2(atual.ancora.saldo + entrada - saida), movimentos: mov.sort((a, b) => String(b.data).localeCompare(String(a.data))).slice(0, 200) };
        gravar(atual);
    } catch (e) { const a = lerJson(ARQ(), s); a.delta_erro = e.message; gravar(a); }
    finally { rodandoDelta = false; }
}

function resultado() { return { ...lerJson(ARQ(), {}), estado: { ...est } }; }

let timer = null;
function iniciarAgendador() {
    if (timer) return;
    const checar = () => {
        const s = lerJson(ARQ(), {}), h = Number(new Date(Date.now() - 3 * 3600000).toISOString().slice(11, 13));
        const ultimaHora = s.ancora && s.ancora.gerado_em ? Number(new Date(s.ancora.gerado_em).toISOString().slice(11, 13)) : -1;
        // ancora 2x por dia (manha e tarde): de manha sempre que for dia novo; a tarde, se a ultima foi de manha
        const precisaAncora = !s.ancora || s.dia_ancora !== hojeBR() || (h >= 14 && ultimaHora >= 0 && ultimaHora < 14);
        if (h >= 7 && precisaAncora && !est.rodando) gerarAncora();
        else atualizarDelta().catch(() => {});
    };
    setTimeout(checar, 2 * 60 * 1000);
    timer = setInterval(checar, 3 * 60 * 1000);
}
function pararAgendador() { if (timer) clearInterval(timer); timer = null; }

module.exports = { gerarAncora, atualizarDelta, resultado, iniciarAgendador, pararAgendador, lerRelatorio };
