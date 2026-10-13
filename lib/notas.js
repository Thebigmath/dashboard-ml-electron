// Notas de fornecedores (Finance): liga o Dashboard ao sistema "Organizar notas" / "Hub de Pedidos"
// (Documentos\business_Intelligence\gestao_notas). Os scripts Python continuam sendo os mesmos; aqui so:
//   - Hub de Pedidos: sobe o hub.py (sem abrir navegador) e a tela mostra ele dentro do Finance (arrastar o PDF,
//     conferir para qual pasta do Drive vai e enviar)
//   - Organizar a pasta do Drive: roda organizar_notas.py (simulacao) e, se pedir, --executar; a saida aparece na tela
//   - Historico: saidas/historico.csv
// So funciona no PC que tem a pasta e o Python com as bibliotecas (o Drive e autorizado no proprio sistema).
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const PORTA_HUB = 8790;
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
function pasta() {
    const cfg = lerJson(path.join(STORAGE, 'config.json'), {});
    return cfg.notas_dir || path.join(process.env.USERPROFILE || '', 'Documents', 'business_Intelligence', 'gestao_notas');
}

function hubNoAr() {
    return new Promise((ok) => {
        const r = http.get({ host: '127.0.0.1', port: PORTA_HUB, path: '/api/status', timeout: 2500 }, (res) => { res.resume(); ok(res.statusCode < 500); });
        r.on('error', () => ok(false)); r.on('timeout', () => { r.destroy(); ok(false); });
    });
}

async function info() {
    const dir = pasta();
    const disponivel = fs.existsSync(path.join(dir, 'organizar_notas.py')) && fs.existsSync(path.join(dir, 'hub.py'));
    return { disponivel, dir, hub_porta: PORTA_HUB, hub_no_ar: disponivel ? await hubNoAr() : false, rodando: job.rodando };
}

// sobe o hub em segundo plano (sem janela e sem abrir o navegador) e espera ficar no ar
async function iniciarHub() {
    const dir = pasta();
    if (!fs.existsSync(path.join(dir, 'hub.py'))) throw new Error('O Hub de Pedidos não está neste PC.');
    if (await hubNoAr()) return { ok: true, ja_estava: true };
    const p = spawn('py', ['hub.py', '--sem-navegador'], { cwd: dir, detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHON_COLORS: '0', NO_COLOR: '1' } });
    p.unref();
    for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 750)); if (await hubNoAr()) return { ok: true }; }
    throw new Error('O Hub de Pedidos não respondeu. Abra o "Hub de Pedidos.bat" para ver o erro (por exemplo, o login do Google Drive).');
}

// organizar_notas.py: simulacao (padrao) ou execucao de verdade
const job = { rodando: false, modo: null, linhas: [], codigo: null, inicio: null, fim: null };
function rodar(args, modo) {
    if (job.rodando) throw new Error('Já existe uma organização em andamento.');
    const dir = pasta();
    if (!fs.existsSync(path.join(dir, 'organizar_notas.py'))) throw new Error('O "Organizar notas" não está neste PC.');
    Object.assign(job, { rodando: true, modo, linhas: [], codigo: null, inicio: new Date().toISOString(), fim: null, drive_vencido: false });
    const p = spawn('py', ['organizar_notas.py', ...args], { cwd: dir, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHON_COLORS: '0', NO_COLOR: '1' } });
    const ler = (b) => { for (const l of String(b).split(/\r?\n/)) if (l.trim()) job.linhas.push(l); if (job.linhas.length > 2000) job.linhas.splice(0, job.linhas.length - 2000); };
    p.stdout.on('data', ler); p.stderr.on('data', ler);
    p.on('error', (e) => { job.linhas.push('Erro: ' + e.message); });
    p.on('close', (c) => {
        // acesso ao Google Drive vencido/revogado: avisa em portugues (o botao Reconectar resolve)
        if (job.linhas.some(l => /invalid_grant|expired or revoked/i.test(l))) {
            job.drive_vencido = true;
            job.linhas.push('', 'O acesso ao Google Drive venceu. Clique em "Reconectar o Google Drive" e faça o login de novo no navegador.');
        }
        Object.assign(job, { rodando: false, codigo: c, fim: new Date().toISOString() });
    });
    return { ok: true };
}
const organizar = ({ executar = false } = {}) => rodar(executar ? ['--executar'] : [], executar ? 'executar' : 'simular');
// Reconectar o Drive: guarda o acesso vencido (token.json -> token_vencido.json) e roda o --verificar,
// que abre o navegador deste PC para o login do Google
function reconectar() {
    const dir = pasta(), tk = path.join(dir, 'token.json');
    if (job.rodando) throw new Error('Espere a organização em andamento terminar.');
    if (fs.existsSync(tk)) fs.renameSync(tk, path.join(dir, 'token_vencido.json'));
    return rodar(['--verificar'], 'reconectar');
}
function estado() { return job; }

function historico(limite = 200) {
    const arq = path.join(pasta(), 'saidas', 'historico.csv');
    let txt = ''; try { txt = fs.readFileSync(arq, 'utf8').replace(/^﻿/, ''); } catch { return []; }
    const [cab, ...linhas] = txt.split(/\r?\n/).filter(Boolean);
    const campos = cab.split(';');
    return linhas.map(l => { const v = l.split(';'); return Object.fromEntries(campos.map((c, i) => [c, v[i] || ''])); }).reverse().slice(0, limite);
}

module.exports = { info, iniciarHub, organizar, reconectar, estado, historico };
