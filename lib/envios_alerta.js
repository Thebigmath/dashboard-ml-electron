// Envio ao Full aberto há muito tempo. A API do ML não devolve o status de
// envio ao Full (todas as rotas dão 404/403), então o app nunca sabe sozinho
// que o lote chegou — e um envio esquecido em "Pendente" desconta unidades
// fantasmas da reposição para sempre. Aqui, de tempos em tempos, quem está
// aberto há mais de DIAS_LIMITE vira aviso no Windows (uma vez por semana por
// envio). Estado em STORAGE/envios_alerta.json { avisados: { numero: iso } }.
const fs = require('fs');
const path = require('path');
const { notificar } = require('./notificar');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const DIAS_LIMITE = 15;
const REPETIR_DIAS = 7;
const PRIMEIRA_MS = 2 * 60 * 1000;
const INTERVALO_MS = 12 * 60 * 60 * 1000;

function lerJson(file, def) {
    const p = path.join(STORAGE, file);
    if (!fs.existsSync(p)) return def;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; }
}
function salvarJson(file, data) { fs.writeFileSync(path.join(STORAGE, file), JSON.stringify(data, null, 2), 'utf8'); }

const aberto = (e) => !e.inativo && e.ativo !== false && !((e.recebido || 0) >= (e.unidades || 0) && (e.unidades || 0) > 0);
// Data do envio: o campo "data" (quando digitado), senão "criado_em" (gravado
// pelo app ao salvar). Envio antigo sem nenhuma das duas não tem idade conhecida.
function dataDe(e) {
    const d = e.data || e.criado_em;
    if (!d) return null;
    const t = new Date(String(d).length === 10 ? d + 'T12:00:00' : d).getTime();
    return isNaN(t) ? null : t;
}
function idadeDias(e) { const t = dataDe(e); return t == null ? null : Math.floor((Date.now() - t) / 86400000); }

function atrasados() {
    return lerJson('envios_full.json', []).filter(aberto).map(e => ({ ...e, dias: idadeDias(e) })).filter(e => e.dias != null && e.dias > DIAS_LIMITE);
}

function verificar() {
    const lista = atrasados();
    if (!lista.length) return { avisados: 0, atrasados: 0 };
    const est = lerJson('envios_alerta.json', { avisados: {} });
    const agora = Date.now();
    const novos = lista.filter(e => !est.avisados[e.numero] || (agora - new Date(est.avisados[e.numero]).getTime()) > REPETIR_DIAS * 86400000);
    if (novos.length) {
        const linhas = novos.slice(0, 3).map(e => `• #${e.numero}: ${e.dias} dias, ${(e.unidades || 0) - (e.recebido || 0)} un pendentes`);
        if (novos.length > 3) linhas.push(`… e mais ${novos.length - 3}`);
        notificar(`${novos.length} envio(s) ao Full aberto(s) há mais de ${DIAS_LIMITE} dias — já chegaram?`, linhas.join('\n') + '\nSe chegou, marque Recebido ou arquive; senão o trânsito desconta da reposição.', '/envio_full');
        for (const e of novos) est.avisados[e.numero] = new Date(agora).toISOString();
        salvarJson('envios_alerta.json', est);
    }
    return { avisados: novos.length, atrasados: lista.length };
}

let t1 = null, t2 = null;
function iniciarAgendador() {
    pararAgendador();
    t1 = setTimeout(() => { try { verificar(); } catch {} }, PRIMEIRA_MS);
    t2 = setInterval(() => { try { verificar(); } catch {} }, INTERVALO_MS);
}
function pararAgendador() { if (t1) clearTimeout(t1); if (t2) clearInterval(t2); t1 = t2 = null; }

module.exports = { verificar, atrasados, iniciarAgendador, pararAgendador, DIAS_LIMITE };
