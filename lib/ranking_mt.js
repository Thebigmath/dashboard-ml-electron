// Coleta do Ranking ML, disparada pelo Seven.
//
// Quem coleta e o Issacar (issacar_posicao.py, Area de Trabalho): pesquisa os
// termos direto na busca do ML num Chrome proprio fora da tela e conta como a
// API conta (sem patrocinados, cada anuncio uma vez). Aqui so disparamos o
// processo, acompanhamos o log e agendamos a rodada semanal. O resultado
// (ranking_issacar_flavia.json) e lido por lib/seven.js.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { notificar } = require('./notificar');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ESTADO = path.join(STORAGE, 'ranking_ml_estado.json');
// Uma linha por coleta (JSON por linha): quando, de onde, quanto passou e quanto o ML barrou.
const HISTORICO = path.join(STORAGE, 'ranking_ml_historico.jsonl');
// Uma coleta por dia para as DUAS contas (Flavia e Cordeiro), dividida em 2 partes para
// ficar discreta (2 abas, 2 a 4 s entre as buscas): metade dos termos a partir das 7h e a
// outra metade a partir do meio-dia. O Issacar reconhece os anuncios de cada conta na mesma
// busca e grava um JSON por conta; termo nao pesquisado mantem o resultado anterior.
// O app da Cordeiro so le o JSON dele (e o historico daqui).
const HORA_PARTE = { 1: 7, 2: 12 };
// Depois de qualquer coleta (automatica ou manual), o botao espera 30 min: duas rodadas
// seguidas foram o que fez o ML barrar a coleta em 30/09.
const INTERVALO_MIN = 30;
const DIA = path.join(STORAGE, 'ranking_ml_dia.json');   // { dia, partes: [1, 2] } ja rodadas hoje

let timer = null;

function lerJson(arquivo, padrao) {
    try { return JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch { return padrao; }
}

function config() {
    const c = lerJson(path.join(STORAGE, 'config.json'), {});
    const pasta = c.ranking_ml_pasta || 'C:/Users/Matheus Prata/Desktop';
    return {
        pasta,
        script: c.ranking_ml_script || 'issacar_posicao.py',
        termos: c.ranking_ml_termos || path.join(pasta, 'termos_ranking_todos.txt'),
        saida: c.ranking_ml_saida || 'C:/Users/Matheus Prata/.dotnet/MLScraper/saidas/ranking_issacar_{conta}.json',
        contas: c.ranking_ml_contas || 'flavia,cordeiro',
        abas: Number(c.ranking_ml_abas) || 2,
        python: c.ranking_ml_python || 'py',
        log: path.join(STORAGE, 'ranking_ml.log'),
    };
}

function vivo(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
}

function estado() {
    const cfg = config();
    const e = lerJson(ESTADO, {});
    const rodando = vivo(e.pid);
    let resumo = '';
    let progresso = null;
    try {
        const txt = fs.readFileSync(cfg.log, 'utf8');
        const feitos = (txt.match(/^\[\d+\/\d+\]/gm) || []).length;
        const total = (txt.match(/^\[\d+\/(\d+)\]/m) || [])[1];
        if (total) progresso = { feitos, total: Number(total) };
        const bloqueios = (txt.match(/bloqueado_pelo_ml/g) || []).length;
        const linhas = txt.trim().split(/\r?\n/);
        resumo = rodando ? '' : (progresso
            ? `Coleta terminada: ${progresso.feitos - bloqueios} de ${progresso.total} termos pesquisados` + (bloqueios ? ` (${bloqueios} barrados pelo ML).` : '.')
            : (linhas[linhas.length - 1] || ''));
    } catch {}
    if (!rodando) registrarSeTerminou();
    const espera = esperaMin();
    return { rodando, iniciado_em: e.iniciado_em || null, origem: e.origem || null, abas: cfg.abas, parte: e.parte || null,
             partes_hoje: diaHoje().partes, espera_min: rodando ? 0 : espera, resumo, progresso, ultima: historico(1)[0] || null, coletor: true };
}

const hojeStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function diaHoje() {
    const d = lerJson(DIA, {});
    return d.dia === hojeStr() ? d : { dia: hojeStr(), partes: [] };
}
// minutos que ainda faltam para liberar uma nova coleta (0 = liberado)
function esperaMin() {
    const e = lerJson(ESTADO, {});
    const u = historico(1)[0];
    const marcos = [e.iniciado_em, u && u.fim].filter(Boolean).map(t => new Date(t).getTime());
    if (!marcos.length) return 0;
    const falta = INTERVALO_MIN * 60000 - (Date.now() - Math.max(...marcos));
    return falta > 0 ? Math.ceil(falta / 60000) : 0;
}
// Divide a lista em 2 metades e grava o arquivo da parte pedida (1 ou 2).
function arquivoDaParte(cfg, parte) {
    const termos = fs.readFileSync(cfg.termos, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const meio = Math.ceil(termos.length / 2);
    const lista = parte === 1 ? termos.slice(0, meio) : termos.slice(meio);
    const arq = path.join(STORAGE, `termos_ranking_parte${parte}.txt`);
    fs.writeFileSync(arq, lista.join('\n') + '\n', 'utf8');
    return arq;
}

function iniciar(origem = 'manual', parte) {
    if (estado().rodando) return { ok: false, erro: 'A coleta do ranking já está rodando.' };
    const espera = esperaMin();
    if (espera) return { ok: false, erro: `Aguarde ${espera} min: depois de uma coleta, o ML precisa de um intervalo de ${INTERVALO_MIN} minutos para não barrar a próxima.` };
    const cfg = config();
    if (!fs.existsSync(path.join(cfg.pasta, cfg.script))) return { ok: false, erro: `Issacar não encontrado em ${cfg.pasta}` };
    if (!fs.existsSync(cfg.termos)) return { ok: false, erro: `Lista de termos não encontrada: ${cfg.termos}` };
    // manual: a parte que ainda falta hoje (ou a 1 se as duas ja rodaram)
    const feitas = diaHoje().partes;
    parte = parte || (feitas.includes(1) && !feitas.includes(2) ? 2 : 1);
    fs.mkdirSync(STORAGE, { recursive: true });
    const arquivo = arquivoDaParte(cfg, parte);
    const log = fs.openSync(cfg.log, 'w');
    const proc = spawn(cfg.python, [
        '-u', cfg.script, '--arquivo', arquivo, '--contas', cfg.contas, '--modo-mt',
        '--max-paginas', '2', '--abas', String(cfg.abas), '--delay-min', '2', '--delay-max', '4',
        '--tempo-max', '345', '--saida-fixa', cfg.saida,
    ], { cwd: cfg.pasta, detached: true, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    proc.on('exit', () => registrarSeTerminou());
    proc.on('error', (err) => registrarSeTerminou(`não foi possível iniciar o Issacar (${err.message})`));
    proc.unref();
    fs.closeSync(log);
    fs.writeFileSync(ESTADO, JSON.stringify({ pid: proc.pid, iniciado_em: new Date().toISOString(), origem, parte, registrado: false }, null, 2));
    const d = diaHoje();
    if (!d.partes.includes(parte)) d.partes.push(parte);
    fs.writeFileSync(DIA, JSON.stringify(d, null, 2));
    return { ok: true, pid: proc.pid, parte };
}

// Parte 1 a partir das 7h e parte 2 a partir do meio-dia, uma vez cada por dia
// (respeitando o intervalo de 30 min depois de qualquer coleta).
function checarDiario() {
    registrarSeTerminou();
    const hora = new Date().getHours();
    const feitas = diaHoje().partes;
    for (const parte of [1, 2]) {
        if (hora < HORA_PARTE[parte] || feitas.includes(parte)) continue;
        if (estado().rodando || esperaMin()) return;
        iniciar('diaria', parte);
        return;
    }
}

function iniciarAgendador() {
    pararAgendador();
    setTimeout(() => { try { checarDiario(); } catch {} }, 3 * 60 * 1000);
    timer = setInterval(() => { try { checarDiario(); } catch {} }, 30 * 60 * 1000);
}
function pararAgendador() {
    if (timer) clearInterval(timer);
    timer = null;
}

// Le o log da coleta que acabou, grava no historico (uma vez) e avisa se falhou.
function registrarSeTerminou(erroInicio) {
    const e = lerJson(ESTADO, {});
    if (!e.iniciado_em || e.registrado) return;
    if (!erroInicio && vivo(e.pid)) return;
    const cfg = config();
    let txt = '';
    try { txt = fs.readFileSync(cfg.log, 'utf8'); } catch {}
    const total = Number((txt.match(/^\[\d+\/(\d+)\]/m) || [])[1] || 0);
    const linhas = txt.match(/^\[\d+\/\d+\].*$/gm) || [];
    const barrados = linhas.filter(l => /bloqueado_pelo_ml/.test(l)).length;
    const pesquisados = linhas.length - barrados;
    const erroPython = /Traceback|Error:/.test(txt) && !linhas.length;
    let status = 'ok', motivo = '';
    if (erroInicio) { status = 'falhou'; motivo = erroInicio; }
    else if (erroPython) { status = 'falhou'; motivo = 'o Issacar parou com erro (veja ranking_ml.log)'; }
    else if (!pesquisados) { status = 'falhou'; motivo = barrados ? 'o Mercado Livre barrou a coleta (verificação de segurança)' : 'nenhum termo foi pesquisado'; }
    else if (barrados) { status = 'parcial'; motivo = `${barrados} termo(s) barrado(s) pelo Mercado Livre`; }
    else if (!barrados && pesquisados < total) { status = 'parcial'; motivo = 'o tempo da rodada acabou antes de todos os termos'; }
    const reg = { inicio: e.iniciado_em, fim: new Date().toISOString(), origem: e.origem || 'manual', parte: e.parte || null, status, motivo, total, pesquisados, barrados };
    try { fs.appendFileSync(HISTORICO, JSON.stringify(reg) + '\n', 'utf8'); } catch {}
    fs.writeFileSync(ESTADO, JSON.stringify({ ...e, registrado: true }, null, 2));
    if (status !== 'ok') {
        try {
            notificar(status === 'falhou' ? 'Coleta do Ranking ML falhou' : 'Coleta do Ranking ML incompleta',
                `${motivo}. O ranking anterior continua valendo.`, '/seven#vendas');
        } catch {}
    }
}

function historico(n = 20) {
    try {
        return fs.readFileSync(HISTORICO, 'utf8').trim().split(/\r?\n/).filter(Boolean)
            .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse().slice(0, n);
    } catch { return []; }
}

module.exports = { estado, iniciar, iniciarAgendador, pararAgendador, historico };
