// Guarda da tabela de custos (26/10/2026). A tabela (STORAGE/custos.json, chave = SKU em minusculo) foi sobrescrita tres vezes com valores
// absurdos e antigos (901290836 = 132036, 580061342 = 46275, 013TB = 172,37...): a planilha de custos de JULHO, configurada em
// "Sincronizar Planilha", tinha prioridade sobre os custos ja corrigidos, e a tela gravava a tabela INTEIRA que tinha na memoria.
//   - toda gravacao faz BACKUP antes (STORAGE/custos_backups, os 30 mais recentes) e entra no LOG (custos_log.jsonl): da para voltar e saber quem mexeu
//   - "Salvar Custos" manda so os SKUs que a pessoa editou (alteracoes) e o servidor MESCLA: uma tela velha nao apaga mais o que mudou depois
//   - custo suspeito (>= R$ 20.000, ou 50x maior/menor que o atual: virgula perdida) nao e gravado sem a confirmacao da pessoa; na importacao
//     de planilha nunca e gravado (fica na lista de bloqueados)
//   - a importacao primeiro mostra a PREVIA (quantos mudam, quantos sao novos, exemplos) e so grava quando a pessoa confirma
//   - corrigirUmaVez(): troca pelo custo da planilha oficial do Mercado Turbo (19/10) SOMENTE os custos que hoje sao IGUAIS ao da planilha de
//     julho (o app gravou por cima); o que a pessoa editou depois nao e tocado. Roda uma vez por app, com backup e aviso na tela.
const fs = require('fs');
const path = require('path');

const STORAGE = () => process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ARQ = () => path.join(STORAGE(), 'custos.json');
const META = () => path.join(STORAGE(), 'custos_meta.json');
const LOG = () => path.join(STORAGE(), 'custos_log.jsonl');
const PASTA_BKP = () => path.join(STORAGE(), 'custos_backups');
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
const gravarJson = (arq, o) => { fs.mkdirSync(path.dirname(arq), { recursive: true }); fs.writeFileSync(arq, JSON.stringify(o)); };
const registrar = (o) => { try { fs.mkdirSync(path.dirname(LOG()), { recursive: true }); fs.appendFileSync(LOG(), JSON.stringify({ em: new Date().toISOString(), ...o }) + '\n'); } catch {} };
const r2 = (v) => Math.round(Number(v) * 100) / 100;
const iguais = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

// custo absurdo na hora de gravar: R$ 20.000 ou mais, ou 50x maior/menor que o custo que ja existe
const suspeito = (antes, depois) => depois > 0 && (depois >= 20000 || (antes > 0 && (depois / antes >= 50 || antes / depois >= 50)));

function backup(origem) {
    if (!fs.existsSync(ARQ())) return null;
    try {
        fs.mkdirSync(PASTA_BKP(), { recursive: true });
        const ts = new Date(Date.now() - 3 * 3600e3).toISOString().replace(/[:.]/g, '-').slice(0, 19), f = path.join(PASTA_BKP(), `custos_${ts}_${origem}.json`);
        fs.copyFileSync(ARQ(), f);
        const L = fs.readdirSync(PASTA_BKP()).filter(n => /^custos_.*\.json$/.test(n)).sort();
        while (L.length > 30) fs.unlinkSync(path.join(PASTA_BKP(), L.shift()));
        return f;
    } catch { return null; }
}

// alteracoes: { sku: numero | null } (null ou 0 apaga o custo). Mescla com o que esta gravado.
function aplicarAlteracoes(alteracoes, { forcar = false, origem = 'tela' } = {}) {
    if (!alteracoes || typeof alteracoes !== 'object') throw new Error('Nada para salvar.');
    const C = lerJson(ARQ(), {}), mudam = [], suspeitos = [];
    for (const [k0, v0] of Object.entries(alteracoes)) {
        const k = String(k0).trim().toLowerCase(); if (!k) continue;
        const antes = Number(C[k]) > 0 ? Number(C[k]) : null;
        const depois = v0 == null || v0 === '' ? null : r2(v0);
        if (depois != null && (!isFinite(depois) || depois < 0)) throw new Error(`Custo inválido para ${k0}.`);
        const dep = depois > 0 ? depois : null;
        if (dep === antes || (dep != null && antes != null && iguais(dep, antes))) continue;
        if (dep != null && suspeito(antes, dep)) suspeitos.push({ sku: k, antes, depois: dep });
        mudam.push({ sku: k, antes, depois: dep });
    }
    if (suspeitos.length && !forcar) return { ok: false, suspeitos, erro: `${suspeitos.length} custo(s) parecem errados (vírgula perdida?). Nada foi gravado.` };
    if (!mudam.length) return { ok: true, alterados: 0 };
    backup(origem);
    for (const m of mudam) { if (m.depois == null) delete C[m.sku]; else C[m.sku] = m.depois; }
    gravarJson(ARQ(), C);
    registrar({ acao: 'alteracoes', origem, alterados: mudam.length, forcado: !!(forcar && suspeitos.length), amostra: mudam.slice(0, 15) });
    return { ok: true, alterados: mudam.length };
}

// planilha: { sku(minusculo): custo }. A planilha continua tendo prioridade, mas so grava depois da confirmacao e nunca grava suspeito.
function previaImportacao(planilha) {
    const C = lerJson(ARQ(), {}), mudam = [], novos = [], bloqueados = []; let iguaisN = 0;
    for (const [k, depois] of Object.entries(planilha)) {
        const antes = Number(C[k]) > 0 ? Number(C[k]) : null;
        if (antes == null) { if (suspeito(null, depois)) bloqueados.push({ sku: k, antes: null, depois }); else novos.push({ sku: k, antes: null, depois }); }
        else if (iguais(antes, depois)) iguaisN++;
        else if (suspeito(antes, depois)) bloqueados.push({ sku: k, antes, depois });
        else mudam.push({ sku: k, antes, depois });
    }
    const peso = (x) => Math.abs(x.depois - x.antes) / x.antes;
    return { mudam, novos, bloqueados, iguais: iguaisN, resumo: { mudam: mudam.length, novos: novos.length, bloqueados: bloqueados.length, iguais: iguaisN },
        amostra: [...mudam].sort((a, b) => peso(b) - peso(a)).slice(0, 10) };
}
function aplicarImportacao(planilha, origem = 'planilha') {
    const p = previaImportacao(planilha), C = lerJson(ARQ(), {});
    if (p.mudam.length || p.novos.length) {
        backup(origem);
        for (const x of [...p.mudam, ...p.novos]) C[x.sku] = x.depois;
        gravarJson(ARQ(), C);
    }
    registrar({ acao: 'importacao', origem, ...p.resumo, bloqueados_amostra: p.bloqueados.slice(0, 15), amostra: p.amostra });
    return { ...p, aplicado: true };
}

// ---- correcao unica pelo custo oficial do Mercado Turbo ----
const ID_CORRECAO = '2026-10-26-mt';
function corrigirUmaVez() {
    const meta = lerJson(META(), {});
    if ((meta.correcoes || []).includes(ID_CORRECAO)) return { ja: true };
    const tab = lerJson(path.join(__dirname, 'custos_correcoes.json'), null), C = lerJson(ARQ(), null);
    if (!tab || !C) return { ok: false };   // ainda sem tabela de custos neste PC: tenta de novo na proxima vez
    const feitas = [];
    for (const e of tab.correcoes || []) { const a = Number(C[e.sku]); if (a > 0 && (e.de || []).some(d => iguais(d, a))) feitas.push({ sku: e.sku, de: a, para: e.para }); }
    let bkp = null;
    if (feitas.length) { bkp = backup('correcao-mt'); for (const f of feitas) C[f.sku] = f.para; gravarJson(ARQ(), C); }
    const peso = (f) => Math.abs(f.de - f.para) / f.para;
    feitas.sort((a, b) => peso(b) - peso(a));
    registrar({ acao: 'correcao_mt', n: feitas.length, backup: bkp ? path.basename(bkp) : null, itens: feitas });
    meta.correcoes = [...(meta.correcoes || []), ID_CORRECAO];
    meta.ultima_correcao = { id: ID_CORRECAO, em: new Date().toISOString(), n: feitas.length, fonte: tab.fonte, backup: bkp ? path.basename(bkp) : null, itens: feitas.slice(0, 40) };
    gravarJson(META(), meta);
    return { ok: true, n: feitas.length };
}
const aviso = () => { const m = lerJson(META(), {}); return m.ultima_correcao && m.ultima_correcao.n ? m.ultima_correcao : null; };

module.exports = { aplicarAlteracoes, previaImportacao, aplicarImportacao, corrigirUmaVez, aviso, suspeito, backup };
