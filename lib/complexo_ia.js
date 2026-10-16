// Complexo de IA (16/10/2026): varios agentes de IA por area do SEVEN, cada um com a sua chave da API do Gemini.
//   STOCK Ops 4 agentes · ADS Health 6 · Finance 10. Em cada area o agente 1 e o orquestrador; abaixo deles ficam os
//   bots/motores que executam (Escalada de Prata: usuario -> agentes de IA -> bots).
// As chaves ficam em ~/.seven/complexo_ia.json, o MESMO arquivo do projeto em Python (Area de Trabalho\Complexo de IA),
// fora do git. O painel de Desenvolvedor mostra o estado de cada chave, cadastra, testa, exporta e importa o arquivo
// (para levar as chaves a outro PC). Quem chama a IA pode pedir as chaves de uma area: chavesDaArea('ads_health').
// Os papeis abaixo sao os mesmos de complexo/areas.py (o que vale e o id).
const fs = require('fs');
const os = require('os');
const path = require('path');

const PASTA = path.join(os.homedir(), '.seven');
const ARQ = path.join(PASTA, 'complexo_ia.json');
const ARQ_STATUS = path.join(PASTA, 'complexo_ia_status.json');
const MODELO_PADRAO = 'gemini-3.1-flash-lite';
const URL = 'https://generativelanguage.googleapis.com/v1beta';

const ag = (id, papel, descricao) => ({ id, papel, descricao });
const AREAS = {
    stock_ops: { nome: 'STOCK Ops', agentes: [ag('stock_orquestrador', 'Orquestrador', 'Organiza as tarefas da área e junta as respostas dos outros agentes.'),
        ag('stock_reposicao', 'Analista de reposição', 'Cobertura, ponto de reposição, quanto enviar ao Full.'), ag('stock_monitor', 'Monitor', 'Estoque em atenção, agenda do Full, alertas do dia.'),
        ag('stock_erp', 'Auditor do ERP', 'Olist × Mercado Livre: divergências de estoque e Flex.')] },
    ads_health: { nome: 'ADS Health', agentes: [ag('ads_orquestrador', 'Orquestrador', 'Organiza as tarefas da área e junta as respostas dos outros agentes.'),
        ag('ads_precificacao', 'Precificação', 'Sugestão de preço e simulação de preços da Análise de vendas.'), ag('ads_concorrencia', 'Concorrência', 'Nubimetrics, ranking e posição contra os concorrentes.'),
        ag('ads_saude', 'Saúde dos anúncios', 'Manutenção: parados, qualidade, fotos, ficha técnica.'), ag('ads_publicidade', 'Publicidade e promoções', 'ADS, campanhas e promoções do Mercado Livre.'),
        ag('ads_atendimento', 'Atendimento', 'Perguntas e reclamações que afetam a reputação.')] },
    finance: { nome: 'Finance', agentes: [ag('fin_orquestrador', 'Orquestrador', 'Organiza as tarefas da área e junta as respostas dos outros agentes.'),
        ag('fin_margem', 'Margem de contribuição', 'MC% real por venda, por produto e por período.'), ag('fin_custos', 'Custos', 'Planilha de custos e custos suspeitos.'),
        ag('fin_caixa', 'Fluxo de caixa', 'Entradas e saídas, saldo previsto.'), ag('fin_conciliacao', 'Conciliação', 'Mercado Livre e Mercado Pago contra o ERP.'),
        ag('fin_impostos', 'Impostos', 'Impostos sobre as vendas.'), ag('fin_tarifas', 'Tarifas e fretes', 'Tarifas do Mercado Livre e frete pago pelo vendedor.'),
        ag('fin_contas', 'Contas a pagar e receber', 'Vencimentos e recebíveis.'), ag('fin_projecoes', 'Projeções', 'Faturamento e resultado previstos.'),
        ag('fin_auditor', 'Auditor e relatórios', 'Confere os números das outras e monta os relatórios.')] },
};
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
const mascarar = (k) => k ? '••••' + String(k).slice(-4) : '(sem chave)';

function carregar() {
    const d = lerJson(ARQ, null) || { versao: 1, criado_em: new Date().toISOString(), areas: {} };
    d.areas = d.areas || {};
    for (const [aid, a] of Object.entries(AREAS)) {
        const x = (d.areas[aid] ||= { agentes: {} }); x.nome = a.nome; x.agentes = x.agentes || {};
        for (const g of a.agentes) { const c = (x.agentes[g.id] ||= { chave: '', modelo: MODELO_PADRAO }); c.papel = g.papel; c.descricao = g.descricao; c.modelo = c.modelo || MODELO_PADRAO; c.chave = c.chave || ''; }
    }
    return d;
}
function salvar(d) {
    fs.mkdirSync(PASTA, { recursive: true });
    d.atualizado_em = new Date().toISOString();
    fs.writeFileSync(ARQ + '.tmp', JSON.stringify(d, null, 2), 'utf8');
    fs.renameSync(ARQ + '.tmp', ARQ);
}

// para quem chama a IA: as chaves da area (orquestrador primeiro), sem as vazias
function chavesDaArea(area) {
    const a = carregar().areas[area]; if (!a) return [];
    return (AREAS[area] || { agentes: [] }).agentes.map(g => (a.agentes[g.id] || {}).chave).filter(Boolean);
}

// estado para a tela: chaves sempre mascaradas
function status() {
    const d = carregar(), st = lerJson(ARQ_STATUS, null);
    const out = { arquivo: ARQ, testado_em: st ? st.em : null, completo: st ? !!st.completo : false, areas: [] };
    for (const [aid, a] of Object.entries(AREAS)) {
        const sa = ((st && st.areas && st.areas[aid]) || {}).agentes || [];
        const agentes = a.agentes.map((g, i) => {
            const c = d.areas[aid].agentes[g.id], t = sa.find(x => x.id === g.id) || {};
            const mesma = t.chave === mascarar(c.chave);   // o teste foi com esta mesma chave?
            return { n: i + 1, id: g.id, papel: g.papel, descricao: g.descricao, modelo: c.modelo, chave: mascarar(c.chave), tem_chave: !!c.chave,
                status: !c.chave ? 'sem chave' : mesma && t.status ? t.status : 'não testada', detalhe: mesma ? t.detalhe || '' : '', ms: mesma ? t.ms ?? null : null };
        });
        out.areas.push({ id: aid, nome: a.nome, agentes, conectadas: agentes.filter(x => x.status === 'conectada').length, total: agentes.length });
    }
    return out;
}

function definirChave(area, agenteId, chave, modelo) {
    const d = carregar();
    const c = d.areas[area] && d.areas[area].agentes[agenteId];
    if (!c) throw new Error('Agente desconhecido.');
    chave = String(chave || '').trim();
    if (chave && !/^[A-Za-z0-9_.-]{30,}$/.test(chave)) throw new Error('Isso não parece uma chave da API do Gemini.');
    c.chave = chave;
    if (modelo) c.modelo = String(modelo).trim();
    salvar(d);
    return { ok: true, chave: mascarar(chave) };
}

async function testarChave(chave, modelo, completo) {
    if (!chave) return { status: 'sem chave', detalhe: 'Nenhuma chave cadastrada para este agente.' };
    const t0 = Date.now();
    try {
        const r = completo
            ? await fetch(`${URL}/models/${modelo}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': chave },
                body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Responda só: ok' }] }], generationConfig: { maxOutputTokens: 5 } }), signal: AbortSignal.timeout(30000) })
            : await fetch(`${URL}/models?pageSize=100`, { headers: { 'x-goog-api-key': chave }, signal: AbortSignal.timeout(20000) });
        const d = await r.json().catch(() => ({}));
        const ms = Date.now() - t0;
        try { require('./cotas').registrar('gemini', { status: r.status, ms, chave: `${String(chave).slice(-4)} · ${modelo}` }); } catch {}
        if (!r.ok) return { status: r.status === 429 ? 'cota esgotada' : [400, 401, 403].includes(r.status) ? 'recusada' : 'erro', detalhe: `HTTP ${r.status} ${String((d.error || {}).message || '').slice(0, 140)}`.trim(), ms };
        if (!completo) {
            const nomes = (d.models || []).map(m => String(m.name || '').split('/').pop());
            if (!nomes.includes(modelo)) return { status: 'modelo indisponivel', detalhe: `A chave funciona, mas o modelo ${modelo} não aparece para ela.`, ms };
            return { status: 'conectada', detalhe: `chave aceita · ${nomes.length} modelos`, ms };
        }
        return { status: 'conectada', detalhe: `${modelo} respondeu`, ms };
    } catch (e) { return { status: 'sem conexao', detalhe: String(e.message).slice(0, 140) }; }
}

// testa todas as chaves (leve: so lista os modelos, nao gasta cota) e grava o mesmo arquivo de status do Python
async function testar(completo = false) {
    const d = carregar();
    const out = { em: new Date().toISOString(), completo, areas: {} };
    for (const [aid, a] of Object.entries(AREAS)) {
        const res = await Promise.all(a.agentes.map(async g => {
            const c = d.areas[aid].agentes[g.id];
            return { id: g.id, papel: g.papel, chave: mascarar(c.chave), modelo: c.modelo, ...(await testarChave(c.chave, c.modelo, completo)) };
        }));
        out.areas[aid] = { nome: a.nome, agentes: res, conectadas: res.filter(x => x.status === 'conectada').length, total: res.length };
    }
    fs.mkdirSync(PASTA, { recursive: true });
    fs.writeFileSync(ARQ_STATUS, JSON.stringify(out, null, 2), 'utf8');
    return status();
}

// levar para outro PC: o arquivo inteiro (COM as chaves). Importar guarda uma copia do anterior.
function exportar() { const d = carregar(); salvar(d); return d; }
function importar(novo) {
    if (!novo || typeof novo !== 'object' || !novo.areas) throw new Error('Esse arquivo não é um arquivo de chaves do Complexo de IA.');
    if (fs.existsSync(ARQ)) fs.copyFileSync(ARQ, ARQ + '.antes_' + new Date().toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(PASTA, { recursive: true });
    fs.writeFileSync(ARQ, JSON.stringify(novo, null, 2), 'utf8');
    salvar(carregar());
    return status();
}

module.exports = { AREAS, status, definirChave, testar, exportar, importar, chavesDaArea };
