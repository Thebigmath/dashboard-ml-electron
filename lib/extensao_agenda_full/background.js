// SEVEN · Agenda do Full (extensao do Chrome). Usa o login do Mercado Livre que ja esta neste Chrome.
// UMA EXTENSAO POR CONTA (pedido do usuario, 14/10/2026): cada Dashboard copia a sua para a sua pasta
// (.seven/extensao_agenda_full_flavia | _cordeiro) com um config.json dizendo a conta e as portas dele;
// assim a versao de uma conta nunca mexe na outra. Ela pega "tarefas" so do Dashboard dela,
// faz as consultas na Gestao de envios Full e devolve o resultado. Cada Dashboard so aceita a extensao
// se a conta logada aqui for a conta dele. Nao abre abas para consultar; a unica acao que abre uma aba
// (em segundo plano) e a confirmacao de horario, que so acontece quando o usuario clica Confirmar no SEVEN.
const ML = 'https://vendedores.mercadolivre.com.br';
let PORTAS = [], CONTA = null;
const estado = { seller: null, conta_em: 0, portas: {}, ultimo: null, conta: null };
// config.json da pasta (escrito pelo Dashboard): { conta: 'flavia', nome: 'Flavia', portas: [3001, 3911] }
const pronto = fetch(chrome.runtime.getURL('config.json')).then(r => r.json()).then(c => { CONTA = c.conta || null; PORTAS = c.portas || []; estado.conta = c.nome || c.conta; })
    .catch(() => { PORTAS = []; });
const VERSAO = chrome.runtime.getManifest().version;
// o Chrome adormece o service worker depois de ~30 s sem chamada de API: este "ping" o mantem acordado
setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 10000);

async function minhaConta() {
    if (estado.seller && Date.now() - estado.conta_em < 60000) return estado.seller;
    try {
        const r = await fetch(ML + '/api/shipping/inbounds/search?offset=0&limit=1', { credentials: 'include', headers: { accept: 'application/json' } });
        const j = r.ok ? await r.json().catch(() => null) : null;
        const novo = j && j.seller_id ? String(j.seller_id) : null;
        estado.ultimo = { status: r.status, url: r.url.slice(0, 80), em: Date.now() };
        // uma falha isolada nao derruba a conta que ja estava confirmada
        if (novo || !estado.seller || r.status === 401 || r.status === 403) estado.seller = novo;
    } catch (e) { estado.ultimo = { status: 0, erro: String(e && e.message || e).slice(0, 80), em: Date.now() }; }
    estado.conta_em = Date.now();
    return estado.seller;
}

async function executar(t) {
    if (t.tipo === 'get') {
        const r = await fetch(ML + t.url, { credentials: 'include', headers: { accept: 'application/json' } });
        const txt = await r.text(); let dados = null; try { dados = JSON.parse(txt); } catch {}
        return { status: r.status, ok: r.ok, dados: dados ?? txt.slice(0, 300) };
    }
    if (t.tipo === 'confirmar') {
        // dentro da pagina do proprio site (protecao x-csrf-token da pagina), numa aba em segundo plano
        const tab = await chrome.tabs.create({ url: ML + '/shipping/inbounds', active: false });
        try {
            await new Promise((res) => { const f = (id, info) => { if (id === tab.id && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(f); res(); } }; chrome.tabs.onUpdated.addListener(f); setTimeout(res, 20000); });
            const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', args: [t.envio, t.seller, t.corpo], func: async (envio, seller, corpo) => {
                const lock = await fetch('/api/shipping/inbounds/' + envio + '/appointment-v2/' + seller + '/lock-status', { credentials: 'include' });
                if (!lock.ok) return { status: lock.status, ok: false, dados: 'conferência de bloqueio falhou' };
                const meta = document.querySelector('meta[name=csrf-token]');
                const resp = await fetch('/api/shipping/inbounds/' + envio + '/appointment-v2/confirm', { method: 'POST', credentials: 'include',
                    headers: { 'content-type': 'application/json', accept: 'application/json', ...(meta && meta.content ? { 'x-csrf-token': meta.content } : {}) }, body: JSON.stringify(corpo) });
                const txt = await resp.text(); let dados = null; try { dados = JSON.parse(txt); } catch {}
                return { status: resp.status, ok: resp.ok, dados: dados ?? txt.slice(0, 500) };
            } });
            return r && r.result ? r.result : { status: 0, ok: false, dados: 'sem resposta da página' };
        } finally { chrome.tabs.remove(tab.id).catch(() => {}); }
    }
    if (t.tipo === 'abrir') {
        // abre a tela do ML NESTE Chrome (o da conta certa) e traz a janela para a frente
        const tab = await chrome.tabs.create({ url: ML + t.url, active: true });
        await chrome.windows.update(tab.windowId, { focused: true, drawAttention: true }).catch(() => {});
        return { status: 200, ok: true, dados: 'aberto' };
    }
    return { status: 0, ok: false, dados: 'tarefa desconhecida' };
}

// um laco por Dashboard: pede tarefas (o SEVEN segura o pedido ate ter tarefa ou 20 s), executa e devolve
const lacos = {};
async function laco(porta) {
    if (lacos[porta]) return; lacos[porta] = true;
    const base = `http://127.0.0.1:${porta}/api/agenda-full/ext`;
    try {
        for (let i = 0; i < 400; i++) {
            chrome.runtime.getPlatformInfo(() => {});   // mantem o service worker acordado enquanto ha Dashboard ouvindo
            const seller = await minhaConta();
            let d;
            try {
                const u = estado.ultimo || {};
                const r = await fetch(`${base}/tarefas?conta=${CONTA || ''}&seller=${seller || ''}&v=${VERSAO}&st=${u.status ?? ''}&er=${encodeURIComponent(u.erro || u.url || '')}`, { signal: AbortSignal.timeout(25000) });
                d = await r.json();
                if (d.recarregar) {   // o SEVEN tem uma versao nova na pasta: recarrega sozinha (no maximo 1 vez a cada 2 min)
                    const { ultimaRecarga = 0 } = await chrome.storage.local.get('ultimaRecarga');
                    if (Date.now() - ultimaRecarga > 120000) { await chrome.storage.local.set({ ultimaRecarga: Date.now() }); chrome.runtime.reload(); return; }
                    break;
                }
            } catch { estado.portas[porta] = { ativo: false, em: Date.now() }; break; }   // Dashboard fechado: o alarme tenta de novo
            estado.portas[porta] = { ativo: !d.ignorar, conta: d.conta || null, motivo: d.motivo || null, em: Date.now() };
            if (d.ignorar) break;   // outro Dashboard (outra conta): nao fica ocupando
            for (const t of d.tarefas || []) {
                let res; try { res = await executar(t); } catch (e) { res = { status: 0, ok: false, dados: String(e && e.message || e) }; }
                await fetch(`${base}/resultado`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: t.id, ...res }) }).catch(() => {});
            }
        }
    } finally { lacos[porta] = false; }
}
function acordar() { pronto.then(() => { for (const p of PORTAS) laco(p); }); }

chrome.alarms.create('seven', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(acordar);
chrome.runtime.onStartup.addListener(acordar);
chrome.runtime.onInstalled.addListener(acordar);
chrome.runtime.onMessage.addListener((m, _s, responder) => { if (m === 'estado') { minhaConta().then(() => responder(estado)); return true; } });
acordar();
