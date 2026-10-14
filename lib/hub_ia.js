// Cris, a IA do SEVEN (clique no 7 do Inicio, pedido do usuario em 14/10/2026; nome dado pelo usuario): conversa com uma IA que analisa os anuncios.
// Escalada de Prata: o SEVEN junta os numeros (bronze) e a IA le, cruza e explica (prata). A IA so analisa e
// recomenda; nao muda preco nem anuncio (isso continua no Precificar / Rankeamento, com confirmacao).
//   dados ....... todos os anuncios ativos (e os pausados que venderam): preco, estoque, transito, vendas 30d,
//                 ontem, media/dia, cobertura, curva ABC, MC% real de ontem, Nubimetrics, sinais de saude
//   detalhe ..... anuncio citado na pergunta (MLB ou SKU): margem atual, custo, frete, vendas dia a dia, mudancas de preco
//   chave ....... config.json -> hub_gemini_api_key (chave propria do Hub); sem ela usa as chaves do AD HEALTH
const fs = require('fs');
const path = require('path');
const ia = require('./ia');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const CONFIG = path.join(STORAGE, 'config.json');
const VALIDADE_DADOS_MS = 10 * 60 * 1000;
const VALIDADE_MC_MS = 30 * 60 * 1000;
const MODELO = { rapido: 'gemini-3.1-flash-lite', profundo: 'gemini-3-flash-preview' };
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
const n2 = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? '-' : String(Math.round(Number(v) * 100) / 100).replace('.', ','));
const limpa = (s, n) => String(s || '').replace(/[|\n\r]+/g, ' ').trim().slice(0, n);

function chaveHub() { return String(lerJson(CONFIG, {}).hub_gemini_api_key || '').trim(); }
function salvarChave(chave) {
    chave = String(chave || '').trim();
    if (!/^[A-Za-z0-9_.-]{30,}$/.test(chave)) throw new Error('Chave do Gemini inválida.');
    const c = lerJson(CONFIG, {});
    c.hub_gemini_api_key = chave;
    fs.mkdirSync(STORAGE, { recursive: true });
    fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2), 'utf8');
    return { ok: true, final: chave.slice(-4) };
}
function removerChave() {
    const c = lerJson(CONFIG, {});
    delete c.hub_gemini_api_key;
    fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2), 'utf8');
    return { ok: true };
}

// MC% real de ontem (a mesma conta da Analise de vendas). Demora (pedido a pedido), entao fica guardada 30 min
// e e pedida em segundo plano quando o Hub abre.
let mc = { em: 0, dados: null, rodando: null };
function mcOntem() {
    if (mc.dados && Date.now() - mc.em < VALIDADE_MC_MS) return Promise.resolve(mc.dados);
    if (!mc.rodando) {
        mc.rodando = require('./vendas_mc').analisar({ periodo: 'ontem' })
            .then(d => { mc = { em: Date.now(), dados: d, rodando: null }; return d; })
            .catch(e => { mc.rodando = null; throw e; });
    }
    return mc.rodando;
}

let cache = { em: 0, texto: '', info: null };
async function dados({ forcar = false } = {}) {
    if (!forcar && cache.texto && Date.now() - cache.em < VALIDADE_DADOS_MS && (cache.info.mc_ontem || !mc.rodando)) return cache;
    const rep = lerJson(path.join(STORAGE, 'reposicao.json'), []);
    const avisos = [];
    let s = null; try { s = await ia.saude(); } catch (e) { avisos.push('saúde/Nubimetrics: ' + e.message); }
    // a MC de ontem entra se ja estiver pronta (ou ficar em ate 25 s); senao a conversa segue sem ela
    let v = null;
    try { v = await Promise.race([mcOntem(), new Promise(r => setTimeout(() => r(null), 25000))]); } catch (e) { avisos.push('MC de ontem: ' + e.message); }
    const saude = new Map((s ? s.itens : []).map(i => [i.item_id, i]));
    const mcPor = new Map(((v && v.anuncios) || []).map(a => [a.item_id, a]));
    const metas = require('./metas');
    // preco mudado nos ultimos 3 dias (SEVEN ou fora dele): a IA nao manda subir de novo, manda observar
    const mudou = {};
    for (const h of require('./precificador').historico(undefined, 1000))
        if (h.item_id && Date.now() - new Date(h.quando).getTime() < 3 * 86400000 && !mudou[h.item_id]) mudou[h.item_id] = h;
    for (const [id, a] of Object.entries((v && v.alterados) || {})) if (!mudou[id]) mudou[id] = a;
    const quando = (q) => { const d = new Date(q); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`; };
    const linhas = rep.filter(r => r.status === 'active' || Number(r.vendas30) > 0)
        .sort((a, b) => (Number(b.vendas30) || 0) - (Number(a.vendas30) || 0));
    const L = [];
    L.push('ANUNCIOS (1 por linha, ordenados por vendas 30d). Colunas:');
    L.push('MLB | SKU | titulo | status | preco R$ | estoque Full | em transito | vendas 30d | ontem (un) | media/dia | cobertura (dias) | reposicao sugerida | curva ABC | MC% real ontem | preco mudado nos ultimos 3 dias | meta/dia | rank Nubimetrics (posicao/total do grupo) | DF% vs lider | sinais de saude');
    for (const r of linhas) {
        const h = saude.get(r.item_id) || {}, m = mcPor.get(r.item_id), mt = metas.metaDe(r.sku, r.titulo);
        L.push([r.item_id, limpa(r.sku, 28) || '-', limpa(r.titulo, 70), r.status === 'active' ? 'ativo' : r.status, n2(r.preco), r.estoque ?? '-', r.transferenciaMl ?? 0,
            r.vendas30 ?? 0, h.ontem ?? '-', n2(r.mediaDia ?? h.media_dia), r.cobertura == null ? '-' : Math.round(r.cobertura), Math.round(Number(r.reposicao) || 0),
            r.curvaAbc || h.curva || '-', m && m.mc_pct != null ? n2(m.mc_pct) + '%' : '-',
            mudou[r.item_id] ? `sim ${quando(mudou[r.item_id].quando)} ${n2(mudou[r.item_id].antes)}->${n2(mudou[r.item_id].depois)}` : 'nao', mt && mt.meta != null ? mt.meta : '-',
            h.rank_nub != null ? `${h.rank_nub}/${h.grupo_anuncios ?? '?'}` : '-', h.df != null ? h.df + '%' : '-',
            (h.sinais || []).map(x => x.tipo).join(',') || '-'].join(' | '));
    }
    if (v) {
        L.push('');
        L.push(`VENDAS DE ONTEM (${v.de}): ${v.resumo.pedidos} pedidos, ${v.resumo.unidades} un, faturamento R$ ${n2(v.resumo.faturamento)}, MC R$ ${n2(v.resumo.mc)} (${n2(v.resumo.mc_pct)}%), ${v.resumo.abaixo_alvo} anuncios abaixo de ${v.mc_alvo}%, ${v.resumo.sem_custo} sem custo na planilha.`);
    }
    // ---- LISTAS PRONTAS: o SEVEN aplica as regras (bronze); a IA so le e explica (prata) ----
    const porId = new Map(rep.map(r => [r.item_id, r]));
    const motor = require('./motor_preco'), lados = require('./lados');
    if (v) {
        const abaixo = (v.anuncios || []).filter(a => a.mc_pct != null && a.mc_pct < v.mc_alvo).sort((a, b) => b.faturamento - a.faturamento);
        L.push('');
        L.push(`LISTA PRONTA 1 - VENDERAM ONTEM COM MC ABAIXO DE ${v.mc_alvo}% (${abaixo.length} anuncios; a acao JA esta calculada pelas regras, nao recalcule):`);
        L.push('MLB | SKU | titulo | un ontem | faturamento ontem | MC% | acao pela regra');
        for (const a of abaixo) {
            const r = porId.get(a.item_id) || {}, h = saude.get(a.item_id) || {};
            let acao;
            if (r.status && r.status !== 'active') acao = 'nao mexer: anuncio pausado';
            else if (mudou[a.item_id]) acao = `observar: preco ja mudou em ${quando(mudou[a.item_id].quando)} (${n2(mudou[a.item_id].antes)} -> ${n2(mudou[a.item_id].depois)})`;
            else {
                const est = lados.travaEstoqueItem(a.item_id, a.sku);
                const rm = motor.regraMeta({ sku: a.sku, titulo: a.titulo, ontem: a.unidades, rank_nub: h.rank_nub ?? null, margem_pct: a.mc_pct });
                if (est) acao = 'nao subir: ' + est;
                else if (rm && rm.regra !== 'SUBIR') acao = 'manter (tapete com meta): ' + rm.motivo;
                else if (h.df != null && h.df > motor.TRAVAS.CONCORRENTE_MAX_PCT) acao = `nao subir: ja esta ${h.df}% acima do lider no Nubimetrics`;
                else acao = 'subir +1 ponto de margem e observar 3 dias';
            }
            L.push([a.item_id, limpa(a.sku, 28) || '-', limpa(a.titulo, 60), a.unidades, n2(a.faturamento), n2(a.mc_pct) + '%', acao].join(' | '));
        }
    }
    const ruptura = rep.filter(r => r.status === 'active' && Number(r.mediaDia) >= 0.3 && r.cobertura != null && Number(r.cobertura) < 15)
        .sort((a, b) => (Number(b.vendas30) || 0) - (Number(a.vendas30) || 0));
    L.push('');
    L.push(`LISTA PRONTA 2 - RISCO DE RUPTURA NO FULL (ativos vendendo 0,3+/dia com menos de 15 dias de cobertura; ${ruptura.length} anuncios):`);
    L.push('MLB | SKU | titulo | estoque Full | em transito | media/dia | cobertura (dias) | reposicao sugerida');
    for (const r of ruptura.slice(0, 60)) L.push([r.item_id, limpa(r.sku, 28) || '-', limpa(r.titulo, 60), r.estoque ?? 0, r.transferenciaMl ?? 0, n2(r.mediaDia), Math.round(Number(r.cobertura)), Math.round(Number(r.reposicao) || 0)].join(' | '));
    if (s) {
        const quedas = s.itens.filter(i => i.status === 'active' && (i.sinais || []).some(x => x.tipo === 'sem_ontem')).sort((a, b) => (b.media_dia || 0) - (a.media_dia || 0));
        L.push('');
        L.push(`LISTA PRONTA 3 - NAO VENDERAM ONTEM MAS TEM GIRO NORMAL (${quedas.length} anuncios, os que mais vendiam primeiro):`);
        L.push('MLB | SKU | titulo | curva | media/dia | vendas no mes | estoque Full | sinal');
        for (const i of quedas.slice(0, 40)) L.push([i.item_id, limpa(i.sku, 28) || '-', limpa(i.titulo, 60), i.curva || '-', n2(i.media_dia), i.vendas_mes, (porId.get(i.item_id) || {}).estoque ?? '-',
            (i.sinais.find(x => x.tipo === 'sem_ontem') || {}).txt || ''].join(' | '));
        const caros = s.itens.filter(i => i.status === 'active' && (i.sinais || []).some(x => x.tipo === 'preco_caro_sem_venda' || x.tipo === 'subir_preco')).sort((a, b) => (b.df || 0) - (a.df || 0));
        L.push('');
        L.push(`LISTA PRONTA 4 - PRECO CONTRA O LIDER DO NUBIMETRICS (${caros.length} anuncios 5%+ acima do lider):`);
        L.push('MLB | SKU | titulo | nosso preco | preco do lider (vendedor) | DF% | ontem / media | leitura da regra');
        for (const i of caros.slice(0, 40)) {
            const sg = i.sinais.find(x => x.tipo === 'preco_caro_sem_venda' || x.tipo === 'subir_preco');
            L.push([i.item_id, limpa(i.sku, 28) || '-', limpa(i.titulo, 60), n2(i.preco), `${n2(i.preco / (1 + i.df / 100))} (${limpa(i.lider, 24) || '-'})`, i.df + '%', `${i.ontem} / ${n2(i.media_dia)}`,
                sg.tipo === 'subir_preco' ? 'caro mas vendendo acima da media: pode manter' : 'caro e vendendo abaixo da media: perdendo venda para o lider'].join(' | '));
        }
    }
    const pm = lerJson(path.join(STORAGE, 'premium_monitor.json'), null);
    if (pm && pm.pares) {
        const ruins = pm.pares.filter(p => p.status === 'subir');
        L.push('');
        L.push(`PREMIUM x CLASSICO (regra: a margem do Premium tem que ser maior que a do Classico; ${pm.total} pares, ${ruins.length} com o Premium abaixo):`);
        for (const p of ruins.slice(0, 40)) L.push(`- ${limpa(p.sku, 24)} ${limpa(p.titulo, 50)} | Classico ${p.classico.item_id} ${n2(p.classico.margem_pct)}% | Premium ${p.premium.item_id} ${n2(p.premium.margem_pct)}%${p.sugestao ? ` | sugestao Premium R$ ${n2(p.sugestao.preco)}` : ''}`);
    }
    const info = { anuncios: linhas.length, ativos: linhas.filter(r => r.status === 'active').length, mc_ontem: !!v, saude: !!s,
        nubimetrics: !!(s && s.base && s.base.conc_disponivel), premium: !!(pm && pm.pares), avisos, atualizado_em: new Date().toISOString() };
    cache = { em: Date.now(), texto: L.join('\n'), info };
    return cache;
}

// anuncios citados na pergunta: MLB direto ou SKU que aparece como palavra
async function detalhes(pergunta) {
    const txt = String(pergunta || '');
    const rep = lerJson(path.join(STORAGE, 'reposicao.json'), []);
    const ids = new Set((txt.match(/MLB-?\d{6,}/gi) || []).map(x => x.toUpperCase().replace('-', '')));
    const palavras = new Set(txt.toLowerCase().split(/[^a-z0-9-]+/).filter(w => w.length >= 3));
    for (const r of rep) { const s = String(r.sku || '').toLowerCase(); if (s && palavras.has(s)) ids.add(r.item_id); }
    const lista = [...ids].slice(0, 4);
    if (!lista.length) return '';
    const P = require('./precificador'), motor = require('./motor_preco');
    const impostoPct = Number(lerJson(CONFIG, {}).imposto_pct ?? 7);
    let a = null; try { a = await P.auth(); } catch {}
    const out = ['DETALHE DOS ANUNCIOS CITADOS'];
    for (const id of lista) {
        const r = rep.find(x => x.item_id === id) || {};
        let c = null; if (a) { try { c = await motor.calcular(a.headers, a.userId, id, impostoPct); } catch {} }
        const dias = Object.entries(r.vendasDia || {}).filter(([d]) => Number(d) <= 13).sort((x, y) => Number(x[0]) - Number(y[0])).map(([d, q]) => `d-${d}:${q}`).join(' ');
        const hist = P.historico(id, 5).map(h => `${String(h.quando).slice(0, 10)} ${n2(h.antes)}->${n2(h.depois)}`).join('; ');
        out.push(`- ${id} ${limpa(r.titulo, 70)} (SKU ${r.sku || '-'})`
            + (c ? ` | preco agora R$ ${n2(c.preco)} | tipo ${c.tipo === 'gold_pro' ? 'Premium' : c.tipo === 'gold_special' ? 'Classico' : c.tipo} | custo ${n2(c.custo)} | frete vendedor ${n2(c.frete)} | margem atual ${c.margem_pct != null ? n2(c.margem_pct) + '%' : 'sem dado'}` : ' | margem: sem dado')
            + `\n  vendas por dia (d-0 = hoje): ${dias || 'sem dado'}\n  ultimas mudancas de preco: ${hist || 'nenhuma registrada'}`);
    }
    return out.join('\n');
}

const SISTEMA = `Voce e o Cris, a IA do SEVEN (o sistema da Seven, loja de autopecas no Mercado Livre, contas Flavia e Cordeiro). Seu nome e Cris; se perguntarem quem voce e, responda que e o Cris, a IA do SEVEN.
Voce conversa com o dono da loja e analisa os anuncios DESTA conta usando SOMENTE o bloco DADOS. Nunca invente numero, anuncio, SKU ou preco; se faltar dado, diga "sem dado".
Regras da loja (use nas recomendacoes):
- MC% = margem de contribuicao real da venda (venda - cupom - custo - imposto 7% - tarifa - frete do vendedor). Alvo: 15%.
- Abaixo de 15% e vendendo: subir +1 PONTO de margem (ex.: 1,22% -> 2,22%), nunca 1% do preco, e observar 3 dias. 15% ou mais: tracionado, manter e defender.
- Nao subir: anuncio em promocao, preco cruzando R$ 79 (frete gratis), mais de 10% acima do lider no Nubimetrics, falta de estoque do produto, do outro lado (Direito/Esquerdo) ou de um lado do Par.
- Mudou um lado (Direito/Esquerdo), muda o outro; mesmo SKU em outro anuncio recebe a mesma mudanca em pontos.
- A margem do Premium tem que ser sempre maior que a do Classico do mesmo produto.
- Tapetes com meta por dia: so sobem +1 ponto se bateram a meta ontem, estao ate o 3o no grupo do Nubimetrics e a margem esta abaixo de 15%.
- Cobertura baixa (poucos dias de estoque) com venda boa = risco de ruptura: priorizar reposicao no Full.
- Anuncio com "preco mudado nos ultimos 3 dias = sim" esta em observacao: NAO mande subir de novo; diga que ja subiu e que e para observar.
- Anuncio pausado nao entra em recomendacao de preco.
- As LISTAS PRONTAS ja trazem a acao calculada pelas regras: para perguntas sobre margem de ontem, ruptura, quedas, concorrencia e Premium x Classico, use a lista e a acao dela exatamente como estao (nao mude a acao, nao tire nem ponha anuncio). A tabela ANUNCIOS serve para as outras perguntas.
Voce NAO altera nada: quando recomendar mudanca de preco, diga que e feita em Rankeamento > Analise de vendas > Precificar (ou Premium x Classico).
Responda em portugues do Brasil, direto, sem introducao e sem repetir a mesma frase em cada item.
Quando a resposta tiver varios anuncios, use UMA tabela markdown simples (MLB | SKU | numeros que importam | acao curta), com no maximo 12 linhas, ordenada pelo que mais pesa em dinheiro (vendas/faturamento), e diga quantos ficaram de fora.
Separe o que e para fazer agora do que ja esta em observacao. Use **negrito** so no essencial. Termine com a acao mais importante em uma frase.`;

async function perguntar({ mensagens = [], modo = 'rapido' } = {}) {
    const hist = (Array.isArray(mensagens) ? mensagens : []).filter(m => m && m.texto && (m.papel === 'eu' || m.papel === 'ia')).slice(-12);
    if (!hist.length || hist[hist.length - 1].papel !== 'eu') throw new Error('Pergunta vazia.');
    const t0 = Date.now();
    const [d, det] = await Promise.all([dados(), detalhes(hist[hist.length - 1].texto)]);
    const sistema = `${SISTEMA}\n\nDADOS (atualizados em ${new Date(d.info.atualizado_em).toLocaleString('pt-BR')})\n${d.texto}${det ? '\n\n' + det : ''}`;
    const contents = hist.map(m => ({ role: m.papel === 'eu' ? 'user' : 'model', parts: [{ text: String(m.texto).slice(0, 8000) }] }));
    const modelo = MODELO[modo] || MODELO.rapido;
    const hub = chaveHub();
    const r = await Promise.race([
        ia.gerarGemini(sistema, null, modo === 'profundo' ? 6000 : 3000, modelo, { contents, chaves: hub ? [hub] : null }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('a IA demorou mais de 2 minutos')), 120000)),
    ]);
    return { texto: r.texto, modelo: r.modelo, chave: r.chave, ms: Date.now() - t0, cortada: r.cortada, info: d.info, detalhe: !!det };
}

async function estado() {
    const g = await ia.estado();
    const hub = chaveHub();
    mcOntem().catch(() => {});   // ja vai calculando a MC de ontem enquanto a pessoa escreve
    return { chave_hub: hub ? hub.slice(-4) : null, chaves_ad_health: g.chaves || 0, online: !!hub || g.online, dados: cache.info, modelos: MODELO };
}

module.exports = { perguntar, estado, dados, salvarChave, removerChave };
