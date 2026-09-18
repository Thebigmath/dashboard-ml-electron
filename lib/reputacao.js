// Monitor de reputação no Mercado Livre. Lê /users/me (seller_reputation) a
// cada 30 min e compara as taxas de 60 dias com os limites do MercadoLíder:
// reclamações 1%, cancelamentos 1%, atraso no envio 5% (configuráveis). Quando
// alguma taxa passa de 75% do limite, a conta está a caminho de perder o
// Platinum: tarja vermelha em todas as telas, aviso no Windows e beep.
// Arquivos: STORAGE/reputacao.json (último estado), reputacao_config.json.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const TokenManager = require('./tokenManager');
const { notificar } = require('./notificar');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const PRIMEIRA_MS = 40 * 1000;
const INTERVALO_MS = 30 * 60 * 1000;
const REAVISAR_MS = 6 * 60 * 60 * 1000;
const PADRAO = { limite_reclamacoes: 0.01, limite_cancelamentos: 0.01, limite_atraso: 0.05, alerta_em: 0.75, beep: true };

function lerJson(file, def) {
    const p = path.join(STORAGE, file);
    if (!fs.existsSync(p)) return def;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; }
}
function salvarJson(file, data) { fs.writeFileSync(path.join(STORAGE, file), JSON.stringify(data, null, 2), 'utf8'); }
function configuracao() { return { ...PADRAO, ...lerJson('reputacao_config.json', {}) }; }
function salvarConfiguracao(parcial) {
    const c = configuracao();
    for (const k of ['limite_reclamacoes', 'limite_cancelamentos', 'limite_atraso', 'alerta_em']) if (parcial[k] != null && !isNaN(Number(parcial[k]))) c[k] = Number(parcial[k]);
    if (parcial.beep != null) c.beep = !!parcial.beep;
    salvarJson('reputacao_config.json', c);
    return c;
}

const estado = { rodando: false, ultimo_erro: null, avisado_em: 0 };

async function verificar() {
    if (estado.rodando) return lerJson('reputacao.json', null);
    estado.rodando = true;
    try {
        const { access_token } = await TokenManager.getToken();
        const { data: u } = await axios.get('https://api.mercadolibre.com/users/me', { headers: { Authorization: `Bearer ${access_token}` } });
        const r = u.seller_reputation || {}, m = r.metrics || {}, c = configuracao();
        const metricas = [
            { id: 'reclamacoes', nome: 'Reclamações', taxa: (m.claims || {}).rate || 0, qtd: (m.claims || {}).value || 0, limite: c.limite_reclamacoes },
            { id: 'cancelamentos', nome: 'Cancelamentos', taxa: (m.cancellations || {}).rate || 0, qtd: (m.cancellations || {}).value || 0, limite: c.limite_cancelamentos },
            { id: 'atraso', nome: 'Atraso no envio', taxa: (m.delayed_handling_time || {}).rate || 0, qtd: (m.delayed_handling_time || {}).value || 0, limite: c.limite_atraso },
        ].map(x => ({ ...x, uso: x.limite ? x.taxa / x.limite : 0 }));
        const pior = metricas.reduce((a, b) => b.uso > a.uso ? b : a, metricas[0]);
        const emRisco = pior.uso >= c.alerta_em;
        const saida = {
            verificado_em: new Date().toISOString(), nickname: u.nickname, nivel: r.level_id, medalha: r.power_seller_status,
            vendas60: ((m.sales || {}).completed) || 0, periodo: (m.sales || {}).period || '60 days',
            metricas, pior: pior.id, em_risco: emRisco, alerta_em: c.alerta_em,
        };
        salvarJson('reputacao.json', saida);
        estado.ultimo_erro = null;
        if (emRisco && Date.now() - estado.avisado_em > REAVISAR_MS) {
            estado.avisado_em = Date.now();
            const linhas = metricas.filter(x => x.uso >= c.alerta_em).map(x => `• ${x.nome}: ${(x.taxa * 100).toFixed(2)}% (${x.qtd}) — limite ${(x.limite * 100).toFixed(0)}%, ${Math.round(x.uso * 100)}% usado`);
            notificar(`RISCO DE PERDER O PLATINUM — ${u.nickname}`, linhas.join('\n'), '/', { beep: c.beep, urgente: true });
        }
        return saida;
    } catch (e) {
        estado.ultimo_erro = String(e.response?.data?.message || e.message || e).slice(0, 200);
        console.error('[REPUTACAO] ' + estado.ultimo_erro);
        return lerJson('reputacao.json', null);
    } finally { estado.rodando = false; }
}

function resumo() {
    const r = lerJson('reputacao.json', null);
    return { ...(r || { em_risco: false, metricas: [] }), config: configuracao(), estado: { ...estado } };
}

let t1 = null, t2 = null;
function iniciarAgendador() {
    pararAgendador();
    t1 = setTimeout(() => verificar().catch(() => {}), PRIMEIRA_MS);
    t2 = setInterval(() => verificar().catch(() => {}), INTERVALO_MS);
}
function pararAgendador() { if (t1) clearTimeout(t1); if (t2) clearInterval(t2); t1 = t2 = null; }

module.exports = { verificar, resumo, configuracao, salvarConfiguracao, iniciarAgendador, pararAgendador, estado };
