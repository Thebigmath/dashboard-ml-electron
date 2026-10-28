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
        conta: { id: corrente.account_id, nome: corrente.name, tipo: corrente.type, final: String(corrente.number || '').slice(-4), disponivel: r2(b.available), atual: r2(b.current), bloqueado: r2(b.blocked), reservas, total_reservas: r2(reservas.reduce((s, x) => s + x.valor, 0)), coletado_em: corrente.collected_at },
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
        const guardar = (a) => { fs.mkdirSync(STORAGE(), { recursive: true }); fs.writeFileSync(ARQ(), JSON.stringify({ coletado_em: new Date().toISOString(), ...a })); est.em = new Date().toISOString(); };
        for (const c of con) {
            est.etapa = 'Lendo saldo e cartão…';   // primeiro o que a Belvo ja tem guardado (segundos): o saldo aparece logo
            const ler1 = async () => resumirContas((await paginas(s, 'open_finance_list_accounts', { connection_id: c.connection_id, page_size: 50 })).map(x => ({ ...x, connection_id: c.connection_id })), uid);
            let r = await ler1();
            if (!r) continue;
            achou = { ...r, conexao: { id: c.connection_id, instituicao: c.institution && c.institution.display_name || '', status: c.status, sincronizada_em: c.last_synced_at, atualizacao: null } };
            guardar(achou);
            est.etapa = 'Lendo o extrato…'; await coletarExtrato(s, r.conta.id).catch(e => { est.erro = 'Extrato: ' + e.message; });
            if (atualizar) {   // depois pede dado novo ao banco (pode levar minutos) e le de novo
                est.etapa = 'Pedindo dado novo ao banco…';
                const rf = await s.chamar('refresh_connection', { connection_id: c.connection_id }, 6 * 60 * 1000).catch(e => ({ status: 'erro', reason: e.message }));
                nota = rf && rf.status || null;
                est.etapa = 'Lendo o dado novo…';
                const r2b = await ler1().catch(() => null);
                if (r2b) achou = { ...r2b, conexao: { ...achou.conexao, atualizacao: nota } }; else achou.conexao.atualizacao = nota;
                guardar(achou);
                est.etapa = 'Lendo o extrato novo…'; await coletarExtrato(s, achou.conta.id).catch(e => { est.erro = 'Extrato: ' + e.message; });
            }
            break;
        }
        if (!achou) throw new Error('A Belvo está conectada, mas nenhuma conta do Mercado Pago é desta conta do app (user_id ' + uid + ').');
        return { ok: true };
    } catch (e) { est.erro = e.message; return { ok: false, erro: e.message }; }
    finally { est.rodando = false; est.etapa = ''; if (s) await s.fechar(); }
}

// ---------------------------------------------------------------- extrato do banco (movimentos da conta corrente do Mercado Pago)
// Guardado em STORAGE/belvo_extrato.json so com o que as telas usam; CPF de pessoa nunca e guardado (so CNPJ de empresa, para casar boleto com fornecedor).
const ARQ_EXT = () => path.join(STORAGE(), 'belvo_extrato.json');
const norm = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
function classificar(desc, op, tipo) {
    const d = norm(desc);
    if (/dinheiro (reservado|retirado)/.test(d)) return 'Reservas (dinheiro que vai e volta da conta)';
    if (/cancelamento de liberacao/.test(d)) return 'Cancelamento de liberação';
    if (/liberacao de dinheiro venda com pix/.test(d)) return 'Vendas por Pix';
    if (/liberacao de dinheiro/.test(d)) return 'Vendas do Mercado Livre (liberação)';
    if (/dinheiro retido reclama/.test(d)) return 'Retenção: reclamações e devoluções';
    if (/debito por divida envio/.test(d)) return 'Débito: envios do Mercado Livre';
    if (/debito por divida/.test(d)) return 'Débito por dívida / dinheiro retido';
    if (/^pagamento de conta/.test(d) || op === 'BOLETO') return 'Boletos pagos';
    if (/fatura|cartao de credito/.test(d)) return 'Cartão de crédito (pagamento)';
    if (/^reembolso/.test(d)) return 'Reembolsos (envio cancelado, compra garantida…)';
    if (/^pix recebido/.test(d) || (op === 'PIX' && tipo === 'INFLOW')) return 'Pix recebido';
    if (/^pix enviado/.test(d) || (op === 'PIX' && tipo === 'OUTFLOW')) return 'Pix enviado';
    if (/transfer/.test(d)) return tipo === 'INFLOW' ? 'Transferência recebida' : 'Transferência enviada';
    if (/cashback|anulacao/.test(d)) return 'Cashback';
    if (/bonus/.test(d)) return 'Bônus de envio (Mercado Envios)';
    if (/^dinheiro recebido|entrada de dinheiro/.test(d)) return 'Entradas de dinheiro';
    if (/^pagamento/.test(d)) return 'Pagamentos (assinaturas, compras)';
    if (/tarifa|taxa/.test(d)) return 'Tarifas';
    return 'Outros: ' + String(desc || '').replace(/\d+/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
}
const itemExtrato = (x) => ({ id: x.transaction_id, dia: x.date || String(x.transacted_at || '').slice(0, 10), em: x.transacted_at || null, valor: r2((x.type === 'OUTFLOW' ? -1 : 1) * Number(x.amount || 0)), tipo: x.type,
    desc: x.description || '', op: x.operation_type || null, grupo: classificar(x.description, x.operation_type, x.type), status: x.status || null,
    cnpj: x.counterparty && /^\d{14}$/.test(String(x.counterparty.document_number || '')) ? String(x.counterparty.document_number) : null });
async function coletarExtrato(s, contaId) {
    const E = lerJson(ARQ_EXT(), { itens: {}, desde: null });
    const hoje = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
    const dias = (n) => new Date(Date.parse(hoje + 'T12:00:00Z') - n * 86400000).toISOString().slice(0, 10);
    // 1a vez: 90 dias; depois: so os ultimos 5 dias (para pegar o que mudou de status), sempre sem repetir (por id)
    const inicio = E.atualizado_em ? dias(5) : dias(90);
    let cursor = null, n = 0, tam = 50;
    for (let i = 0; i < 400; i++) {
        let r = null;
        for (let t = 0; t < 8 && !r; t++) {   // a Belvo recusa pagina grande demais ("use page_size=24"): repete o MESMO cursor com pagina menor
            try { r = await s.chamar('open_finance_list_transactions', { account_id: contaId, start_date: inicio, end_date: hoje, page_size: tam, ...(cursor ? { cursor } : {}) }); }
            catch (e) { const m = /page_size=(\d+)/.exec(e.message); if (/too large|grande demais/i.test(e.message) && tam > 1) { tam = m ? Math.max(1, Math.min(tam - 1, Number(m[1]))) : Math.max(1, Math.floor(tam / 2)); continue; } throw e; }
        }
        if (!r) throw new Error('A Belvo recusou todas as páginas do extrato (muito grandes).');
        for (const x of r.items || []) { if (x.account_id && x.account_id !== contaId) continue; const it = itemExtrato(x); E.itens[it.id] = it; n++; }
        est.etapa = `Lendo o extrato… ${n} movimentos`;
        cursor = r.next_cursor; if (!cursor) break;
        if (i % 4 === 3) { fs.mkdirSync(STORAGE(), { recursive: true }); fs.writeFileSync(ARQ_EXT(), JSON.stringify({ ...E, parcial: true, conta_id: contaId })); }   // grava aos poucos: a tela ja mostra o que foi lido
    }
    E.desde = E.desde && E.desde < inicio ? E.desde : inicio; E.atualizado_em = new Date().toISOString(); E.conta_id = contaId; delete E.parcial;
    fs.mkdirSync(STORAGE(), { recursive: true }); fs.writeFileSync(ARQ_EXT(), JSON.stringify(E));
    return n;
}
// transferencias para a PROPRIA empresa (Pix para outra conta do mesmo CNPJ) nao sao receita nem despesa: ficam num grupo a parte e fora dos totais
const cnpjProprio = () => { const e = lerJson(path.join(STORAGE(), 'olist_empresa.json'), null); return e && e.cnpj ? String(e.cnpj).replace(/\D/g, '') : null; };
const GRUPO_INTERNO = 'Movimento interno (reservas e transferências para a própria empresa)';
const ehInterna = (x, prop) => /dinheiro (reservado|retirado)/i.test(String(x.desc || '')) || !!(prop && x.cnpj && x.cnpj === prop && (x.op === 'PIX' || /pix|transfer/i.test(x.desc)));
// consulta do extrato guardado: { de, ate, tipo: 'INFLOW'|'OUTFLOW', grupo, q } -> totais, por grupo, por dia e as linhas (ate 1000)
function extrato({ de = null, ate = null, tipo = null, grupo = null, q = null } = {}) {
    const E = lerJson(ARQ_EXT(), null); if (!E) return { lido: false, linhas: [] };
    const prop = cnpjProprio(), busca = q ? norm(q) : null;
    let L = Object.values(E.itens).map(x => ehInterna(x, prop) ? { ...x, grupo: GRUPO_INTERNO, interna: true } : { ...x, grupo: classificar(x.desc, x.op, x.tipo) })
        .filter(x => (!de || x.dia >= de) && (!ate || x.dia <= ate) && (!tipo || x.tipo === tipo) && (!grupo || x.grupo === grupo) && (!busca || norm(x.desc + ' ' + x.grupo + ' ' + x.valor).includes(busca)));
    L.sort((a, b) => String(b.em || b.dia).localeCompare(String(a.em || a.dia)));
    const reais = L.filter(x => !x.interna), soma = (F, f) => r2(F.filter(f).reduce((t, x) => t + x.valor, 0));
    const porGrupo = {}, porDia = {};
    for (const x of L) { const g = porGrupo[x.grupo] ||= { grupo: x.grupo, qtd: 0, entrou: 0, saiu: 0, interna: !!x.interna }; g.qtd++; if (x.valor >= 0) g.entrou = r2(g.entrou + x.valor); else g.saiu = r2(g.saiu + x.valor);
        if (x.interna) continue; const d = porDia[x.dia] ||= { dia: x.dia, qtd: 0, entrou: 0, saiu: 0 }; d.qtd++; if (x.valor >= 0) d.entrou = r2(d.entrou + x.valor); else d.saiu = r2(d.saiu + x.valor); }
    return { lido: true, parcial: !!E.parcial, atualizado_em: E.atualizado_em, desde: E.desde,
        resumo: { qtd: reais.length, entrou: soma(reais, x => x.valor >= 0), saiu: soma(reais, x => x.valor < 0), liquido: r2(reais.reduce((t, x) => t + x.valor, 0)),
            internas: { qtd: L.length - reais.length, entrou: soma(L.filter(x => x.interna), x => x.valor >= 0), saiu: soma(L.filter(x => x.interna), x => x.valor < 0) } },
        grupos: Object.values(porGrupo).sort((a, b) => (a.interna ? 1 : 0) - (b.interna ? 1 : 0) || Math.abs(b.entrou + b.saiu) - Math.abs(a.entrou + a.saiu)), dias: Object.values(porDia).sort((a, b) => a.dia.localeCompare(b.dia)), linhas: L.slice(0, 1000), cortado: L.length > 1000 };
}
// movimentos por dia (so entrou / saiu), para o calendario do Fluxo de caixa
function realizadoPorDia(de, ate) { const E = lerJson(ARQ_EXT(), null); if (!E || E.parcial) return null; /* leitura pela metade: nao serve para o calendario */ const o = {};
    const prop = cnpjProprio();
    for (const x of Object.values(E.itens)) { if (x.dia < de || x.dia > ate || ehInterna(x, prop)) continue; const d = o[x.dia] ||= { entrou: 0, saiu: 0, qtd: 0 }; d.qtd++; if (x.valor >= 0) d.entrou = r2(d.entrou + x.valor); else d.saiu = r2(d.saiu + x.valor); }
    return { dias: o, desde: E.desde, atualizado_em: E.atualizado_em }; }
// pagamentos de boleto no banco, para conferir com as contas a pagar do Olist
function boletosPagos(de) { const E = lerJson(ARQ_EXT(), null); if (!E || E.parcial) return null; /* leitura pela metade: nao confere boleto (daria falso "sem pagamento") */
    return { desde: E.desde, atualizado_em: E.atualizado_em, itens: Object.values(E.itens).filter(x => classificar(x.desc, x.op, x.tipo) === 'Boletos pagos' && x.valor < 0 && x.dia >= (de || '0000-00-00')).map(x => ({ id: x.id, dia: x.dia, valor: -x.valor, desc: x.desc, cnpj: x.cnpj })) }; }

// ---------------------------------------------------------------- uso pela tela e pelo Fluxo de caixa
async function estado() {
    let conectada = false, uid = null; try { uid = await usuario(); conectada = !!(lerToken(uid) && lerToken(uid).access_token); } catch {}
    return { conectada, login: est.login, rodando: est.rodando, etapa: est.etapa, erro: est.erro, dados: lerJson(ARQ(), null) };
}
function saldoParaFluxo() {
    const d = lerJson(ARQ(), null); if (!d || !d.conta) return null;
    // saldo do banco = disponivel + reservas ("Emergencia"); o bloqueado (retido pelo Mercado Pago) fica de fora
    const disponivel = d.conta.disponivel || 0, reservas = d.conta.total_reservas || 0;
    return { valor: r2(disponivel + reservas), disponivel, reservas, bloqueado: d.conta.bloqueado || 0, fonte: 'Belvo (Open Finance) · disponível + reservas', em: d.conta.coletado_em || d.coletado_em, lido_em: d.coletado_em };
}
function dadosParaTela() { return lerJson(ARQ(), null); }
async function desconectar() { try { fs.unlinkSync(arqToken(await usuario())); } catch {} try { fs.unlinkSync(ARQ()); } catch {} try { fs.unlinkSync(ARQ_EXT()); } catch {} est.login = null; est.erro = null; return { ok: true }; }

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

module.exports = { extrato, realizadoPorDia, boletosPagos, classificar, iniciarLogin, finalizarLogin, coletar, estado, saldoParaFluxo, dadosParaTela, desconectar, iniciarAgendador, pararAgendador, resumirContas, lerResposta, CLIENT_ID };
