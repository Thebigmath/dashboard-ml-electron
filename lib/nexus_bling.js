// Nexus: motor de integracao do SEVEN com o Bling ERP (API v3). So o motor, sem tela (pedido de 21/10/2026).
//   Credenciais e token em ~/.seven/bling.json (fora do git, compartilhado pela Flavia e pelo Cordeiro).
//   O Bling ROTACIONA o refresh_token: cada renovacao invalida o anterior. Por isso a renovacao tem trava em
//   memoria (nunca duas no mesmo app) e trava em ARQUIVO (~/.seven/bling.lock, criado com 'wx') para os dois apps
//   nunca renovarem juntos; com a trava na mao, rele o bling.json (o outro app pode ter renovado) e grava o novo
//   token na hora, de forma atomica (arquivo temporario + rename). Lock com mais de 60 s e tido como abandonado.
//   Limite do Bling ~3 req/s: todas as chamadas passam por uma fila com ~350 ms entre elas; 429 => espera e tenta de novo.
//   Esta versao e so de leitura. Renovacoes de token ficam registradas em ~/.seven/nexus_log.jsonl (sem segredos).
const fs = require('fs');
const os = require('os');
const path = require('path');

const PASTA = path.join(os.homedir(), '.seven');
const ARQ_CFG = path.join(PASTA, 'bling.json');
const ARQ_LOG = path.join(PASTA, 'nexus_log.jsonl');
const ARQ_LOCK = path.join(PASTA, 'bling.lock');
const LOCK_MAX_MS = 60000;   // lock mais velho que isso = abandonado
const LOCK_POLL_MS = 500;
const API = 'https://api.bling.com.br/Api/v3';
const URL_TOKEN = 'https://www.bling.com.br/Api/v3/oauth/token';
const PAUSA_MS = 350;
const MARGEM_S = 600;   // renova quando faltar menos de 10 min
const dormir = (ms) => new Promise(r => setTimeout(r, ms));

function lerCfg() {
    try { return JSON.parse(fs.readFileSync(ARQ_CFG, 'utf8')); }
    catch { throw new Error('Bling não configurado (~/.seven/bling.json ausente ou inválido).'); }
}
function gravarAtomico(arq, v) {
    fs.mkdirSync(PASTA, { recursive: true });
    const tmp = arq + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(v, null, 2), 'utf8');
    fs.renameSync(tmp, arq);
}
// log das acoes do motor (Escalada de Prata: tudo logado). Nunca grava token nem segredo.
function registrar(acao, dados) {
    try { fs.mkdirSync(PASTA, { recursive: true }); fs.appendFileSync(ARQ_LOG, JSON.stringify({ em: new Date().toISOString(), app: 'flavia', acao, ...dados }) + '\n', 'utf8'); } catch {}
}

// ---- token ----
const expiraEm = (t) => Number(t?.criado_em || 0) + Number(t?.expires_in || 0);   // epoch s
const restante = (t) => expiraEm(t) - Date.now() / 1000;

// trava entre processos: cria o lock de forma exclusiva; se outro app tem a trava, espera (ate 60 s)
function idadeLock() { try { return Date.now() - fs.statSync(ARQ_LOCK).mtimeMs; } catch { return null; } }
async function pegarTrava() {
    fs.mkdirSync(PASTA, { recursive: true });
    const marca = JSON.stringify({ pid: process.pid, em: new Date().toISOString() });
    const inicio = Date.now();
    for (;;) {
        try { const fd = fs.openSync(ARQ_LOCK, 'wx'); try { fs.writeSync(fd, marca); } finally { fs.closeSync(fd); } return { marca, esperou_ms: Date.now() - inicio }; }
        catch (e) { if (e.code !== 'EEXIST') throw e; }
        const idade = idadeLock();
        if (idade !== null && idade > LOCK_MAX_MS) { try { fs.unlinkSync(ARQ_LOCK); } catch {} registrar('lock_abandonado_removido', { idade_s: Math.round(idade / 1000) }); continue; }
        await dormir(LOCK_POLL_MS);
    }
}
// so apaga o lock se ainda for o nosso
function soltarTrava(t) { try { if (t && fs.readFileSync(ARQ_LOCK, 'utf8') === t.marca) fs.unlinkSync(ARQ_LOCK); } catch {} }

let renovando = null;   // trava: uma unica renovacao por vez neste processo
function renovar(motivo = 'expirando', tokenVisto = null) {
    if (renovando) return renovando;
    renovando = (async () => {
        const trava = await pegarTrava();
        try { return await renovarComTrava(motivo, tokenVisto, trava); }
        finally { soltarTrava(trava); }
    })().finally(() => { renovando = null; });
    return renovando;
}
async function renovarComTrava(motivo, tokenVisto, trava) {
    const cfg = lerCfg();   // relido com a trava na mao
    // o outro app (ou outra chamada) pode ja ter renovado: se o token do arquivo mudou e esta valido, usa ele
    if (cfg.token?.access_token && cfg.token.access_token !== tokenVisto && restante(cfg.token) > MARGEM_S) {
        if (trava.esperou_ms >= LOCK_POLL_MS) registrar('token_ja_renovado_por_outro', { motivo, esperou_s: Math.round(trava.esperou_ms / 1000) });
        return cfg.token.access_token;
    }
    if (!cfg.token?.refresh_token) throw new Error('Bling sem refresh_token: refaça a autorização.');
    const basic = Buffer.from(cfg.client_id + ':' + cfg.client_secret).toString('base64');
    const r = await fetch(URL_TOKEN, {
        method: 'POST',
        headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cfg.token.refresh_token }),
        signal: AbortSignal.timeout(30000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) {
        registrar('token_renovacao_falhou', { motivo, status: r.status, erro: String(j.error?.type || j.error || '').slice(0, 80) });
        throw new Error('Bling recusou a renovação do token (HTTP ' + r.status + ').');
    }
    cfg.token = { ...j, criado_em: Math.floor(Date.now() / 1000) };
    gravarAtomico(ARQ_CFG, cfg);   // grava ANTES de qualquer outra coisa: o refresh anterior ja morreu
    registrar('token_renovado', { motivo, expira_em: new Date(expiraEm(cfg.token) * 1000).toISOString() });
    return cfg.token.access_token;
}
async function accessToken() {
    const t = lerCfg().token;
    if (t?.access_token && restante(t) > MARGEM_S) return t.access_token;
    return renovar('expirando', t?.access_token || null);
}
// situacao do token sem expor nada secreto
function estadoToken() {
    const t = lerCfg().token || {};
    return { tem_token: !!t.access_token, expira_em: t.criado_em ? new Date(expiraEm(t) * 1000).toISOString() : null, minutos_restantes: t.criado_em ? Math.round(restante(t) / 60) : null };
}

// ---- fila de chamadas (~3 req/s) ----
let ultima = Promise.resolve();
let ultimaEm = 0;
function naFila(fn) {
    const p = ultima.then(async () => {
        const falta = ultimaEm + PAUSA_MS - Date.now();
        if (falta > 0) await dormir(falta);
        try { return await fn(); } finally { ultimaEm = Date.now(); }
    });
    ultima = p.catch(() => {});
    return p;
}

function montarUrl(rota, params) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
        if (v === undefined || v === null || v === '') continue;
        if (Array.isArray(v)) v.forEach(x => q.append(k.endsWith('[]') ? k : k + '[]', x)); else q.append(k, v);
    }
    const s = q.toString();
    return API + '/' + String(rota).replace(/^\/+/, '') + (s ? '?' + s : '');
}

// GET generico. Devolve o JSON inteiro do Bling ({ data: ... }); 404 => null.
async function get(rota, params = {}) {
    const url = montarUrl(rota, params);
    let renovou = false;
    for (let t = 0; t < 6; t++) {
        const tk = await accessToken();
        let r;
        try { r = await naFila(() => fetch(url, { headers: { Authorization: 'Bearer ' + tk, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) })); }
        catch { await dormir(2000 * (t + 1)); continue; }
        if (r.status === 429) { await dormir(1500 * (t + 1)); continue; }
        if (r.status === 401 && !renovou) { renovou = true; await renovar('401', tk); continue; }
        if (r.status === 404) return null;
        if (r.status >= 500) { await dormir(2000 * (t + 1)); continue; }
        const j = await r.json().catch(() => null);
        if (!r.ok) throw new Error('Bling ' + r.status + ': ' + JSON.stringify(j?.error || j || '').slice(0, 200));
        return j;
    }
    throw new Error('O Bling não respondeu (' + rota + ').');
}

// percorre todas as paginas de uma lista (limite 100) ate vir uma pagina incompleta
async function todasPaginas(rota, params = {}, { maxPaginas = Infinity, aoPaginar } = {}) {
    const lista = [];
    for (let pagina = 1; pagina <= maxPaginas; pagina++) {
        const j = await get(rota, { ...params, pagina, limite: 100 });
        const d = j?.data || [];
        lista.push(...d);
        if (aoPaginar) aoPaginar({ pagina, total: lista.length });
        if (d.length < 100) break;
    }
    return lista;
}

// ---- produtos ----
// criterio: 1 ultimos incluidos, 2 ativos, 3 inativos, 4 excluidos, 5 todos. filtros extras vao direto na query.
const CRITERIO = { ultimos: 1, ativos: 2, inativos: 3, excluidos: 4, todos: 5 };
function listarProdutos({ criterio = 5, maxPaginas, aoPaginar, ...filtros } = {}) {
    return todasPaginas('produtos', { criterio: CRITERIO[criterio] || criterio, ...filtros }, { maxPaginas, aoPaginar });
}
function listarProdutosPagina(pagina = 1, { criterio = 5, limite = 100, ...filtros } = {}) {
    return get('produtos', { criterio: CRITERIO[criterio] || criterio, ...filtros, pagina, limite }).then(j => j?.data || []);
}
// ficha completa: dimensoes, tributacao, midia.imagens, estrutura.componentes (kit 'E'), variacoes (formato 'V')
async function obterProduto(id) { const j = await get('produtos/' + encodeURIComponent(id)); return j?.data || null; }

// ---- categorias ----
async function categorias() { return todasPaginas('categorias/produtos'); }
// a lista nao traz a "Categoria padrão" do Bling; por id ela vem
async function obterCategoria(id) { const j = await get('categorias/produtos/' + encodeURIComponent(id)); return j?.data || null; }
// mapa id -> { nome, caminho: 'Pai > Filho' } para traduzir produto.categoria.id
async function mapaCategorias() {
    const lista = await categorias();
    const porId = new Map(lista.map(c => [String(c.id), c]));
    const caminho = (c, prof = 0) => {
        const pai = c.categoriaPai?.id && porId.get(String(c.categoriaPai.id));
        return pai && prof < 10 ? caminho(pai, prof + 1) + ' > ' + c.descricao : c.descricao;
    };
    const mapa = {};
    for (const c of lista) mapa[c.id] = { nome: c.descricao, caminho: caminho(c) };
    return mapa;
}

module.exports = { get, todasPaginas, listarProdutos, listarProdutosPagina, obterProduto, categorias, obterCategoria, mapaCategorias, estadoToken, renovar, registrar, CRITERIO };
