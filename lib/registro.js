// Log estruturado em JSONL, um arquivo por dia em STORAGE/logs.
//
// O log do motor sempre foi texto no SSE: some quando a tela fecha, e depois
// nao da para saber se o produto sumiu porque o lote falhou ou porque nao
// existia. Aqui cada evento vira uma linha JSON com horario, para dar para
// responder isso no dia seguinte.
//
// Regras: nunca derruba quem chamou (log e efeito colateral, nao regra de
// negocio) e nunca grava token/segredo.
const fs = require('fs');
const path = require('path');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const PASTA = path.join(STORAGE, 'logs');
const DIAS_GUARDADOS = 14;

function arquivoDoDia(motor) {
    const d = new Date();
    const dia = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    return path.join(PASTA, `${motor}_${dia}.jsonl`);
}

// Limpeza preguicosa: uma vez por processo, para o diretorio nao crescer sem fim.
let limpou = false;
function limpar() {
    if (limpou) return;
    limpou = true;
    try {
        const corte = Date.now() - DIAS_GUARDADOS * 86400000;
        for (const nome of fs.readdirSync(PASTA)) {
            const p = path.join(PASTA, nome);
            if (fs.statSync(p).mtimeMs < corte) fs.unlinkSync(p);
        }
    } catch {}
}

function registrar(motor, evento) {
    try {
        fs.mkdirSync(PASTA, { recursive: true });
        limpar();
        const linha = JSON.stringify({ t: new Date().toISOString(), ...evento });
        fs.appendFileSync(arquivoDoDia(motor), linha + '\n', 'utf8');
    } catch {}
}

module.exports = { registrar, PASTA };
