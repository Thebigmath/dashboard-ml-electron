// Ponte com o Nubimetrics (MCP over streamable HTTP), falada direto do Node.
//
// O limite é POR TOKEN e vale para tudo que o usa — este app, o outro app, o
// Astra do Seven e o Claude. Estourar não dá erro pontual: derruba TODAS as
// consultas por até uma hora. Por isso aqui nada é "tentar e ver no que dá":
//
//   1. MODO CALMO — 1 chamada por vez, 6 s entre elas, 10/min e 300/h, bem
//      abaixo dos 50/min e 800/h do Nubimetrics. Sobra folga para os outros.
//   2. CONTADOR PERSISTENTE — as chamadas ficam em chamadas.json, então fechar
//      o app não zera o limite (o Nubimetrics também não zera).
//   3. BLOQUEIO LEMBRADO — se vier "retry after", grava o horário e NEM CONECTA
//      até lá. Insistir durante o bloqueio costuma aumentar a punição.
//   4. CACHE LONGO — os dados deles mudam ~1x por dia; 24 h de validade. Quase
//      toda consulta repetida sai do disco, sem gastar cota.
//
// Regra de ouro: nenhuma falha daqui derruba o app. Sempre volta {erro} ou
// {bloqueado}, e a tela mostra o motivo.
//
// Token: NUBIMETRICS_TOKEN ou Documents/MCP_Nubimetrics/.mcp.json.
const fs = require('fs');
const os = require('os');
const path = require('path');

// A cota do Nubimetrics e POR TOKEN, nao por app: se cada dashboard contasse no
// proprio storage, os dois juntos passariam do limite achando que estao dentro.
// Por isso contador, bloqueio e cache ficam numa pasta COMPARTILHADA.
const COMPARTILHADO = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'nubimetrics-cota');
const PASTA = process.env.NUBIMETRICS_DIR || COMPARTILHADO;
const ARQ_CHAMADAS = path.join(PASTA, 'chamadas.json');
const ARQ_BLOQUEIO = path.join(PASTA, 'bloqueio.json');
const CACHE = path.join(PASTA, 'cache');

const URL_PADRAO = 'https://mcp.nubimetrics.com/mcp';
const INTERVALO_MS = 6000;          // espaçamento entre chamadas
const POR_MINUTO = 10;
const POR_HORA = 300;
const VALIDADE_MS = 24 * 3600 * 1000;

function lerJson(arquivo, padrao) {
    try { return JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch { return padrao; }
}
function salvarJson(arquivo, dados) {
    try {
        fs.mkdirSync(path.dirname(arquivo), { recursive: true });
        fs.writeFileSync(arquivo, JSON.stringify(dados), 'utf8');
    } catch {}
}

function credenciais() {
    const env = process.env.NUBIMETRICS_TOKEN;
    if (env) return { url: URL_PADRAO, auth: /^bearer /i.test(env) ? env : 'Bearer ' + env };
    const p = path.join(os.homedir(), 'Documents', 'MCP_Nubimetrics', '.mcp.json');
    const cfg = lerJson(p, null);
    const srv = cfg && cfg.mcpServers && cfg.mcpServers.nubimetrics;
    if (!srv || !srv.headers || !srv.headers.Authorization) return null;
    return { url: srv.url || URL_PADRAO, auth: srv.headers.Authorization };
}

// ── limites ────────────────────────────────────────────────────────────────

function bloqueadoAte() {
    const b = lerJson(ARQ_BLOQUEIO, {});
    return b.ate && b.ate > Date.now() ? b.ate : 0;
}
function anotarBloqueio(ms) {
    salvarJson(ARQ_BLOQUEIO, { ate: Math.max(Date.now() + ms, bloqueadoAte()) });
}

function historico() {
    const h = lerJson(ARQ_CHAMADAS, []);
    const corte = Date.now() - 3600000;
    return Array.isArray(h) ? h.filter(t => t > corte) : [];
}

// Espera o tempo necessário para respeitar as três regras (intervalo, minuto, hora).
async function aguardarVez() {
    for (;;) {
        const h = historico();
        const agora = Date.now();
        let espera = 0;
        const noMinuto = h.filter(t => agora - t < 60000).length;
        if (noMinuto >= POR_MINUTO) espera = Math.max(espera, 60000 - (agora - h[h.length - noMinuto]));
        if (h.length >= POR_HORA) espera = Math.max(espera, 3600000 - (agora - h[0]));
        const ultima = h.length ? h[h.length - 1] : 0;
        if (agora - ultima < INTERVALO_MS) espera = Math.max(espera, INTERVALO_MS - (agora - ultima));
        if (espera <= 0) {
            salvarJson(ARQ_CHAMADAS, [...h, agora]);
            return;
        }
        await new Promise(r => setTimeout(r, Math.min(espera, 30000)));
    }
}

// ── MCP (streamable HTTP, sem SDK) ─────────────────────────────────────────

let sessao = null;
let iniciado = false;
let fila = Promise.resolve();   // serializa: uma chamada por vez

async function rpc(cred, metodo, params, notificacao = false) {
    const corpo = { jsonrpc: '2.0', method: metodo, ...(params ? { params } : {}) };
    if (!notificacao) corpo.id = Math.floor(Math.random() * 1e9);
    const r = await fetch(cred.url, {
        method: 'POST',
        headers: {
            Authorization: cred.auth,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            ...(sessao ? { 'Mcp-Session-Id': sessao } : {}),
        },
        body: JSON.stringify(corpo),
        // a busca do Nubimetrics passa de 1 min com frequencia; cortar em 60 s
        // gastava a cota da chamada e nao trazia nada
        signal: AbortSignal.timeout(180000),
    });
    const sid = r.headers.get('mcp-session-id');
    if (sid) sessao = sid;
    if (notificacao) return null;
    const texto = await r.text();
    if (!r.ok) throw new Error(`${r.status} ${texto.slice(0, 160)}`);
    if (!texto.trim()) return null;
    // a resposta vem como JSON puro ou como SSE ("data: {...}")
    if (texto.trimStart().startsWith('{')) return JSON.parse(texto);
    const linha = texto.split('\n').find(l => l.startsWith('data:'));
    if (!linha) throw new Error('resposta inesperada do MCP');
    return JSON.parse(linha.slice(5).trim());
}

async function garantirSessao(cred) {
    if (iniciado && sessao) return;
    await rpc(cred, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'dashboard-ml', version: require('../package.json').version },
    });
    await rpc(cred, 'notifications/initialized', {}, true);
    iniciado = true;
}

/** Chama uma ferramenta do Nubimetrics. Nunca lança: devolve { ok } ou { erro }. */
async function chamar(ferramenta, inp) {
    const cred = credenciais();
    if (!cred) return { erro: 'Token do Nubimetrics não encontrado (Documents/MCP_Nubimetrics/.mcp.json).' };

    const ate = bloqueadoAte();
    if (ate) {
        return { bloqueado: true, ate, erro: `Nubimetrics bloqueado até ${new Date(ate).toLocaleTimeString('pt-BR')}. Nenhuma chamada foi feita.` };
    }

    // a fila garante uma por vez mesmo com várias gavetas abrindo juntas
    return (fila = fila.then(async () => {
        if (bloqueadoAte()) return { bloqueado: true, ate: bloqueadoAte(), erro: 'Nubimetrics bloqueado.' };
        try {
            await aguardarVez();
            await garantirSessao(cred);
            const r = await rpc(cred, 'tools/call', { name: ferramenta, arguments: { inp } });
            const bloco = (r && r.result && r.result.content || []).find(b => b.type === 'text');
            const texto = bloco ? bloco.text : '';
            if (/rate limit/i.test(texto)) {
                const m = texto.match(/retry after (\d+)/i);
                const segundos = m ? Math.min(Number(m[1]), 3600) : 3600;
                anotarBloqueio(segundos * 1000);
                return { bloqueado: true, ate: bloqueadoAte(), erro: `Nubimetrics: limite atingido. Volta em ${Math.ceil(segundos / 60)} min.` };
            }
            if (r && r.result && r.result.isError) return { erro: texto.slice(0, 200) };
            try { return { ok: true, dados: JSON.parse(texto) }; }
            catch { return { ok: true, dados: { texto } }; }
        } catch (e) {
            // sessão pode ter expirado: derruba para reconectar na próxima
            iniciado = false; sessao = null;
            return { erro: String(e.message || e).slice(0, 200) };
        }
    }, () => ({ erro: 'falha na fila do Nubimetrics' })));
}

/** Igual a chamar(), mas resolve do cache antes (24 h) — é o que segura a cota. */
async function comCache(chave, ferramenta, inp) {
    const arq = path.join(CACHE, chave.replace(/[^\w.-]+/g, '_').slice(0, 120) + '.json');
    const guardado = lerJson(arq, null);
    if (guardado && Date.now() - guardado.t < VALIDADE_MS) {
        return { ...guardado.v, doCache: true, idade_min: Math.round((Date.now() - guardado.t) / 60000) };
    }
    const r = await chamar(ferramenta, inp);
    if (r.ok) salvarJson(arq, { t: Date.now(), v: r });
    // bloqueado ou com erro: devolve o cache velho, se houver — melhor um dado de
    // ontem com a idade à mostra do que uma tela vazia
    else if (guardado) return { ...guardado.v, doCache: true, vencido: true, idade_min: Math.round((Date.now() - guardado.t) / 60000), aviso: r.erro };
    return r;
}

/** Quanto de cota ainda dá para gastar agora (para a tela poder avisar). */
function situacao() {
    const h = historico();
    const agora = Date.now();
    return {
        tem_token: !!credenciais(),
        bloqueado_ate: bloqueadoAte() || null,
        no_minuto: h.filter(t => agora - t < 60000).length, limite_minuto: POR_MINUTO,
        na_hora: h.length, limite_hora: POR_HORA,
    };
}

module.exports = { chamar, comCache, situacao, bloqueadoAte };
