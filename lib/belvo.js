// Belvo (Open Finance BR) direto do app (27/10/2026): saldo e cartao da conta do Mercado Pago PJ, sem depender de assistente nem de tarefa agendada.
// A Belvo expoe os dados num servidor MCP (https://panorama-mcp.belvo.com/mcp, so leitura) protegido por OAuth. O app entra como um aplicativo proprio:
//   - identificacao: "Client ID Metadata Document" (o client_id e o endereco publico do arquivo belvo-client.json deste repositorio; a Belvo
//     declara client_id_metadata_document_supported), sem cadastro nem segredo;
//   - login: UMA vez, pelo fluxo OAuth normal (codigo de autorizacao + PKCE): o app abre o link da Belvo, voce entra com a sua conta e autoriza, e a Belvo
//     devolve para o proprio app (http://127.0.0.1:<porta>/api/finance/belvo/callback, so neste PC). O fluxo por codigo da Belvo nao aceita esse tipo de identificacao;
//   - depois: o app renova o acesso sozinho (escopo offline_access) e le as contas a cada 30 min; a cada 3 h pede para a Belvo buscar dado novo no banco.
// Credencial: ~/.seven/belvo_<user_id da conta ML>.json (access/refresh token; nunca vai para o git nem para a tela). So le: nada e pago ou movido.
// Trava de empresa: so vale a conexao cuja conta corrente do Mercado Pago tem o mesmo user_id da conta do app (a Belvo mostra todas as conexoes do login).
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const axios = require('axios');

const STORAGE = () => process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ARQ = () => path.join(STORAGE(), 'belvo.json');
const PASTA = () => process.env.SEVEN_PASTA || path.join(os.homedir(), '.seven');
const ISSUER = process.env.BELVO_ISSUER || 'https://auth.panorama.belvo.com';
const MCP = process.env.BELVO_MCP || 'https://panorama-mcp.belvo.com/mcp';
const CLIENT_ID = process.env.BELVO_CLIENT_ID || 'https://raw.githubusercontent.com/Thebigmath/dashboard-cordeiro-electron/master/belvo-client.json';
const ESCOPO = 'openid profile email offline_access';
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const dormir = (ms) => new Promise(r => setTimeout(r, ms));
const form = (o) => new URLSearchParams(o).toString();

const est = { rodando: false, etapa: '', erro: null, em: null, login: null };   // login: { user_code, link, link_completo, expira_em, erro }

async function usuario() { const { userId } = await require('./precificador').auth(); return String(userId); }
const arqToken = (uid) => path.join(PASTA(), `belvo_${uid}.json`);
function lerToken(uid) { return lerJson(arqToken(uid), null); }
function gravarToken(uid, t) { fs.mkdirSync(PASTA(), { recursive: true }); fs.writeFileSync(arqToken(uid), JSON.stringify({ ...t, salvo_em: new Date().toISOString() })); }
const msgErro = (r) => (r && r.data && (r.data.error_description || r.data.error)) || (r && r.status ? 'HTTP ' + r.status : 'sem resposta');
const http = (cfg) => axios({ validateStatus: () => true, timeout: 30000, ...cfg });

// ---------------------------------------------------------------- login (codigo de autorizacao + PKCE, retorno no proprio app)
let pendente = null;   // { estado, verificador, redirect_uri, expira_em }
const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function iniciarLogin({ porta } = {}) {
    await usuario();
    porta = Number(porta) || 3001;
    if (pendente && Date.parse(pendente.expira_em) > Date.now() && pendente.redirect_uri.includes(':' + porta + '/') && est.login && !est.login.erro) return { ok: true, login: est.login };
    const verificador = b64url(crypto.randomBytes(48)), estado = b64url(crypto.randomBytes(18));
    const redirect_uri = `http://127.0.0.1:${porta}/api/finance/belvo/callback`;
    const link = ISSUER + '/oauth2/authorize?' + form({ response_type: 'code', client_id: CLIENT_ID, redirect_uri, scope: ESCOPO, state: estado, code_challenge: b64url(crypto.createHash('sha256').update(verificador).digest()), code_challenge_method: 'S256', resource: MCP });
    pendente = { estado, verificador, redirect_uri, expira_em: new Date(Date.now() + 10 * 60 * 1000).toISOString() };
    est.login = { link, expira_em: pendente.expira_em, erro: null };
    return { ok: true, login: est.login };
}
// a Belvo devolve o navegador para a rota de retorno do app com ?code=...&state=...
async function finalizarLogin({ code, state, error, error_description } = {}) {
    const p = pendente;
    if (!p || Date.parse(p.expira_em) < Date.now()) return { ok: false, erro: 'O pedido de login venceu. Volte ao SEVEN e clique em Conectar de novo.' };
    if (error) { est.login = { ...est.login, erro: 'A Belvo não autorizou: ' + (error_description || error) }; pendente = null; return { ok: false, erro: est.login.erro }; }
    if (!code || !state || state !== p.estado) return { ok: false, erro: 'Retorno da Belvo inválido (estado não confere). Tente conectar de novo.' };
    pendente = null;   // uso unico
    const uid = await usuario();
    const t = await http({ method: 'post', url: ISSUER + '/oauth2/token', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: form({ grant_type: 'authorization_code', code, redirect_uri: p.redirect_uri, client_id: CLIENT_ID, code_verifier: p.verificador, resource: MCP }) });
    if (t.status !== 200 || !t.data || !t.data.access_token) { est.login = { ...est.login, erro: 'A Belvo recusou a troca do código: ' + msgErro(t) }; return { ok: false, erro: est.login.erro }; }
    gravarToken(uid, { access_token: t.data.access_token, refresh_token: t.data.refresh_token || null, expires_at: Date.now() + (t.data.expires_in || 3600) * 1000 });
    est.login = null; est.erro = null; coletar({ atualizar: true }).catch(() => {});
    return { ok: true };
}

// ---------------------------------------------------------------- token (renova sozinho)
async function accessToken() {
    const uid = await usuario(), t = lerToken(uid);
    if (!t || !t.access_token) throw new Error('Belvo não conectada: faça o login em Fluxo de caixa → Belvo.');
    if (t.expires_at && t.expires_at - Date.now() > 90 * 1000) return t.access_token;
    if (!t.refresh_token) throw new Error('A autorização da Belvo venceu e não há renovação: conecte de novo.');
    const r = await http({ method: 'post', url: ISSUER + '/oauth2/token', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: form({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: CLIENT_ID, resource: MCP }) });
    if (r.status !== 200 || !r.data || !r.data.access_token) {
        if (r.data && r.data.error === 'invalid_grant') { try { fs.unlinkSync(arqToken(uid)); } catch {} throw new Error('A autorização da Belvo foi revogada ou venceu: conecte de novo.'); }
        throw new Error('Não consegui renovar o acesso da Belvo: ' + msgErro(r));
    }
    gravarToken(uid, { access_token: r.data.access_token, refresh_token: r.data.refresh_token || t.refresh_token, expires_at: Date.now() + (r.data.expires_in || 3600) * 1000 });
    return r.data.access_token;
}

// ---------------------------------------------------------------- cliente MCP (HTTP em fluxo): initialize -> chamadas -> fim
function lerResposta(data, tipo) {
    const txt = typeof data === 'string' ? data : JSON.stringify(data);
    if (/text\/event-stream/.test(tipo || '')) {   // "event: message\ndata: {...}"
        const blocos = txt.split(/\r?\n\r?\n/).map(b => b.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n')).filter(Boolean);
        for (const b of blocos.reverse()) { try { const j = JSON.parse(b); if (j.id != null || j.result || j.error) return j; } catch {} }
        return null;
    }
    try { return typeof data === 'string' ? JSON.parse(data) : data; } catch { return null; }
}
async function abrirSessao() {
    const token = await accessToken();
    const base = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    let id = 0, sessao = null;
    const enviar = async (corpo, tempo) => {
        const r = await http({ method: 'post', url: MCP, headers: { ...base, ...(sessao ? { 'Mcp-Session-Id': sessao } : {}) }, data: corpo, responseType: 'text', transformResponse: [x => x], timeout: tempo || 60000 });
        if (r.headers && r.headers['mcp-session-id']) sessao = r.headers['mcp-session-id'];
        if (r.status === 401) throw new Error('A Belvo recusou o acesso (401): conecte de novo.');
        if (r.status >= 400) throw new Error('Belvo MCP HTTP ' + r.status);
        return r;
    };
    const ini = await enviar({ jsonrpc: '2.0', id: ++id, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'SEVEN', version: '1' } } });
    const j = lerResposta(ini.data, ini.headers['content-type']); if (!j || j.error) throw new Error('Belvo MCP não iniciou: ' + (j && j.error && j.error.message || 'sem resposta'));
    await enviar({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => {});
    return {
        async chamar(nome, args = {}, tempo) {
            const r = await enviar({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: nome, arguments: args } }, tempo);
            const j2 = lerResposta(r.data, r.headers['content-type']);
            if (!j2) throw new Error('Resposta ilegível da Belvo em ' + nome);
            if (j2.error) throw new Error(nome + ': ' + (j2.error.message || 'erro'));
            const res = j2.result || {}, texto = (res.content || []).map(c => c.text || '').join('');
            if (res.isError) throw new Error(nome + ': ' + texto.slice(0, 200));
            try { return JSON.parse(texto); } catch { return res.structuredContent || { texto }; }
        },
        async fechar() { if (sessao) await http({ method: 'delete', url: MCP, headers: { ...base, 'Mcp-Session-Id': sessao }, timeout: 10000 }).catch(() => {}); },
    };
}
async function paginas(s, ferramenta, args) {
    const out = []; let cursor = null;
    for (let i = 0; i < 20; i++) {
        const r = await s.chamar(ferramenta, { ...args, ...(cursor ? { cursor } : {}) });
        out.push(...(r.items || [])); cursor = r.next_cursor; if (!cursor) break;
    }
    return out;
}

// ---------------------------------------------------------------- resumo (so o que o app usa)
function resumirContas(contas, userId) {
    const corrente = contas.find(c => c.category === 'CHECKING_ACCOUNT' && String(c.internal_identification) === String(userId));
    if (!corrente) return null;
    const b = corrente.balance || {}, reservas = (corrente.reserved_balances || []).map(x => ({ nome: x.name, valor: r2((x.amounts || []).reduce((s, a) => s + Number(a.amount || 0), 0)) }));
    const cartao = contas.find(c => c.category === 'CREDIT_CARD' && c.connection_id === corrente.connection_id);
    const cd = cartao && cartao.credit_data || null;
    return {
        conta: { nome: corrente.name, tipo: corrente.type, final: String(corrente.number || '').slice(-4), disponivel: r2(b.available), atual: r2(b.current), bloqueado: r2(b.blocked), reservas, total_reservas: r2(reservas.reduce((s, x) => s + x.valor, 0)), coletado_em: corrente.collected_at },
        cartao: cartao ? { limite: r2(cd && cd.credit_limit || 0), usado: r2(cartao.balance && cartao.balance.current), disponivel: r2(cartao.balance && cartao.balance.available), pagamento_minimo: cd && cd.minimum_payment != null ? r2(cd.minimum_payment) : null,
            fechamento: cd && cd.cutting_date || null, bandeira: cd && cd.network || null, finais: ((cd && cd.cards) || []).map(k => k.identification_number), coletado_em: cartao.collected_at } : null,
    };
}

async function coletar({ atualizar = false } = {}) {
    if (est.rodando) return { ok: false, erro: 'Já está lendo a Belvo.' };
    Object.assign(est, { rodando: true, etapa: 'Conectando à Belvo…', erro: null });
    let s = null;
    try {
        const uid = await usuario(); s = await abrirSessao();
        est.etapa = 'Lendo as conexões…';
        const con = (await paginas(s, 'list_connections', {})).filter(c => c.status === 'valid' || c.status === 'active');
        if (!con.length) throw new Error('Nenhuma conexão bancária válida no Belvo. Conecte o Mercado Pago em panorama.belvo.com.');
        let achou = null, nota = null;
        for (const c of con) {
            if (atualizar) {
                est.etapa = 'Pedindo dado novo ao banco…';
                const rf = await s.chamar('refresh_connection', { connection_id: c.connection_id }, 6 * 60 * 1000).catch(e => ({ status: 'erro', reason: e.message }));
                nota = rf && rf.status || null;
            }
            est.etapa = 'Lendo saldo e cartão…';
            const contas = await paginas(s, 'open_finance_list_accounts', { connection_id: c.connection_id, page_size: 50 });
            const r = resumirContas(contas.map(x => ({ ...x, connection_id: c.connection_id })), uid);
            if (r) { achou = { ...r, conexao: { id: c.connection_id, instituicao: c.institution && c.institution.display_name || '', status: c.status, sincronizada_em: c.last_synced_at, atualizacao: nota } }; break; }
        }
        if (!achou) throw new Error('A Belvo está conectada, mas nenhuma conta do Mercado Pago é desta conta do app (user_id ' + uid + ').');
        fs.mkdirSync(STORAGE(), { recursive: true });
        fs.writeFileSync(ARQ(), JSON.stringify({ coletado_em: new Date().toISOString(), ...achou }));
        est.em = new Date().toISOString();
        return { ok: true };
    } catch (e) { est.erro = e.message; return { ok: false, erro: e.message }; }
    finally { est.rodando = false; est.etapa = ''; if (s) await s.fechar(); }
}

// ---------------------------------------------------------------- uso pela tela e pelo Fluxo de caixa
async function estado() {
    let conectada = false, uid = null; try { uid = await usuario(); conectada = !!(lerToken(uid) && lerToken(uid).access_token); } catch {}
    return { conectada, login: est.login, rodando: est.rodando, etapa: est.etapa, erro: est.erro, dados: lerJson(ARQ(), null) };
}
function saldoParaFluxo() {
    const d = lerJson(ARQ(), null); if (!d || !d.conta) return null;
    return { valor: d.conta.disponivel, fonte: 'Belvo (Open Finance) · ' + (d.conexao && d.conexao.instituicao || 'Mercado Pago'), em: d.conta.coletado_em || d.coletado_em };
}
function dadosParaTela() { return lerJson(ARQ(), null); }
async function desconectar() { try { fs.unlinkSync(arqToken(await usuario())); } catch {} try { fs.unlinkSync(ARQ()); } catch {} est.login = null; est.erro = null; return { ok: true }; }

let timer = null, ultimoRefresh = 0;
function iniciarAgendador() {
    if (timer) return;
    const rodar = async () => {
        try {
            const uid = await usuario(); if (!lerToken(uid)) return;   // so quem ja conectou
            const refresh = Date.now() - ultimoRefresh > 3 * 3600 * 1000; if (refresh) ultimoRefresh = Date.now();
            await coletar({ atualizar: refresh });
        } catch {}
    };
    setTimeout(rodar, 3 * 60 * 1000); timer = setInterval(rodar, 30 * 60 * 1000);
}
function pararAgendador() { if (timer) clearInterval(timer); timer = null; }

module.exports = { iniciarLogin, finalizarLogin, coletar, estado, saldoParaFluxo, dadosParaTela, desconectar, iniciarAgendador, pararAgendador, resumirContas, lerResposta, CLIENT_ID };
