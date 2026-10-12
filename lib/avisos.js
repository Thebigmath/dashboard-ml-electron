// Notificações globais: recados sobre projetos que estão por vir.
//
// Diferença para lib/novidades.js: as notas de versão viajam DENTRO do
// instalador (novidades.json), então só chegam quando o app atualiza. Aqui o
// conteúdo é buscado de um feed remoto, para anunciar um projeto novo sem
// precisar publicar release nenhuma — basta commitar o JSON no repositório.
//
// Feed (mesmo arquivo para as duas contas, por isso "global"):
//   https://raw.githubusercontent.com/Thebigmath/dashboard-ml-electron/master/avisos_globais.json
// Cada item:
//   { id, data, titulo, resumo, texto, tag, video, imagens, link }
//   id      — identificador fixo; é por ele que o app sabe o que já avisou
//   tag     — rótulo livre ("Em desenvolvimento", "Projeto novo", "Aviso"...)
//   video   — link do YouTube (vira embed) ou URL de .mp4
//   imagens — lista de URLs; link — botão "saiba mais" (abre no navegador)
//
// Arquivos (STORAGE):
//   avisos_cache.json   última cópia boa do feed (a tela funciona sem internet)
//   avisos_estado.json  { vistos: [ids], notificados: [ids], verificado_em }
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { notificar } = require('./notificar');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const CACHE = path.join(STORAGE, 'avisos_cache.json');
const ESTADO = path.join(STORAGE, 'avisos_estado.json');
const FEED = process.env.AVISOS_FEED_URL
    || 'https://raw.githubusercontent.com/Thebigmath/dashboard-ml-electron/master/avisos_globais.json';
const PRIMEIRA_MS = 45 * 1000;        // deixa o app subir antes de ir na rede
const INTERVALO_MS = 30 * 60 * 1000;  // recado não é urgente: de meia em meia hora
const MAX_LEMBRADOS = 500;

let timer = null;

function lerJson(arquivo, padrao) {
    try { return JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch { return padrao; }
}
function salvarJson(arquivo, dados) {
    try {
        fs.mkdirSync(path.dirname(arquivo), { recursive: true });
        fs.writeFileSync(arquivo, JSON.stringify(dados, null, 2), 'utf8');
    } catch {}
}

function lerEstado() {
    const e = lerJson(ESTADO, {});
    return { vistos: Array.isArray(e.vistos) ? e.vistos : [], notificados: Array.isArray(e.notificados) ? e.notificados : [], verificado_em: e.verificado_em || null };
}

// Aceita tanto uma lista solta quanto { avisos: [...] }, para o feed poder
// ganhar outros campos no futuro sem quebrar quem está com a versão antiga.
function normalizar(bruto) {
    const lista = Array.isArray(bruto) ? bruto : (bruto && Array.isArray(bruto.avisos) ? bruto.avisos : []);
    return lista
        .filter(a => a && (a.id || a.titulo))
        .map(a => ({
            id: String(a.id || a.titulo),
            data: a.data || '',
            titulo: a.titulo || '',
            resumo: a.resumo || '',
            texto: a.texto || '',
            tag: a.tag || '',
            video: a.video || '',
            imagens: Array.isArray(a.imagens) ? a.imagens : [],
            link: a.link || '',
        }))
        .sort((x, y) => String(y.data).localeCompare(String(x.data)));
}

function lerItens() { return normalizar(lerJson(CACHE, [])); }

function listar() {
    const itens = lerItens();
    const estado = lerEstado();
    const vistos = new Set(estado.vistos);
    return {
        itens: itens.map(a => ({ ...a, novo: !vistos.has(a.id) })),
        nao_vistos: itens.filter(a => !vistos.has(a.id)).length,
        verificado_em: estado.verificado_em,
    };
}

function marcarVisto() {
    const estado = lerEstado();
    estado.vistos = [...new Set([...estado.vistos, ...lerItens().map(a => a.id)])].slice(-MAX_LEMBRADOS);
    salvarJson(ESTADO, estado);
    return listar();
}

// Busca o feed, guarda a cópia e avisa uma única vez por aviso novo.
// Na primeira vez (sem estado) só registra: não faz sentido despejar toasts de
// recados antigos em quem acabou de instalar.
async function verificar() {
    const estado = lerEstado();
    const estreia = !estado.verificado_em;
    let itens;
    try {
        const { data } = await axios.get(FEED, { timeout: 15000, headers: { 'Cache-Control': 'no-cache' } });
        itens = normalizar(typeof data === 'string' ? JSON.parse(data) : data);
        salvarJson(CACHE, itens);
    } catch (e) {
        return { ok: false, erro: e.message, ...listar() };
    }

    const jaAvisados = new Set(estado.notificados);
    const novos = itens.filter(a => !jaAvisados.has(a.id));
    estado.notificados = [...new Set([...estado.notificados, ...itens.map(a => a.id)])].slice(-MAX_LEMBRADOS);
    estado.verificado_em = new Date().toISOString();
    if (estreia) estado.vistos = [...new Set([...estado.vistos, ...itens.map(a => a.id)])];
    salvarJson(ESTADO, estado);

    if (!estreia && novos.length) {
        if (novos.length === 1) {
            const a = novos[0];
            notificar(a.titulo, (a.resumo || a.texto || '').slice(0, 180) || 'Clique para ver.', '/avisos');
        } else {
            notificar(`${novos.length} novidades sobre os próximos projetos`, novos.map(a => a.titulo).join(' · ').slice(0, 180), '/avisos');
        }
    }
    return { ok: true, novos: novos.length, ...listar() };
}

function iniciarAgendador() {
    pararAgendador();
    setTimeout(() => { verificar().catch(() => {}); }, PRIMEIRA_MS);
    timer = setInterval(() => { verificar().catch(() => {}); }, INTERVALO_MS);
}
function pararAgendador() {
    if (timer) clearInterval(timer);
    timer = null;
}

module.exports = { listar, marcarVisto, verificar, iniciarAgendador, pararAgendador, FEED };
