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

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ESTADO = path.join(STORAGE, 'ranking_ml_estado.json');
const DIA_SEMANAL = 1;   // segunda-feira
const HORA_SEMANAL = 7;

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
        termos: c.ranking_ml_termos || path.join(pasta, 'termos_ranking.txt'),
        saida: c.ranking_ml_arquivo || 'C:/Users/Matheus Prata/.dotnet/MLScraper/saidas/ranking_issacar_flavia.json',
        abas: Number(c.ranking_ml_abas) || 3,
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
    return { rodando, iniciado_em: e.iniciado_em || null, origem: e.origem || null, abas: cfg.abas, resumo, progresso };
}

function iniciar(origem = 'manual') {
    if (estado().rodando) return { ok: false, erro: 'A coleta do ranking já está rodando.' };
    const cfg = config();
    if (!fs.existsSync(path.join(cfg.pasta, cfg.script))) return { ok: false, erro: `Issacar não encontrado em ${cfg.pasta}` };
    if (!fs.existsSync(cfg.termos)) return { ok: false, erro: `Lista de termos não encontrada: ${cfg.termos}` };
    fs.mkdirSync(STORAGE, { recursive: true });
    const log = fs.openSync(cfg.log, 'w');
    const proc = spawn(cfg.python, [
        '-u', cfg.script, '--arquivo', cfg.termos, '--conta', 'flavia', '--modo-mt',
        '--max-paginas', '3', '--abas', String(cfg.abas), '--delay-min', '1', '--delay-max', '2',
        '--tempo-max', '280', '--saida-fixa', cfg.saida,
    ], { cwd: cfg.pasta, detached: true, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    proc.unref();
    fs.closeSync(log);
    fs.writeFileSync(ESTADO, JSON.stringify({ pid: proc.pid, iniciado_em: new Date().toISOString(), origem }, null, 2));
    return { ok: true, pid: proc.pid };
}

// Toda segunda a partir das 7h: roda uma vez, se a semana ainda nao teve coleta.
function checarSemanal() {
    const agora = new Date();
    if (agora.getDay() !== DIA_SEMANAL || agora.getHours() < HORA_SEMANAL) return;
    const e = lerJson(ESTADO, {});
    const ultima = e.iniciado_em ? new Date(e.iniciado_em) : null;
    const inicioDoDia = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());
    if (ultima && ultima >= inicioDoDia) return;
    iniciar('semanal');
}

function iniciarAgendador() {
    pararAgendador();
    setTimeout(() => { try { checarSemanal(); } catch {} }, 3 * 60 * 1000);
    timer = setInterval(() => { try { checarSemanal(); } catch {} }, 30 * 60 * 1000);
}
function pararAgendador() {
    if (timer) clearInterval(timer);
    timer = null;
}

module.exports = { estado, iniciar, iniciarAgendador, pararAgendador };
