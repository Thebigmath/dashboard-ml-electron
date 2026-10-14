// Agenda do Full (pedido do usuario em 14/10/2026): vigiar o dia/hora/galpao que queremos para o envio Full
// e avisar NA HORA que a vaga abrir (na Black Friday a agenda lota e quem pega primeiro leva).
//
// A API oficial do ML nao lista envios Full nem a agenda. Usamos as mesmas rotas internas do site do
// Central de Vendedores (/api/shipping/inbounds/...), com a sessao do ML de um Chrome. Dois transportes:
//   'extensao' (padrao) .. a extensao "SEVEN · Agenda do Full" instalada no Chrome do dia a dia, onde a conta
//                          ja esta logada (o usuario nao quer logar de novo): ela pega as tarefas daqui
//                          (long-poll em /api/agenda-full/ext/tarefas), consulta o ML e devolve. Cada Dashboard
//                          so aceita a extensao se a conta logada for a dele.
//   'chrome' .............. um Chrome proprio, fora da tela (tecnica do MLScraper/Issacar), controlado pela
//                          porta de debug; precisa de um login proprio. config: agenda_full_transporte = 'chrome'
//
//   estado() ........ Chrome ligado? logado? qual conta? e a mesma conta do token deste Dashboard?
//   envios() ........ todos os envios Full (status, data reservada, unidades, galpao), com historico de mudancas
//   horarios(id) .... horarios livres por galpao e dia (proximos ~2 meses), como no site
//   vigias .......... "quero o envio X no dia D entre HH:MM e HH:MM nos galpoes A/B": consulta a cada N s e avisa
//   confirmar() ..... reserva a vaga com o mesmo pedido do botao Confirmar do site.
//                     DESLIGADO nesta fase: so com config.json -> agenda_full_confirmar = true (decisao do usuario)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const BASE = 'https://vendedores.mercadolivre.com.br';
const ARQ_ENVIOS = path.join(STORAGE, 'agenda_full_envios.json');
const ARQ_HIST = path.join(STORAGE, 'agenda_full_historico.jsonl');
const ARQ_VIGIAS = path.join(STORAGE, 'agenda_full_vigias.json');
const INTERVALO_MIN_S = 15, INTERVALO_PADRAO_S = 30;
const TIPOS = { ftl: 'Veículo particular', pickup: 'Coleta a domicílio', supplier: 'Envio pelo fornecedor' };
const STATUS = { working: 'Em preparação', confirmed: 'Recebimento pendente', cancelled: 'Cancelado', closed_ok: 'Processamento finalizado',
    closed_with_changes: 'Finalizado com alterações', processed_with_problems: 'Com problemas para resolver', in_transit: 'A caminho', receiving: 'Recebendo', received: 'Recebido', expired: 'Expirado' };
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
const gravar = (arq, v) => { fs.mkdirSync(path.dirname(arq), { recursive: true }); fs.writeFileSync(arq, JSON.stringify(v, null, 1), 'utf8'); };
const config = () => lerJson(path.join(STORAGE, 'config.json'), {});
const dormir = (ms) => new Promise(r => setTimeout(r, ms));

// ---- o Chrome proprio de cada conta --------------------------------------------------------------
// Porta e perfil por app: Flavia (3001) -> 9231, Cordeiro (3002) -> 9232. O perfil fica fora do AppData
// para o laboratorio e o app usarem o mesmo login.
function porta() { const c = config(); return Number(c.agenda_full_porta) || 9230 + ((Number(c.app_porta) || 3001) - 3000); }
function perfil() { return config().agenda_full_perfil || path.join(os.homedir(), '.seven', 'chrome_full_' + porta()); }
function chromeExe() {
    const c = config().agenda_full_chrome;
    const op = [c, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')].filter(Boolean);
    return op.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}
async function versao() {
    try { const r = await fetch(`http://127.0.0.1:${porta()}/json/version`, { signal: AbortSignal.timeout(1500) }); return r.ok ? await r.json() : null; } catch { return null; }
}
function matar() {
    return new Promise(res => execFile('powershell', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*--remote-debugging-port=${porta()}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
        { windowsHide: true }, () => res()));
}
let modo = null;            // 'visivel' (login) | 'oculto'
let ultimoUso = 0;
async function abrir(visivel) {
    const exe = chromeExe();
    if (!exe) throw new Error('Google Chrome não encontrado neste computador.');
    await matar(); await dormir(900);
    fs.mkdirSync(perfil(), { recursive: true });
    const args = [`--user-data-dir=${perfil()}`, `--remote-debugging-port=${porta()}`, '--remote-allow-origins=*', '--no-first-run', '--no-default-browser-check',
        '--disable-session-crashed-bubble', '--disable-features=Translate,CalculateNativeWinOcclusion', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
        ...(visivel ? ['--window-size=1200,880', '--window-position=140,40', '--new-window'] : ['--window-size=1280,900', '--window-position=-32000,-32000', '--mute-audio']),
        BASE + '/shipping/inbounds'];
    spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: !visivel }).unref();
    for (let i = 0; i < 40; i++) { if (await versao()) break; await dormir(400); }
    if (!(await versao())) throw new Error('O Chrome da Agenda do Full não respondeu.');
    modo = visivel ? 'visivel' : 'oculto';
}
async function paginas() {
    const r = await fetch(`http://127.0.0.1:${porta()}/json`, { signal: AbortSignal.timeout(3000) });
    return (await r.json()).filter(t => t.type === 'page');
}
// um comando por vez no Chrome (as consultas da tela e as das vigias entram na mesma fila)
let fila = Promise.resolve();
function naFila(fn) { const p = fila.then(fn, fn); fila = p.catch(() => {}); return p; }

function cdp(wsUrl, metodo, params, timeoutMs) {
    return new Promise((res, rej) => {
        const ws = new WebSocket(wsUrl);
        const t = setTimeout(() => { try { ws.close(); } catch {} rej(new Error('o Chrome demorou para responder')); }, timeoutMs || 45000);
        ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: metodo, params }));
        ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id !== 1) return; clearTimeout(t); try { ws.close(); } catch {} m.error ? rej(new Error(m.error.message)) : res(m.result); };
        ws.onerror = () => { clearTimeout(t); rej(new Error('sem conexão com o Chrome da Agenda do Full')); };
    });
}
// roda uma funcao JS dentro da pagina do Central de Vendedores (cookies e protecao do proprio site)
async function noSite(funcao, args, { timeoutMs } = {}) {
    return naFila(async () => {
        ultimoUso = Date.now();
        if (!(await versao())) await abrir(false);
        let alvo = (await paginas()).find(t => /^https:\/\/vendedores\.mercadolivre\.com\.br\//.test(t.url));
        if (!alvo) {
            const qualquer = (await paginas())[0];
            if (!qualquer) throw new Error('O Chrome da Agenda do Full está sem aba aberta.');
            // na janela de login (visivel) nunca navegamos: o usuario pode estar no meio do login ou da verificacao
            if (modo === 'visivel' || /mercadolivre\.com\.br\/(jms|login)|lgz\/login/.test(qualquer.url)) { const e = new Error('Não conectado: faça o login no Central de Vendedores.'); e.desconectado = true; throw e; }
            await cdp(qualquer.webSocketDebuggerUrl, 'Page.navigate', { url: BASE + '/shipping/inbounds' }, 20000);
            for (let i = 0; i < 30 && !alvo; i++) { await dormir(500); alvo = (await paginas()).find(t => /^https:\/\/vendedores\.mercadolivre\.com\.br\//.test(t.url)); }
            if (!alvo) { const e = new Error('Não conectado: faça o login no Central de Vendedores.'); e.desconectado = true; throw e; }
        }
        const r = await cdp(alvo.webSocketDebuggerUrl, 'Runtime.evaluate',
            { expression: `(${funcao})(${JSON.stringify(args || {})})`, awaitPromise: true, returnByValue: true }, timeoutMs);
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'erro na página do ML');
        const v = r.result.value;
        if (v && v.__erro) { const e = new Error(v.__erro); if (v.status === 401 || v.status === 403) e.desconectado = true; throw e; }
        return v;
    });
}
// funcoes que rodam DENTRO da pagina do ML (texto, nao fecham sobre variaveis daqui)
const JS_GET = `async ({ url }) => {
    if (location.hostname !== 'vendedores.mercadolivre.com.br') return { __erro: 'Não conectado: faça o login no Central de Vendedores.', status: 401 };
    const r = await fetch(url, { credentials: 'include', headers: { accept: 'application/json' } });
    if (!r.ok) return { __erro: 'ML respondeu ' + r.status, status: r.status };
    return await r.json();
}`;

// ---- transporte pela extensao do Chrome --------------------------------------------------------------
const transporte = () => config().agenda_full_transporte === 'chrome' ? 'chrome' : 'extensao';
const ext = { seller: null, visto: 0, contaEm: 0, versao: null, outra: null, diag: null, fila: [], esperando: null, pend: new Map(), seq: 0 };
const versaoExtensao = () => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'extensao_agenda_full', 'manifest.json'), 'utf8')).version; } catch { return null; } };
async function extPedir(q) {
    ext.versao = q.v || ext.versao;
    ext.diag = { status: q.st || null, detalhe: q.er || null, em: new Date().toISOString() };
    (ext.log ||= []).push(`${new Date().toISOString().slice(11, 19)} v=${q.v || ''} seller=${q.seller || ''} st=${q.st || ''} er=${String(q.er || '').slice(0, 60)}`); ext.log = ext.log.slice(-15);
    // extensao antiga: a pasta ja tem a nova (copiada quando o SEVEN liga) -> ela se recarrega sozinha
    const nova = versaoExtensao();
    if (q.v && nova && q.v !== nova && q.v !== 'teste') {
        try { pastaExtensao(); } catch {}
        ext.desatualizada = q.v;
        // a 1.0.0 nao sabe se recarregar: recarrega-se a mao uma vez (botao de recarregar no chrome://extensions)
        return q.v === '1.0.0' ? { ignorar: true, motivo: 'extensão antiga: clique em recarregar no chrome://extensions' } : { recarregar: true };
    }
    ext.desatualizada = null;
    const esperada = await contaDoToken();
    ext.visto = Date.now();
    if (!q.seller) { if (Date.now() - ext.contaEm > 120000) ext.seller = null; return { ignorar: true, motivo: 'este Chrome não está logado no Central de Vendedores' }; }
    if (esperada && String(q.seller) !== esperada) { ext.outra = { seller: String(q.seller), em: Date.now() }; return { ignorar: true, conta: String(q.seller), motivo: `outra conta (este Dashboard é da ${esperada})` }; }
    ext.seller = String(q.seller); ext.visto = Date.now(); ext.contaEm = Date.now();
    if (ext.esperando) ext.esperando([]);   // um pedido por vez
    if (ext.fila.length) return { conta: ext.seller, tarefas: ext.fila.splice(0) };
    return new Promise(res => {
        const t = setTimeout(() => { ext.esperando = null; ext.visto = Date.now(); res({ conta: ext.seller, tarefas: [] }); }, 20000);
        ext.esperando = (tarefas) => { clearTimeout(t); ext.esperando = null; ext.visto = Date.now(); res({ conta: ext.seller, tarefas }); };
    });
}
function extResultado(r) {
    (ext.log ||= []).push(`${new Date().toISOString().slice(11, 19)} resultado id=${r && r.id} status=${r && r.status} pend=${ext.pend.has(String(r && r.id))}`); ext.log = ext.log.slice(-15);
    const p = ext.pend.get(String(r && r.id)); if (!p) return { ok: false };
    ext.pend.delete(String(r.id)); p(r); return { ok: true };
}
const extViva = () => Date.now() - ext.visto < 75000 && !!ext.seller && Date.now() - ext.contaEm < 150000;
function extExecutar(tarefa, timeoutMs = 40000) {
    if (!extViva()) {
        const e = new Error(ext.outra && Date.now() - ext.outra.em < 60000 ? `A extensão está num Chrome logado em outra conta (${ext.outra.seller}).` : 'A extensão do SEVEN no Chrome não está respondendo (Chrome fechado ou extensão não instalada).');
        e.desconectado = true; throw e;
    }
    const id = String(++ext.seq) + Date.now().toString(36);
    return new Promise((res, rej) => {
        const t = setTimeout(() => { ext.pend.delete(id); rej(new Error('a extensão do Chrome demorou para responder')); }, timeoutMs);
        ext.pend.set(id, (r) => { clearTimeout(t); res(r); });
        const item = { id, ...tarefa };
        (ext.log ||= []).push(`${new Date().toISOString().slice(11, 19)} tarefa id=${id} ${tarefa.tipo} ${String(tarefa.url || '').slice(0, 60)} entregue=${!!ext.esperando}`); ext.log = ext.log.slice(-15);
        if (ext.esperando) ext.esperando([item]); else ext.fila.push(item);
    });
}
// GET numa rota interna do ML, pelo transporte escolhido
async function mlGet(url) {
    if (transporte() === 'chrome') return noSite(JS_GET, { url });
    const r = await extExecutar({ tipo: 'get', url });
    if (!r.ok) { const e = new Error(r.status === 401 || r.status === 403 ? 'O Chrome perdeu o login do Mercado Livre.' : `ML respondeu ${r.status}`); if (r.status === 401 || r.status === 403) e.desconectado = true; throw e; }
    return r.dados;
}
// pasta da extensao para o usuario carregar no Chrome (chrome://extensions > Carregar sem compactacao)
function pastaExtensao() {
    const destino = path.join(os.homedir(), '.seven', 'extensao_agenda_full');
    const origem = path.join(__dirname, 'extensao_agenda_full');
    fs.mkdirSync(destino, { recursive: true });
    for (const a of fs.readdirSync(origem)) fs.writeFileSync(path.join(destino, a), fs.readFileSync(path.join(origem, a)));
    return destino;
}
function abrirPastaExtensao() {
    const p = pastaExtensao();
    try { const { shell } = require('electron'); if (shell && shell.openPath) { shell.openPath(p); return { ok: true, pasta: p }; } } catch {}
    spawn('explorer', [p], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, pasta: p };
}

// ---- estado da conexao ------------------------------------------------------------------------------
let ultimoEstado = null;
async function contaDoToken() { try { return String((await require('./tokenManager').getToken()).user_id || ''); } catch { return ''; } }
async function estado({ forcar = false } = {}) {
    if (transporte() === 'extensao') {
        const esperada = await contaDoToken();
        const v = { transporte: 'extensao', chrome: true, conta_esperada: esperada, confirmar_ligado: config().agenda_full_confirmar === true,
            extensao_visto_em: ext.visto ? new Date(ext.visto).toISOString() : null, extensao_versao: ext.versao, extensao_diag: ext.diag, extensao_log: ext.log || [], extensao_desatualizada: ext.desatualizada || null, pasta_extensao: path.join(os.homedir(), '.seven', 'extensao_agenda_full'),
            conectado: extViva(), seller_id: ext.seller, conta_ok: extViva() && (!esperada || ext.seller === esperada),
            outra_conta: ext.outra && Date.now() - ext.outra.em < 60000 ? ext.outra.seller : null };
        if (!v.conectado) v.motivo = v.outra_conta ? `A extensão está num Chrome logado na conta ${v.outra_conta}; este Dashboard é da ${esperada}.` : ext.visto ? 'A extensão parou de responder (o Chrome foi fechado?).' : 'A extensão do SEVEN ainda não foi instalada no Chrome desta conta.';
        if (forcar && v.conectado) { try { v.total_envios = (await mlGet('/api/shipping/inbounds/search?offset=0&limit=1')).paging?.total ?? null; } catch {} }
        return v;
    }
    if (!forcar && ultimoEstado && Date.now() - ultimoEstado.t < 20000) return ultimoEstado.v;
    const base = { chrome: !!chromeExe(), porta: porta(), modo, rodando: !!(await versao()), conta_esperada: await contaDoToken(),
        confirmar_ligado: config().agenda_full_confirmar === true };
    let v;
    if (!base.rodando && !forcar) v = { ...base, conectado: null, motivo: 'O Chrome da Agenda do Full está fechado (abre sozinho na próxima consulta).' };
    else {
        try {
            const d = await noSite(JS_GET, { url: '/api/shipping/inbounds/search?offset=0&limit=1' }, { timeoutMs: 25000 });
            const seller = String(d.seller_id || '');
            v = { ...base, rodando: true, conectado: !!seller, seller_id: seller, conta_ok: !!seller && (!base.conta_esperada || seller === base.conta_esperada), total_envios: d.paging?.total ?? null };
        } catch (e) { v = { ...base, rodando: !!(await versao()), conectado: false, motivo: e.message }; }
    }
    ultimoEstado = { t: Date.now(), v };
    return v;
}
// abre a janela visivel para o login; quando a conta certa aparecer, a tela pede para esconder
async function conectar() { await naFila(() => abrir(true)); ultimoEstado = null; return { ok: true, modo }; }
async function esconder() { await naFila(() => abrir(false)); ultimoEstado = null; return { ok: true, modo }; }
async function fechar() { await naFila(() => matar()); modo = null; ultimoEstado = null; return { ok: true }; }

// ---- envios -----------------------------------------------------------------------------------------
function normalizar(x) {
    return { id: String(x.id), nome: x.name || '', tipo: x.shipment_type || null, tipo_txt: TIPOS[x.shipment_type] || x.shipment_type || '—',
        status: x.status, sub_status: x.sub_status || '', status_txt: (x.status === 'confirmed' && x.sub_status === 'scheduled' ? 'Recebimento pendente' : STATUS[x.status]) || x.status,
        data: x.appointment?.date || null, limite_cancelar: x.appointment?.cancellation_limit_date || null,
        unidades: x.products_count ?? null, produtos: x.units_count ?? null, aptas: x.on_sale_units ?? null,
        galpao: x.logistic_center_id || null, recebido_em: x.reception_date || null, atualizado: x.last_updated || null,
        problemas: !!(x.inbound_problems && (x.inbound_problems.has_identification_problems || x.inbound_problems.has_unsolvable_problems || x.inbound_problems.has_fiscal_problems)) };
}
async function envios({ forcar = false } = {}) {
    const ant = lerJson(ARQ_ENVIOS, null);
    if (!forcar && ant && Date.now() - new Date(ant.em).getTime() < 5 * 60000) return ant;
    const todos = []; let seller = null, total = 0;
    for (let off = 0; off < 1000; off += 50) {
        const d = await mlGet(`/api/shipping/inbounds/search?offset=${off}&limit=50`);
        seller = seller || String(d.seller_id || ''); total = d.paging?.total || 0;
        todos.push(...(d.results || []).map(normalizar));
        if (!(d.results || []).length || off + 50 >= total) break;
    }
    // mudancas desde a ultima leitura (data reservada, status): ficam no historico e viram aviso
    const mudancas = [];
    if (ant && ant.seller_id === seller) {
        const velho = new Map(ant.envios.map(e => [e.id, e]));
        for (const e of todos) {
            const v = velho.get(e.id);
            if (!v) { if (ant.envios.length) mudancas.push({ id: e.id, nome: e.nome, tipo: 'novo', depois: e.status_txt }); continue; }
            if ((v.data || null) !== (e.data || null)) mudancas.push({ id: e.id, nome: e.nome, tipo: 'data', antes: v.data, depois: e.data });
            if (v.status !== e.status) mudancas.push({ id: e.id, nome: e.nome, tipo: 'status', antes: v.status_txt, depois: e.status_txt });
        }
    }
    const r = { em: new Date().toISOString(), seller_id: seller, total, envios: todos, mudancas };
    gravar(ARQ_ENVIOS, r);
    for (const m of mudancas) {
        fs.appendFileSync(ARQ_HIST, JSON.stringify({ quando: r.em, ...m }) + '\n', 'utf8');
        if (m.tipo === 'data') require('./notificar').notificar(`Envio Full ${m.nome || m.id}: data mudou`,
            `${fmt(m.antes) || 'sem data'} → ${fmt(m.depois) || 'sem data'}`, '/agenda-full', {});
    }
    return r;
}
function historico(n = 60) {
    try { return fs.readFileSync(ARQ_HIST, 'utf8').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse().slice(0, n); }
    catch { return []; }
}
const fmt = (iso) => iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)} ${iso.slice(11, 16)}` : '';

// ---- horarios livres --------------------------------------------------------------------------------
function lerHorarios(d, tipo) {
    return {
        ref: d.availability_ref_id || null, tipo, tipo_txt: TIPOS[tipo] || tipo, buscado_em: new Date().toISOString(),
        galpoes: (d.availability || []).map(a => {
            const id = a.node ? a.node.id : a.address ? 'coleta-' + a.address.id : '?';
            const titulo = a.node ? `${a.node.title}` : a.address ? `Coleta: ${a.address.street_name || ''} ${a.address.street_number || ''}`.trim() : id;
            return { id, titulo, cidade: a.node?.city_name || a.address?.city_name || '', de: a.date_from, ate: a.date_to,
                dias: (a.schedule_slots || []).map(s => ({ data: s.date, erros: (s.errors || []).length, slots: (s.available_slots || []).map(x => ({
                    hora: String(x.slot_date || x.from || '').slice(11, 16), slot_date: x.slot_date, de: String(x.from || '').slice(11, 16), ate: String(x.to || '').slice(11, 16),
                    custo: x.charges ? x.charges.amount : null, bruto: x })) })) };
        }),
    };
}
async function horarios(envioId, tipo = 'ftl') {
    if (!/^\d+$/.test(String(envioId))) throw new Error('Envio inválido.');
    if (!TIPOS[tipo]) throw new Error('Forma de envio inválida.');
    const d = await mlGet(`/api/shipping/inbounds/${envioId}/appointment-v2/schedule-availability?shipment_type=${tipo}`);
    return lerHorarios(d, tipo);
}

// ---- vigias -----------------------------------------------------------------------------------------
function vigias() { return lerJson(ARQ_VIGIAS, []); }
function salvarVigias(L) { gravar(ARQ_VIGIAS, L); }
function criarVigia(v) {
    const envio = String(v.envio_id || '').trim();
    if (!/^\d+$/.test(envio)) throw new Error('Escolha o envio.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v.data || ''))) throw new Error('Escolha o dia.');
    const de = /^\d{2}:\d{2}$/.test(v.hora_de || '') ? v.hora_de : '00:00', ate = /^\d{2}:\d{2}$/.test(v.hora_ate || '') ? v.hora_ate : '23:59';
    if (de > ate) throw new Error('A hora inicial passa da final.');
    const nova = { id: Date.now().toString(36), envio_id: envio, envio_nome: String(v.envio_nome || ''), tipo: TIPOS[v.tipo] ? v.tipo : 'ftl',
        data: v.data, hora_de: de, hora_ate: ate, galpoes: (Array.isArray(v.galpoes) ? v.galpoes : []).map(String).filter(Boolean),
        intervalo_s: Math.max(INTERVALO_MIN_S, Number(v.intervalo_s) || INTERVALO_PADRAO_S), ativo: true, criado_em: new Date().toISOString(),
        checagens: 0, ultima_em: null, ultimo_erro: null, achados: [] };
    const L = vigias(); L.push(nova); salvarVigias(L);
    iniciar();
    return nova;
}
function mudarVigia(id, acao) {
    let L = vigias(); const v = L.find(x => x.id === id);
    if (!v) throw new Error('Vigia não encontrada.');
    if (acao === 'apagar') L = L.filter(x => x.id !== id);
    else if (acao === 'pausar') { v.ativo = false; v.encerrada = 'pausada por você'; }
    else if (acao === 'retomar') { v.ativo = true; v.encerrada = null; }
    else throw new Error('Ação inválida.');
    salvarVigias(L); iniciar();
    return { ok: true };
}
const casa = (v, g, s) => s.slot_date && s.slot_date.slice(0, 10) === v.data && s.hora >= v.hora_de && s.hora <= v.hora_ate && (!v.galpoes.length || v.galpoes.includes(g.id));
async function checarVigia(v) {
    const h = await horarios(v.envio_id, v.tipo);
    const agora = new Date().toISOString();
    const vistos = [];
    for (const g of h.galpoes) for (const dia of g.dias) for (const s of dia.slots) if (casa(v, g, s)) vistos.push({ chave: g.id + '|' + s.slot_date, galpao: g.id, galpao_titulo: g.titulo, hora: s.hora, de: s.de, ate: s.ate, slot_date: s.slot_date });
    const L = vigias(); const atual = L.find(x => x.id === v.id); if (!atual) return;
    atual.checagens = (atual.checagens || 0) + 1; atual.ultima_em = agora; atual.ultimo_erro = null;
    // resumo do dia pedido (para a tela mostrar o que existe perto do horario desejado)
    atual.dia_pedido = h.galpoes.map(g => ({ galpao: g.id, titulo: g.titulo, horas: ((g.dias.find(d => d.data === v.data) || {}).slots || []).map(s => s.hora) }));
    const novos = [];
    for (const x of vistos) {
        const a = atual.achados.find(y => y.chave === x.chave);
        if (!a) { const n = { ...x, visto_em: agora, ultimo_visto: agora, sumiu_em: null }; atual.achados.push(n); novos.push(n); }
        else { a.ultimo_visto = agora; if (a.sumiu_em) { a.sumiu_em = null; a.visto_em = agora; novos.push(a); } }
    }
    for (const a of atual.achados) if (!a.sumiu_em && !vistos.some(x => x.chave === a.chave)) a.sumiu_em = agora;   // a vaga fechou
    atual.achados = atual.achados.slice(-40);
    salvarVigias(L);
    for (const n of novos) require('./notificar').notificar(`Vaga no Full: ${n.slot_date.slice(8, 10)}/${n.slot_date.slice(5, 7)} às ${n.hora} · ${n.galpao_titulo}`,
        `Envio ${atual.envio_nome || atual.envio_id}. Abra a Agenda do Full no SEVEN para confirmar.`, '/agenda-full', { beep: true, urgente: true });
}

// laco das vigias: cada vigia ativa e consultada no seu intervalo; vigia vencida (dia ja passou) encerra sozinha
let timer = null, rodandoLaco = false;
function iniciar() {
    if (timer) return;
    timer = setInterval(async () => {
        if (rodandoLaco) return; rodandoLaco = true;
        try {
            const L = vigias(); const agora = Date.now();
            let mudou = false;
            for (const v of L) if (v.ativo && new Date(`${v.data}T${v.hora_ate}:00-03:00`).getTime() < agora) { v.ativo = false; v.encerrada = 'o horário pedido já passou'; mudou = true; }
            if (mudou) salvarVigias(L);
            const vez = L.filter(v => v.ativo && (!v.ultima_em || agora - new Date(v.ultima_em).getTime() >= v.intervalo_s * 1000));
            for (const v of vez) {
                try { await checarVigia(v); }
                catch (e) { const L2 = vigias(); const a = L2.find(x => x.id === v.id); if (a) { a.ultima_em = new Date().toISOString(); a.ultimo_erro = e.message; salvarVigias(L2); } }
            }
            if (!L.some(v => v.ativo)) { clearInterval(timer); timer = null; }
        } finally { rodandoLaco = false; }
    }, 3000);
}
// Sempre conectado (pedido do usuario): com o perfil ja logado uma vez, o Chrome abre sozinho e escondido quando o
// SEVEN liga e a conexao e conferida a cada 10 min; se o ML desconectar, vem um aviso para entrar de novo.
let manter = null, avisouQueda = false;
async function conferirConexao() {
    if (transporte() === 'extensao') {
        if (ext.visto && !extViva() && !avisouQueda) { avisouQueda = true; require('./notificar').notificar('Agenda do Full desconectada', 'A extensão do SEVEN parou de responder. Abra o Chrome em que a conta está logada.', '/agenda-full', { urgente: true }); }
        if (extViva()) avisouQueda = false;
        return;
    }
    if (modo === 'visivel') return;   // o usuario esta usando a janela de login
    const e = await estado({ forcar: true }).catch(() => null);
    if (!e) return;
    if (e.conectado && e.conta_ok) { avisouQueda = false; return; }
    if (!avisouQueda) {
        avisouQueda = true;
        require('./notificar').notificar('Agenda do Full desconectada', e.conectado ? 'O Chrome do SEVEN está em outra conta do ML.' : 'Entre de novo no Mercado Livre: abra a Agenda do Full e clique em Fazer login.', '/agenda-full', { urgente: true });
    }
}
function iniciarAgendador() {
    if (vigias().some(v => v.ativo)) iniciar();
    if (manter || config().agenda_full_sempre_conectado === false) return;
    if (transporte() === 'extensao') { try { pastaExtensao(); } catch {} manter = setInterval(conferirConexao, 60000); return; }
    if (!fs.existsSync(path.join(perfil(), 'Local State'))) return;   // nunca fez o login: so abre quando o usuario pedir
    setTimeout(conferirConexao, 20000);
    manter = setInterval(conferirConexao, 10 * 60000);
}

// ---- confirmar (DESLIGADO nesta fase) -----------------------------------------------------------------
// Mesmo pedido do botao Confirmar do site: confere o bloqueio do envio (lock-status) e manda
// { step_token: availability_ref_id, selected_shipment_type, selected_warehouse, selected_appointment: slot, actions_attempted }
// com o cabecalho x-csrf-token da propria pagina.
const JS_CONFIRMAR = `async ({ envio, seller, corpo }) => {
    const lock = await fetch('/api/shipping/inbounds/' + envio + '/appointment-v2/' + seller + '/lock-status', { credentials: 'include' });
    if (!lock.ok) return { __erro: 'conferência de bloqueio falhou (' + lock.status + ')', status: lock.status };
    const meta = document.querySelector('meta[name=csrf-token]');
    const r = await fetch('/api/shipping/inbounds/' + envio + '/appointment-v2/confirm', { method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...(meta && meta.content ? { 'x-csrf-token': meta.content } : {}) }, body: JSON.stringify(corpo) });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    return { status: r.status, ok: r.ok, resposta: j || t.slice(0, 500) };
}`;
async function confirmar(vigiaId, chave) {
    if (config().agenda_full_confirmar !== true) throw new Error('A confirmação está DESLIGADA nesta fase de testes. Nada foi marcado.');
    const v = vigias().find(x => x.id === vigiaId); if (!v) throw new Error('Vigia não encontrada.');
    const [galpao, slotDate] = String(chave || '').split('|');
    const d = await mlGet(`/api/shipping/inbounds/${v.envio_id}/appointment-v2/schedule-availability?shipment_type=${v.tipo}`);
    const no = (d.availability || []).find(a => a.node && a.node.id === galpao);
    const slot = no && (no.schedule_slots || []).flatMap(s => s.available_slots || []).find(s => s.slot_date === slotDate);
    if (!slot) throw new Error('A vaga já foi ocupada por outro vendedor.');
    const env = (lerJson(ARQ_ENVIOS, {}).envios || []).find(e => e.id === v.envio_id) || {};
    const acoes = []; if ((env.tipo || null) !== v.tipo) acoes.push('CHANGE_SHIPMENT_TYPE'); acoes.push('CHANGE_APPOINTMENT_DATE');
    const est = await estado({ forcar: true });
    if (!est.conta_ok) throw new Error('O Chrome da Agenda do Full não está na conta deste Dashboard.');
    const corpo = { step_token: d.availability_ref_id, selected_shipment_type: v.tipo, selected_warehouse: galpao, selected_appointment: slot, actions_attempted: acoes };
    const r = transporte() === 'chrome' ? await noSite(JS_CONFIRMAR, { envio: v.envio_id, seller: est.seller_id, corpo })
        : await extExecutar({ tipo: 'confirmar', envio: v.envio_id, seller: est.seller_id, corpo }, 60000).then(x => ({ status: x.status, ok: x.ok, resposta: x.dados }));
    fs.appendFileSync(ARQ_HIST, JSON.stringify({ quando: new Date().toISOString(), id: v.envio_id, nome: v.envio_nome, tipo: 'confirmacao', galpao, slot_date: slotDate, resultado: r.status }) + '\n', 'utf8');
    if (!r.ok) throw new Error('O ML recusou (' + r.status + '): ' + JSON.stringify(r.resposta).slice(0, 200));
    const L = vigias(); const a = L.find(x => x.id === vigiaId); if (a) { a.ativo = false; a.encerrada = `marcado: ${fmt(slotDate)} em ${galpao}`; salvarVigias(L); }
    return { ok: true, resposta: r.resposta };
}

module.exports = { extPedir, extResultado, abrirPastaExtensao, estado, conectar, esconder, fechar, envios, historico, horarios, vigias, criarVigia, mudarVigia, confirmar, iniciarAgendador, TIPOS };
