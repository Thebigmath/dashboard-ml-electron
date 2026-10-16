// Pop-up lateral de estoque em ATENCAO (pedido do usuario em 16/10/2026, igual ao painel do Harvey).
// Olha a lista de reposicao do Full (reposicao.json, gravada a cada "Atualizar Estoque"/coleta). Quando um produto
// do Full ENTRA em Atencao (cobertura de 15 a 30 dias), o main.js abre o painel no canto da tela com a lista.
// Na primeira vez mostra todos os que ja estao em Atencao; depois so quando entra produto novo.
const fs = require('fs');
const path = require('path');

const STORAGE = () => process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
const ARQ_REP = () => path.join(STORAGE(), 'reposicao.json');
const ARQ_EST = () => path.join(STORAGE(), 'alerta_estoque.json');

// mesma regra do Painel (app.js isEmpilhadeira): pecas de empilhadeira nao entram na lista do Full
const EMPILHADEIRA = ['empilhadeira', 'hyster', 'yale', 'bobcat', 'forklift', 'trator'];
const ehEmpilhadeira = (r) => EMPILHADEIRA.some(k => String(r.titulo || '').toLowerCase().includes(k)) || String(r.sku || '').toLowerCase().startsWith('bf');
const emAtencao = (r) => {
    const c = Number(r.cobertura);
    return r.eFull !== false && r.status === 'active' && !ehEmpilhadeira(r) && Number(r.vendas30) > 0 && c >= 15 && c < 30;
};

function lista() {
    const est = lerJson(ARQ_EST(), {});
    const novos = new Set(est.novos || []);
    return lerJson(ARQ_REP(), []).filter(emAtencao)
        .map(r => ({ chave: r.chave || r.sku, sku: r.sku, titulo: r.titulo, estoque: Number(r.estoque) || 0, vendas30: Number(r.vendas30) || 0,
            media_dia: Number(r.mediaDia) || 0, cobertura: Number(r.cobertura), reposicao: Number(r.reposicao) || 0, novo: novos.has(r.chave || r.sku) }))
        .sort((a, b) => (b.novo - a.novo) || (a.cobertura - b.cobertura));
}

// chamado de tempos em tempos pelo main.js: devolve true quando deve abrir o painel
function verificar() {
    let mtime;
    try { mtime = fs.statSync(ARQ_REP()).mtimeMs; } catch { return { abrir: false }; }
    const est = lerJson(ARQ_EST(), null);
    if (est && est.mtime === mtime) return { abrir: false };          // lista nao mudou desde a ultima olhada
    const atuais = lerJson(ARQ_REP(), []).filter(emAtencao).map(r => r.chave || r.sku);
    const antes = new Set(est ? est.atencao || [] : []);
    const novos = est ? atuais.filter(c => !antes.has(c)) : atuais;   // primeira vez: todos
    fs.writeFileSync(ARQ_EST(), JSON.stringify({ mtime, em: new Date().toISOString(), atencao: atuais, novos: novos.length ? novos : (est && est.novos) || [] }), 'utf8');
    return { abrir: novos.length > 0, novos: novos.length };
}

module.exports = { lista, verificar };
