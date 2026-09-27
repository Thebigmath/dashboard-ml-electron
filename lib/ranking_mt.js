// Coleta do ranking do Mercado Turbo, disparada pelo Seven.
//
// Quem coleta e o bot Python ranking_paralelo.py (pasta bot_precos): varias
// janelas do MT (Chrome perfil 7) em segundo plano, via acessibilidade do
// Windows. Aqui so disparamos o processo, acompanhamos o log e agendamos a
// rodada semanal. O resultado (saidas/ranking_mercadoturbo.json) e lido por
// lib/seven.js.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const BOT_PADRAO = 'C:/Users/Matheus Prata/Documents/business_Intelligence/bot_precos';
const ESTADO = path.join(STORAGE, 'ranking_mt_estado.json');
const DIA_SEMANAL = 1;   // segunda-feira
const HORA_SEMANAL = 7;

let timer = null;

function lerJson(arquivo, padrao) {
    try { return JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch { return padrao; }
}

function config() {
    const c = lerJson(path.join(STORAGE, 'config.json'), {});
    return {
        pasta: c.ranking_mt_bot_dir || BOT_PADRAO,
        janelas: Number(c.ranking_mt_janelas) || 1,  // o MT so faz uma busca por vez por login
        python: c.ranking_mt_python || 'py',
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
        const log = fs.readFileSync(path.join(cfg.pasta, 'saidas', 'ranking_paralelo.log'), 'utf8').trim().split(/\r?\n/);
        resumo = log[log.length - 1] || '';
    } catch {}
    // progresso: soma das linhas "[k/n] Buscando" de cada parte
    try {
        let feitos = 0, total = 0;
        for (let i = 0; i < 16; i++) {
            const arq = path.join(cfg.pasta, 'saidas', `ranking_parte${i}.log`);
            if (!fs.existsSync(arq)) break;
            const txt = fs.readFileSync(arq, 'utf8');
            const buscas = [...txt.matchAll(/^\[(\d+)\/(\d+)\] Buscando/gm)];
            if (buscas.length) {
                const ult = buscas[buscas.length - 1];
                feitos += Number(ult[1]) - (rodando ? 1 : 0);
                total += Number(ult[2]);
            }
        }
        if (total) progresso = { feitos: Math.max(0, feitos), total };
    } catch {}
    return { rodando, iniciado_em: e.iniciado_em || null, origem: e.origem || null, janelas: cfg.janelas, resumo, progresso };
}

function iniciar(origem = 'manual') {
    if (estado().rodando) return { ok: false, erro: 'A coleta do ranking já está rodando.' };
    const cfg = config();
    if (!fs.existsSync(path.join(cfg.pasta, 'ranking_paralelo.py'))) {
        return { ok: false, erro: `Bot não encontrado em ${cfg.pasta}` };
    }
    fs.mkdirSync(path.join(cfg.pasta, 'saidas'), { recursive: true });
    const log = fs.openSync(path.join(cfg.pasta, 'saidas', 'ranking_paralelo.log'), 'w');
    const proc = spawn(cfg.python, ['-u', 'ranking_paralelo.py', '--janelas', String(cfg.janelas)], {
        cwd: cfg.pasta, detached: true, windowsHide: true, stdio: ['ignore', log, log],
    });
    proc.unref();
    fs.closeSync(log);
    fs.mkdirSync(STORAGE, { recursive: true });
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
