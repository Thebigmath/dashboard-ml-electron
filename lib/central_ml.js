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
//                     So com a chave "Permitir que o SEVEN marque" ligada (config.agenda_full_confirmar, desligada de fabrica).
//   automatico ...... (por vigia, opcional) achou vaga DENTRO do dia/faixa/galpoes da vigia -> avisa "estou marcando" e marca
//                     sozinho; depois avisa "marcado" ou "nao deu". Fora da faixa decidida, nunca marca.
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
// a > b em versao (1.0.10 > 1.0.9). So a versao MAIS NOVA manda: um Dashboard antigo nunca rebaixa a extensao
// (antes, Dashboard com 1.0.1 e laboratorio com 1.0.2 ficavam trocando a pasta um do outro)
const maisNova = (a, b) => { const x = String(a || '0').split('.').map(Number), y = String(b || '0').split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
// qual conta e este Dashboard (o mesmo codigo roda nos dois): pelo nome do pacote
const CONTA = (() => { try { return require('../package.json').name === 'dashboard-cordeiro' ? 'cordeiro' : 'flavia'; } catch { return 'flavia'; } })();
const CONTA_NOME = CONTA === 'cordeiro' ? 'Cordeiro' : 'Flavia';
const PORTAS_EXT = CONTA === 'cordeiro' ? [3002, 3913] : [3001, 3911];
async function extPedir(q) {
    // extensao antiga (a pasta unica, sem conta): nao recebe tarefas e nao e mandada recarregar; a tela pede a reinstalacao
    if (!q.conta) { ext.antiga = { v: q.v || '?', em: Date.now() }; return { ignorar: true, motivo: 'extensão antiga: instale a extensão desta conta (pasta extensao_agenda_full_' + CONTA + ')' }; }
    if (q.conta !== CONTA) return { ignorar: true, motivo: 'extensão de outra conta' };
    ext.versao = q.v || ext.versao;
    ext.diag = { status: q.st || null, detalhe: q.er || null, em: new Date().toISOString() };
    (ext.log ||= []).push(`${new Date().toISOString().slice(11, 19)} v=${q.v || ''} seller=${q.seller || ''} st=${q.st || ''} er=${String(q.er || '').slice(0, 60)}`); ext.log = ext.log.slice(-15);
    // extensao antiga: a pasta ja tem a nova (copiada quando o SEVEN liga) -> ela se recarrega sozinha
    const nova = versaoExtensao();
    if (q.v && nova && q.v !== 'teste' && maisNova(nova, q.v)) {
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
        // junta as tarefas que chegam quase juntas (motores em paralelo) num pacote so para a extensao
        ext.fila.push(item);
        if (ext.esperando && !ext.junta) ext.junta = setTimeout(() => { ext.junta = null; if (ext.esperando && ext.fila.length) ext.esperando(ext.fila.splice(0)); }, 40);
    });
}
// GET numa rota interna do ML, pelo transporte escolhido
const consultas = [];   // horario de cada consulta ao ML (orcamento por minuto)
async function mlGet(url) {
    consultas.push(Date.now()); while (consultas.length && Date.now() - consultas[0] > 60000) consultas.shift();
    if (transporte() === 'chrome') return noSite(JS_GET, { url });
    const r = await extExecutar({ tipo: 'get', url });
    if (!r.ok) { const e = new Error(r.status === 401 || r.status === 403 ? 'O Chrome perdeu o login do Mercado Livre.' : `ML respondeu ${r.status}`); e.status = r.status; if (r.status === 401 || r.status === 403) e.desconectado = true; throw e; }
    return r.dados;
}
// pasta da extensao para o usuario carregar no Chrome (chrome://extensions > Carregar sem compactacao)
function pastaExtensao() {
    const destino = path.join(os.homedir(), '.seven', 'extensao_agenda_full_' + CONTA);
    const origem = path.join(__dirname, 'extensao_agenda_full');
    fs.mkdirSync(destino, { recursive: true });
    let naPasta = null; try { naPasta = JSON.parse(fs.readFileSync(path.join(destino, 'manifest.json'), 'utf8')).version; } catch {}
    if (naPasta && !maisNova(versaoExtensao(), naPasta)) return destino;   // a pasta ja tem a mesma ou uma mais nova
    for (const a of fs.readdirSync(origem)) {
        let conteudo = fs.readFileSync(path.join(origem, a));
        if (a === 'manifest.json') { const m = JSON.parse(conteudo.toString('utf8')); m.name = `SEVEN · Agenda do Full (${CONTA_NOME})`; conteudo = JSON.stringify(m, null, 2); }
        fs.writeFileSync(path.join(destino, a), conteudo);
    }
    fs.writeFileSync(path.join(destino, 'config.json'), JSON.stringify({ conta: CONTA, nome: CONTA_NOME, portas: PORTAS_EXT }, null, 2));
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
            extensao_visto_em: ext.visto ? new Date(ext.visto).toISOString() : null, extensao_versao: ext.versao, extensao_diag: ext.diag, extensao_log: ext.log || [], extensao_desatualizada: ext.desatualizada || null, extensao_antiga: ext.antiga && Date.now() - ext.antiga.em < 90000 ? ext.antiga.v : null,
            conta_nome: CONTA_NOME, pasta_extensao: path.join(os.homedir(), '.seven', 'extensao_agenda_full_' + CONTA),
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
    conferirConseguidos(todos);
    for (const m of mudancas) {
        fs.appendFileSync(ARQ_HIST, JSON.stringify({ quando: r.em, ...m }) + '\n', 'utf8');
        if (m.tipo === 'data') require('./notificar').notificar(`Envio Full ${m.nome || m.id}: data mudou`,
            `${fmt(m.antes) || 'sem data'} → ${fmt(m.depois) || 'sem data'}`, '/agenda-full', {});
    }
    return r;
}
// vigias cumpridas: o envio ja esta marcado dentro do dia/faixa pedidos -> a vigia para e registra "conseguido"
function conferirConseguidos(lista) {
    const L = vigias(); let mudou = false;
    for (const v of L) {
        if (!v.ativo) continue;
        const e = (lista || []).find(x => x.id === v.envio_id);
        if (!e || !e.data) continue;
        const dia = e.data.slice(0, 10), hora = e.data.slice(11, 16);
        if (dia === v.data && hora >= v.hora_de && hora <= v.hora_ate && (!v.galpoes.length || v.galpoes.includes(e.galpao))) {
            v.ativo = false; v.encerrada = `conseguido: ${fmt(e.data)} em ${e.galpao}`; v.conseguido_em = new Date().toISOString(); mudou = true;
            fs.appendFileSync(ARQ_HIST, JSON.stringify({ quando: v.conseguido_em, id: v.envio_id, nome: v.envio_nome, tipo: 'conseguido', depois: e.data, galpao: e.galpao }) + '\n', 'utf8');
            require('./notificar').notificar(`Agenda do Full: conseguido!`, `Envio ${v.envio_nome || v.envio_id} marcado para ${fmt(e.data)} em ${e.galpao}. A vigia foi encerrada.`, '/agenda-full', {});
        }
    }
    if (mudou) salvarVigias(L);
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
        intervalo_s: Math.max(INTERVALO_MIN_S, Number(v.intervalo_s) || INTERVALO_PADRAO_S), ativo: true, criado_em: new Date().toISOString(), automatico: v.automatico === true,
        checagens: 0, ultima_em: null, ultimo_erro: null, achados: [] };
    const L = vigias();
    // vigia igual ja ativa (clique repetido): nao duplica, senao o ML recebe a mesma consulta varias vezes
    const igual = L.find(x => x.ativo && x.envio_id === nova.envio_id && x.tipo === nova.tipo && x.data === nova.data && x.hora_de === nova.hora_de && x.hora_ate === nova.hora_ate && [...x.galpoes].sort().join() === [...nova.galpoes].sort().join());
    if (igual) throw new Error('Já existe uma vigia igual a esta rodando.');
    L.push(nova); salvarVigias(L);
    iniciar();
    return nova;
}
function mudarVigia(id, acao) {
    let L = vigias(); const v = L.find(x => x.id === id);
    if (!v) throw new Error('Vigia não encontrada.');
    if (acao === 'apagar') L = L.filter(x => x.id !== id);
    else if (acao === 'pausar') { v.ativo = false; v.encerrada = 'pausada por você'; }
    else if (acao === 'retomar') { v.ativo = true; v.encerrada = null; }
    else if (acao === 'auto-ligar') v.automatico = true;
    else if (acao === 'auto-desligar') v.automatico = false;
    else throw new Error('Ação inválida.');
    salvarVigias(L); iniciar();
    return { ok: true };
}
const casa = (v, g, s) => s.slot_date && s.slot_date.slice(0, 10) === v.data && s.hora >= v.hora_de && s.hora <= v.hora_ate && (!v.galpoes.length || v.galpoes.includes(g.id));
async function avaliarVigia(v, h) {
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
    let fechou = false;
    for (const a of atual.achados) if (!a.sumiu_em && !vistos.some(x => x.chave === a.chave)) { a.sumiu_em = agora; fechou = true; }   // a vaga fechou
    if (fechou) setTimeout(() => envios({ forcar: true }).catch(() => {}), 2000);   // foi a gente que pegou? (vira "conseguido")
    atual.achados = atual.achados.slice(-40);
    salvarVigias(L);
    const auto = atual.automatico && config().agenda_full_confirmar === true && novos.length && !marcando.has(atual.envio_id);
    if (!auto) {
        for (const n of novos) require('./notificar').notificar(`Vaga no Full: ${n.slot_date.slice(8, 10)}/${n.slot_date.slice(5, 7)} às ${n.hora} · ${n.galpao_titulo}`,
            `Envio ${atual.envio_nome || atual.envio_id}. Abra a Agenda do Full no SEVEN para confirmar.`, '/agenda-full', { beep: true, urgente: true });
        return;
    }
    // automatico: a primeira vaga (a mais cedo) dentro do que foi decidido; marca ja com a agenda que acabou de chegar
    const alvo = [...novos].sort((a, b) => String(a.slot_date).localeCompare(String(b.slot_date)))[0];
    const g = h.galpoes.find(x => x.id === alvo.galpao), s = g && g.dias.flatMap(d => d.slots).find(x => x.slot_date === alvo.slot_date);
    require('./notificar').notificar(`Saiu vaga para ${fmt(alvo.slot_date)} no ${alvo.galpao_titulo.replace('Centro logístico ', '')}: estou marcando`,
        `Envio ${atual.envio_nome || atual.envio_id} (vigia automática).`, '/agenda-full', { beep: true, urgente: true });
    marcarAchado(atual.id, alvo.chave, { status: 'marcando', em: new Date().toISOString() });
    try {
        await marcar(atual, alvo.galpao, alvo.slot_date, s && s.bruto, h.ref);
        marcarAchado(atual.id, alvo.chave, { status: 'marcado', em: new Date().toISOString() });
        require('./notificar').notificar(`Marcado ✓ ${fmt(alvo.slot_date)} no ${alvo.galpao_titulo.replace('Centro logístico ', '')}`, `Envio ${atual.envio_nome || atual.envio_id}. A vigia foi encerrada.`, '/agenda-full', { beep: true });
    } catch (e) {
        marcarAchado(atual.id, alvo.chave, { status: 'falhou', em: new Date().toISOString(), msg: e.message });
        require('./notificar').notificar(`Não deu para marcar ${fmt(alvo.slot_date)}`, `${e.message} A vigia continua.`, '/agenda-full', { urgente: true });
    }
}
function marcarAchado(vigiaId, chave, tentativa) {
    const L = vigias(); const v = L.find(x => x.id === vigiaId); if (!v) return;
    const a = (v.achados || []).find(x => x.chave === chave); if (a) { a.tentativa = tentativa; salvarVigias(L); }
}

// ---- MOTORES (pedido do usuario, 15/10/2026) ---------------------------------------------------------
// Um motor por envio (+ forma de envio): UMA consulta da agenda por rodada serve a TODAS as vigias daquele envio.
// Motores de envios diferentes rodam em paralelo (ate 3 por conta), cada um no seu ritmo:
//   normal ... o menor intervalo das vigias do envio (30 s padrao)
//   turbo .... 10 s (config agenda_full_turbo_s, minimo 10), AUTOMATICO: nos horarios em que o SEVEN ja viu vaga abrir
//              (aprendido do registro de aberturas, ultimos 14 dias) e por 5 min depois de qualquer vaga nova no envio
//   freio .... ML devagar/recusando (429, 5xx, > 8 s) ou estouro do limite por minuto: ritmo x2 por 10 min, com aviso
// Limite de seguranca por conta: agenda_full_limite_min (30 consultas/min, somando tudo). Pequena variacao aleatoria
// no ritmo (+-15%) para nao bater sempre no mesmo segundo.
const ARQ_ABERTURAS = path.join(STORAGE, 'agenda_full_aberturas.jsonl');
const TURBO_S = () => Math.max(10, Number(config().agenda_full_turbo_s) || 10);
const LIMITE_MIN = () => Math.max(10, Number(config().agenda_full_limite_min) || 30);
const PARALELO = 3, TURBO_DEPOIS_MS = 5 * 60000, FREIO_MS = 10 * 60000;
// MODO SIMPLES (padrao, pedido do usuario em 15/10/2026: "como na 1.9.83"): cada vigia no intervalo escolhido,
// sem turbo, sem freio e sem limite por minuto. Turbo/freio so com config.json -> "agenda_full_turbo": true.
const SIMPLES = () => config().agenda_full_turbo !== true;
const motores = new Map();   // 'envio|tipo' -> { proxima, turboAte, rodando, ultimaMs, ultimaEm, erro, anterior:Set, modo, ritmo }
let freio = { ate: 0, motivo: null, avisado: false };
let quentes = { em: 0, horas: [] };
function horasQuentes() {
    if (Date.now() - quentes.em < 10 * 60000) return quentes.horas;
    const cont = {};
    try {
        for (const l of fs.readFileSync(ARQ_ABERTURAS, 'utf8').split(/\r?\n/)) {
            if (!l) continue; let x; try { x = JSON.parse(l); } catch { continue; }
            if (Date.now() - new Date(x.quando).getTime() > 14 * 86400000) continue;
            const h = new Date(new Date(x.quando).getTime() - 3 * 3600000).getUTCHours();   // hora do Brasil
            cont[h] = (cont[h] || 0) + 1;
        }
    } catch {}
    quentes = { em: Date.now(), horas: Object.entries(cont).filter(([, n]) => n >= 2).map(([h]) => Number(h)).sort((a, b) => a - b) };
    return quentes.horas;
}
const horaBR = () => new Date(Date.now() - 3 * 3600000).getUTCHours();
function ritmoDo(m, grupo) {
    const normal = Math.max(INTERVALO_MIN_S, Math.min(...grupo.map(v => v.intervalo_s || INTERVALO_PADRAO_S)));
    if (SIMPLES()) return { modo: 'normal', s: normal, motivo: '' };
    const quente = horasQuentes().includes(horaBR());
    let modo = 'normal', s = normal, motivo = '';
    if (Date.now() < m.turboAte) { modo = 'turbo'; s = Math.min(normal, TURBO_S()); motivo = 'vaga nova há pouco'; }
    else if (quente) { modo = 'turbo'; s = Math.min(normal, TURBO_S()); motivo = `horário quente (${horaBR()}h)`; }
    if (Date.now() < freio.ate) { modo = 'freio'; s = Math.round(s * (freio.leve ? 1.5 : 2)); motivo = freio.motivo; }
    return { modo, s, motivo };
}
async function rodarMotor(chave, grupo) {
    const m = motores.get(chave); m.rodando = true;
    const [envio, tipo] = chave.split('|'); const t0 = Date.now();
    try {
        const h = await horarios(envio, tipo);
        m.ultimaMs = Date.now() - t0; m.ultimaEm = new Date().toISOString(); m.erro = null;
        // aberturas: horario que apareceu e nao estava na consulta anterior (ensina os horarios quentes)
        const agoraSet = new Set(h.galpoes.flatMap(g => g.dias.flatMap(d => d.slots.map(x => g.id + '|' + x.slot_date))));
        if (m.anterior) {
            // dia novo que o ML acrescenta no fim da agenda (a cada meia-noite) nao e abertura: so conta ate o ultimo dia que ja existia
            const ultimoDia = [...m.anterior].map(k => k.split('|')[1].slice(0, 10)).sort().pop() || '';
            const novas = [...agoraSet].filter(k => !m.anterior.has(k) && k.split('|')[1].slice(0, 10) <= ultimoDia);
            if (novas.length) {
                m.turboAte = Date.now() + TURBO_DEPOIS_MS;
                fs.appendFileSync(ARQ_ABERTURAS, novas.slice(0, 20).map(k => JSON.stringify({ quando: new Date().toISOString(), envio, galpao: k.split('|')[0], slot_date: k.split('|')[1] })).join('\n') + '\n', 'utf8');
                quentes.em = 0;
            }
        }
        m.anterior = agoraSet;
        // lentidao so freia com 3 consultas lentas SEGUIDAS (uma lenta isolada e normal); freio leve e curto
        m.lentas = m.ultimaMs > 8000 ? (m.lentas || 0) + 1 : 0;
        if (m.lentas >= 3) { acionarFreio('o ML respondeu devagar 3 vezes seguidas', { leve: true }); m.lentas = 0; }
        for (const v of grupo) { try { await avaliarVigia(v, h); } catch (e) { marcarErro(v.id, e.message); } }
    } catch (e) {
        m.erro = e.message; m.ultimaEm = new Date().toISOString();
        if (e.status === 429 || (e.status >= 500 && e.status < 600)) acionarFreio(`o ML recusou (${e.status})`);
        for (const v of grupo) marcarErro(v.id, e.message);
    } finally {
        const r = ritmoDo(m, grupo);
        m.modo = r.modo; m.ritmo = r.s; m.motivo = r.motivo;
        m.proxima = Date.now() + r.s * 1000 * (SIMPLES() ? 1 : (0.85 + Math.random() * 0.3));
        m.rodando = false;
    }
}
function marcarErro(id, msg) { const L = vigias(); const a = L.find(x => x.id === id); if (a) { a.ultima_em = new Date().toISOString(); a.ultimo_erro = msg; salvarVigias(L); } }
function acionarFreio(motivo, { leve = false } = {}) {
    if (SIMPLES()) return;   // modo simples: sem freio
    const novo = Date.now() >= freio.ate;
    // leve (lentidao): 3 min e ritmo x1,5; recusa do ML (429/5xx) ou limite: 10 min e ritmo x2
    const ate = Date.now() + (leve ? 3 * 60000 : FREIO_MS);
    if (!novo && leve && !freio.leve) return;   // nao troca um freio forte por um leve
    freio = { ate: Math.max(ate, novo ? 0 : freio.ate), motivo, leve, avisado: freio.avisado && !novo };
    if (!freio.avisado) { freio.avisado = true; require('./notificar').notificar('Agenda do Full: freio ligado', `${motivo}. As vigias vão no ritmo mais lento por 10 min para não sermos bloqueados.`, '/agenda-full', {}); }
}
let timer = null;
function iniciar() {
    if (timer) return;
    timer = setInterval(() => {
        const L = vigias(); const agora = Date.now();
        let mudou = false;
        for (const v of L) if (v.ativo && new Date(`${v.data}T${v.hora_ate}:00-03:00`).getTime() < agora) { v.ativo = false; v.encerrada = 'o horário pedido já passou'; mudou = true; }
        if (mudou) salvarVigias(L);
        const grupos = {};
        for (const v of L) if (v.ativo) (grupos[v.envio_id + '|' + v.tipo] ||= []).push(v);
        for (const k of [...motores.keys()]) if (!grupos[k]) motores.delete(k);
        if (!Object.keys(grupos).length) { clearInterval(timer); timer = null; return; }
        // limite por minuto: estourou -> espera (e liga o freio)
        while (consultas.length && agora - consultas[0] > 60000) consultas.shift();
        if (!SIMPLES() && consultas.length >= LIMITE_MIN()) { acionarFreio(`limite de ${LIMITE_MIN()} consultas por minuto`); return; }
        let emCurso = [...motores.values()].filter(m => m.rodando).length;
        const prontos = Object.entries(grupos).map(([k, g]) => { if (!motores.has(k)) motores.set(k, { proxima: 0, turboAte: 0, rodando: false }); return [k, g, motores.get(k)]; })
            .filter(([, , m]) => !m.rodando && agora >= m.proxima).sort((a, b) => a[2].proxima - b[2].proxima);
        for (const [k, g] of prontos) {
            if (emCurso >= PARALELO || (!SIMPLES() && consultas.length >= LIMITE_MIN())) break;
            emCurso++; rodarMotor(k, g);
        }
    }, 1000);
}
// situacao dos motores para a tela
function soltarFreio() { freio = { ate: 0, motivo: null, avisado: false }; for (const m of motores.values()) m.proxima = 0; return { ok: true }; }
function statusMotores() {
    while (consultas.length && Date.now() - consultas[0] > 60000) consultas.shift();
    const L = vigias();
    return {
        simples: SIMPLES(), consultas_min: consultas.length, limite_min: LIMITE_MIN(), turbo_s: TURBO_S(),
        freio: Date.now() < freio.ate ? { ate: new Date(freio.ate).toISOString(), motivo: freio.motivo } : null,
        horas_quentes: horasQuentes(),
        motores: [...motores.entries()].map(([k, m]) => { const [envio, tipo] = k.split('|'); const g = L.filter(v => v.ativo && v.envio_id === envio && v.tipo === tipo);
            return { envio, tipo, nome: (g[0] || {}).envio_nome || '', vigias: g.length, modo: m.modo || 'normal', ritmo_s: m.ritmo || null, motivo: m.motivo || '',
                proxima_em: m.proxima ? new Date(m.proxima).toISOString() : null, ultima_em: m.ultimaEm || null, ultima_ms: m.ultimaMs ?? null, erro: m.erro || null }; }),
    };
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
    if (transporte() === 'extensao') {
        try { pastaExtensao(); } catch {}
        manter = setInterval(conferirConexao, 60000);
        setInterval(() => { if (extViva()) envios({ forcar: true }).catch(() => {}); }, 5 * 60000);
        return;
    }
    if (!fs.existsSync(path.join(perfil(), 'Local State'))) return;   // nunca fez o login: so abre quando o usuario pedir
    setTimeout(conferirConexao, 20000);
    manter = setInterval(conferirConexao, 10 * 60000);
}

// abre a tela de data do envio no Chrome em que a conta esta logada (pela extensao): sem procurar na lista
async function abrirNoML(envioId) {
    if (!/^\d+$/.test(String(envioId))) throw new Error('Envio inválido.');
    const url = `/shipping/inbounds/${envioId}/appointment-v2`;
    if (transporte() === 'extensao' && extViva()) { await extExecutar({ tipo: 'abrir', url }, 15000); return { ok: true, onde: 'chrome da conta' }; }
    const completo = BASE + url;
    try { const { shell } = require('electron'); if (shell && shell.openExternal) { await shell.openExternal(completo); return { ok: true, onde: 'navegador padrão' }; } } catch {}
    spawn('cmd', ['/c', 'start', '', completo], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return { ok: true, onde: 'navegador padrão' };
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
const marcando = new Set();   // um envio marcado por vez (duas vigias do mesmo envio nao disputam entre si)
async function confirmar(vigiaId, chave) {
    if (config().agenda_full_confirmar !== true) throw new Error('A marcação pelo SEVEN está DESLIGADA. Ligue "Permitir que o SEVEN marque" na Agenda do Full. Nada foi marcado.');
    const v = vigias().find(x => x.id === vigiaId); if (!v) throw new Error('Vigia não encontrada.');
    const [galpao, slotDate] = String(chave || '').split('|');
    marcarAchado(v.id, chave, { status: 'marcando', em: new Date().toISOString(), manual: true });
    try { const r = await marcar(v, galpao, slotDate, null, null); marcarAchado(v.id, chave, { status: 'marcado', em: new Date().toISOString(), manual: true }); return r; }
    catch (e) { marcarAchado(v.id, chave, { status: 'falhou', em: new Date().toISOString(), msg: e.message, manual: true }); throw e; }
}
// reserva o horario: confere a conta, monta o mesmo pedido do site e manda pela extensao (ou pelo Chrome proprio).
// slot/ref vindos da consulta de agora (automatico) economizam uma ida ao ML; se o ML recusar a referencia, consulta de novo 1 vez.
async function marcar(v, galpao, slotDate, slotPronto, refPronta) {
    if (config().agenda_full_confirmar !== true) throw new Error('A marcação pelo SEVEN está desligada.');
    if (marcando.has(v.envio_id)) throw new Error('Já estou marcando este envio.');
    marcando.add(v.envio_id);
    try { return await marcarUmaVez(v, galpao, slotDate, slotPronto, refPronta, 2); } finally { marcando.delete(v.envio_id); }
}
async function marcarUmaVez(v, galpao, slotDate, slotPronto, refPronta, tentativas) {
    let slot = slotPronto, ref = refPronta;
    if (!slot || !ref) {
        const d = await mlGet(`/api/shipping/inbounds/${v.envio_id}/appointment-v2/schedule-availability?shipment_type=${v.tipo}`);
        const no = (d.availability || []).find(a => a.node && a.node.id === galpao);
        slot = no && (no.schedule_slots || []).flatMap(s => s.available_slots || []).find(s => s.slot_date === slotDate);
        ref = d.availability_ref_id;
        if (!slot) throw new Error('A vaga já foi ocupada por outro vendedor.');
    }
    let env = ((lerJson(ARQ_ENVIOS, {}).envios || []).find(e => e.id === v.envio_id));
    if (!env) { try { env = ((await envios({ forcar: true })).envios || []).find(e => e.id === v.envio_id); } catch {} }
    env = env || {};
    const acoes = []; if ((env.tipo || null) !== v.tipo) acoes.push('CHANGE_SHIPMENT_TYPE'); acoes.push('CHANGE_APPOINTMENT_DATE');
    const est = await estado({ forcar: true });
    if (!est.conta_ok) throw new Error('O Chrome da Agenda do Full não está na conta deste Dashboard.');
    const corpo = { step_token: ref, selected_shipment_type: v.tipo, selected_warehouse: galpao, selected_appointment: slot, actions_attempted: acoes };
    const r = transporte() === 'chrome' ? await noSite(JS_CONFIRMAR, { envio: v.envio_id, seller: est.seller_id, corpo })
        : await extExecutar({ tipo: 'confirmar', envio: v.envio_id, seller: est.seller_id, corpo }, 60000).then(x => ({ status: x.status, ok: x.ok, resposta: x.dados }));
    fs.appendFileSync(ARQ_HIST, JSON.stringify({ quando: new Date().toISOString(), id: v.envio_id, nome: v.envio_nome, tipo: 'confirmacao', galpao, slot_date: slotDate, resultado: r.status, automatico: !!slotPronto }) + '\n', 'utf8');
    if (!r.ok) {
        const txt = JSON.stringify(r.resposta || '');
        // referencia da agenda vencida: consulta de novo e tenta mais uma vez, se a vaga ainda estiver la
        if (r.status === 409 && tentativas > 1) return marcarUmaVez(v, galpao, slotDate, null, null, tentativas - 1);
        throw new Error(r.status === 409 ? 'A vaga já foi ocupada (o ML recusou).' : 'O ML recusou (' + r.status + '): ' + txt.slice(0, 200));
    }
    const L = vigias(); const a = L.find(x => x.id === v.id); if (a) { a.ativo = false; a.encerrada = `marcado pelo SEVEN: ${fmt(slotDate)} em ${galpao}`; salvarVigias(L); }
    setTimeout(() => envios({ forcar: true }).catch(() => {}), 1500);
    return { ok: true, resposta: r.resposta };
}
// chave geral "Permitir que o SEVEN marque" (por Dashboard)
function permissao(ligar) {
    const arq = path.join(STORAGE, 'config.json'); const c = lerJson(arq, {});
    c.agenda_full_confirmar = ligar === true;
    gravar(arq, c);
    ultimoEstado = null;
    return { ok: true, confirmar_ligado: c.agenda_full_confirmar };
}

module.exports = { soltarFreio, statusMotores, permissao, abrirNoML, extPedir, extResultado, abrirPastaExtensao, estado, conectar, esconder, fechar, envios, historico, horarios, vigias, criarVigia, mudarVigia, confirmar, iniciarAgendador, TIPOS };
