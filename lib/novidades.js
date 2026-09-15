// Novidades por versão: o que mudou, com vídeo e imagens gravados pelo usuário.
//
// O conteúdo vem de novidades.json na raiz do app (viaja dentro do instalador,
// então cada versão já chega com as suas notas). Cada item:
//   { versao, data, titulo, texto, video, imagens }
//   video   — link do YouTube (vira embed) ou URL/arquivo .mp4 (vira <video>)
//   imagens — lista de URLs (asset da release no GitHub ou caminho em public/)
//   texto   — parágrafos separados por linha em branco; linhas "- " viram lista
//
// Estado em STORAGE/novidades_estado.json: { vista_ate, avisada }
//   vista_ate — maior versão que o usuário abriu na tela (badge conta as acima)
//   avisada   — versão cuja notificação "instalada — veja o que mudou" já saiu
const fs = require('fs');
const path = require('path');
const { notificar } = require('./notificar');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ARQUIVO = path.join(__dirname, '../novidades.json');
const ESTADO = path.join(STORAGE, 'novidades_estado.json');
const VERSAO_ATUAL = require('../package.json').version;

function lerEstado() {
    try { return JSON.parse(fs.readFileSync(ESTADO, 'utf8')); } catch { return {}; }
}
function salvarEstado(e) { fs.writeFileSync(ESTADO, JSON.stringify(e, null, 2), 'utf8'); }

function compararVersao(a, b) {
    const pa = String(a || '0').split('.').map(Number), pb = String(b || '0').split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d) return d;
    }
    return 0;
}

function lerItens() {
    let itens = [];
    try { itens = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8')); } catch {}
    if (!Array.isArray(itens)) itens = [];
    return itens
        .filter(n => n && n.versao)
        .map(n => ({ versao: String(n.versao), data: n.data || '', titulo: n.titulo || '', texto: n.texto || '', video: n.video || '', imagens: Array.isArray(n.imagens) ? n.imagens : [] }))
        .sort((a, b) => compararVersao(b.versao, a.versao));
}

function listar() {
    const itens = lerItens();
    const estado = lerEstado();
    const naoVistas = itens.filter(n => compararVersao(n.versao, estado.vista_ate) > 0).length;
    return { versao_atual: VERSAO_ATUAL, vista_ate: estado.vista_ate || null, nao_vistas: naoVistas, itens };
}

function marcarVisto() {
    const itens = lerItens();
    const estado = lerEstado();
    const maior = itens.length ? itens[0].versao : VERSAO_ATUAL;
    if (compararVersao(maior, estado.vista_ate) > 0) estado.vista_ate = maior;
    salvarEstado(estado);
    return listar();
}

// Depois de uma atualização: se esta versão tem nota e ainda não avisamos,
// manda o toast. Na primeira instalação só registra, sem avisar.
function avisarSeAtualizou() {
    const estado = lerEstado();
    // Sem estado e sem token = instalação nova: só registra. Sem estado mas
    // com token = app já usado antes desta versão (a primeira que tem
    // novidades): é atualização, avisa.
    const usadoAntes = fs.existsSync(path.join(STORAGE, 'token.json'));
    if (!estado.avisada && !estado.vista_ate && !usadoAntes) {
        estado.avisada = VERSAO_ATUAL;
        salvarEstado(estado);
        return false;
    }
    if (estado.avisada === VERSAO_ATUAL) return false;
    const nota = lerItens().find(n => n.versao === VERSAO_ATUAL);
    estado.avisada = VERSAO_ATUAL;
    salvarEstado(estado);
    if (!nota) return false;
    notificar(`Versão ${VERSAO_ATUAL} instalada — ${nota.titulo}`, (nota.video ? 'Tem vídeo mostrando o que mudou. ' : '') + 'Clique para ver as novidades.', '/novidades');
    return true;
}

module.exports = { listar, marcarVisto, avisarSeAtualizou, compararVersao };
