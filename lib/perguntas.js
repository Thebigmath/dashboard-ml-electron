// Perguntas do Mercado Livre: vigia as não respondidas e avisa na hora.
//
// O ML não empurra nada para um app de desktop (webhook precisa de URL
// pública), então é consulta: a cada 10 s, GET /my/received_questions/search
// status=UNANSWERED. Pergunta que ainda não foi avisada vira notificação do
// Windows; clicar abre a tela /perguntas, onde dá para responder
// (POST /answers) sem sair do app.
//
// Arquivos (STORAGE):
//   perguntas_estado.json  { notificadas: [ids], verificado_em }
//   perguntas_itens.json   cache { item_id: { title, thumbnail, permalink } }
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const TokenManager = require('./tokenManager');
const { mapaLimitado, comBackoff } = require('./paralelo');
const { notificar } = require('./notificar');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ML = 'https://api.mercadolibre.com';
const PRIMEIRA_MS = 20 * 1000;
const INTERVALO_MS = 10 * 1000;   // pedido do usuário: quase tempo real (1 chamada leve a cada 10 s)
const MAX_NOTIFICADAS = 3000;

function lerJson(file, def) {
    const p = path.join(STORAGE, file);
    if (!fs.existsSync(p)) return def;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; }
}
function salvarJson(file, data) {
    fs.writeFileSync(path.join(STORAGE, file), JSON.stringify(data, null, 1), 'utf8');
}

const estado = { rodando: false, abertas: [], verificado_em: null, ultimo_erro: null, avisouResumo: false };
let timerPrimeira = null, timerIntervalo = null;

async function cabecalhos() {
    const { access_token } = await TokenManager.getToken();
    return { Authorization: `Bearer ${access_token}` };
}
const tentar = (fn) => comBackoff(fn, { tentativas: 3, baseMs: 400 });

// Título/foto/link dos anúncios das perguntas, com cache em disco.
async function completarItens(headers, perguntas) {
    const cache = lerJson('perguntas_itens.json', {});
    const faltam = [...new Set(perguntas.map(q => q.item_id).filter(id => id && !cache[id]))];
    const lotes = [];
    for (let i = 0; i < faltam.length; i += 20) lotes.push(faltam.slice(i, i + 20));
    await mapaLimitado(lotes, 4, async (lote) => {
        try {
            const { data } = await tentar(() => axios.get(`${ML}/items`, { headers, params: { ids: lote.join(','), attributes: 'id,title,thumbnail,permalink,price' } }));
            for (const e of data || []) {
                const b = e.body || {};
                if (b.id) cache[b.id] = { title: b.title || '', thumbnail: b.thumbnail || '', permalink: b.permalink || '', price: b.price ?? null };
            }
        } catch {}
    });
    if (faltam.length) salvarJson('perguntas_itens.json', cache);
    return perguntas.map(q => ({ ...q, item: cache[q.item_id] || { title: q.item_id, thumbnail: '', permalink: '' } }));
}

function normalizar(q) {
    return {
        id: q.id, item_id: q.item_id, status: q.status, text: q.text || '',
        date_created: q.date_created, from_id: (q.from || {}).id || null,
        answer: q.answer ? { text: q.answer.text || '', date_created: q.answer.date_created || null, status: q.answer.status || null } : null,
    };
}

async function buscar(headers, params) {
    const { data } = await tentar(() => axios.get(`${ML}/my/received_questions/search`, { headers, params: { api_version: 4, ...params } }));
    return { total: data.total || 0, perguntas: (data.questions || []).map(normalizar) };
}

// Uma rodada: não respondidas → avisa as novas. Silenciosa se nada mudou.
async function verificar({ origem = 'agendador' } = {}) {
    if (estado.rodando) return { ok: false, motivo: 'já está verificando' };
    estado.rodando = true;
    try {
        const headers = await cabecalhos();
        const { perguntas } = await buscar(headers, { status: 'UNANSWERED', limit: 50, sort_fields: 'date_created', sort_types: 'DESC' });
        const abertas = await completarItens(headers, perguntas);
        const est = lerJson('perguntas_estado.json', { notificadas: [] });
        const notificadas = new Set(est.notificadas || []);
        const novas = abertas.filter(q => !notificadas.has(q.id));

        if (novas.length === 1) {
            const q = novas[0];
            notificar(`Pergunta nova: ${q.item.title.slice(0, 50)}`, q.text.slice(0, 180), '/perguntas');
        } else if (novas.length > 1) {
            const linhas = novas.slice(0, 3).map(q => `• ${q.item.title.slice(0, 32)}: ${q.text.slice(0, 50)}`);
            if (novas.length > 3) linhas.push(`… e mais ${novas.length - 3}`);
            notificar(`${novas.length} perguntas novas no Mercado Livre`, linhas.join('\n'), '/perguntas');
        } else if (!estado.avisouResumo && abertas.length) {
            // Primeira rodada depois de abrir (o PC ligou): lembra do que ficou pendente.
            notificar(`${abertas.length} pergunta(s) sem resposta no Mercado Livre`, abertas.slice(0, 3).map(q => `• ${q.item.title.slice(0, 40)}`).join('\n'), '/perguntas');
        }
        estado.avisouResumo = true;

        for (const q of novas) notificadas.add(q.id);
        est.notificadas = [...notificadas].slice(-MAX_NOTIFICADAS);
        est.verificado_em = new Date().toISOString();
        salvarJson('perguntas_estado.json', est);

        estado.abertas = abertas;
        estado.verificado_em = est.verificado_em;
        estado.ultimo_erro = null;
        return { ok: true, origem, abertas: abertas.length, novas: novas.length };
    } catch (e) {
        estado.ultimo_erro = String(e.response?.data?.message || e.message || e).slice(0, 200);
        console.error('[PERGUNTAS] ' + estado.ultimo_erro);
        return { ok: false, erro: estado.ultimo_erro };
    } finally {
        estado.rodando = false;
    }
}

// Para a tela: abertas (da última rodada, ou ao vivo se ainda não rodou) + últimas respondidas.
async function listar() {
    const headers = await cabecalhos();
    if (!estado.verificado_em) await verificar({ origem: 'tela' });
    const { perguntas: recentes, total } = await buscar(headers, { limit: 30, sort_fields: 'date_created', sort_types: 'DESC' });
    const respondidas = await completarItens(headers, recentes.filter(q => q.status !== 'UNANSWERED'));
    return {
        estado: { rodando: estado.rodando, verificado_em: estado.verificado_em, ultimo_erro: estado.ultimo_erro },
        abertas: estado.abertas,
        respondidas,
        total_historico: total,
    };
}

async function responder(questionId, texto) {
    const t = String(texto || '').trim();
    if (!questionId || !t) throw new Error('Pergunta ou resposta em branco');
    const headers = await cabecalhos();
    const { data } = await axios.post(`${ML}/answers`, { question_id: Number(questionId), text: t }, { headers });
    estado.abertas = estado.abertas.filter(q => String(q.id) !== String(questionId));
    return data;
}

function resumo() {
    return { nao_respondidas: estado.abertas.length, verificado_em: estado.verificado_em, ultimo_erro: estado.ultimo_erro };
}

function iniciarAgendador() {
    pararAgendador();
    timerPrimeira = setTimeout(() => verificar({ origem: 'abertura' }).catch(() => {}), PRIMEIRA_MS);
    timerIntervalo = setInterval(() => verificar({ origem: 'agendador' }).catch(() => {}), INTERVALO_MS);
}
function pararAgendador() {
    if (timerPrimeira) clearTimeout(timerPrimeira);
    if (timerIntervalo) clearInterval(timerIntervalo);
    timerPrimeira = timerIntervalo = null;
}

module.exports = { verificar, listar, responder, resumo, iniciarAgendador, pararAgendador, estado };
