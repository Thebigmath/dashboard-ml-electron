// Motor de preco do AD HEALTH, com as regras da empresa (07/10/2026). Camada "bronze" da Escalada
// de Prata: o calculo e as regras ficam aqui, sem IA; o Gemini so revisa e explica (camada prata).
//
//   VENDENDO BEM ... vendeu VENDENDO_BEM_ONTEM ou mais unidades ontem
//   SUBIR .......... vendendo bem E margem < MARGEM_TRACIONADO% -> preco que da +1 ponto de margem
//   TRACIONADO ..... margem >= MARGEM_TRACIONADO%: nao precisa subir agora
//   FEED TRACIONADOS 1o no grupo do Nubimetrics E margem >= MARGEM_TRACIONADO% (opcao de subir +1 pt)
//   Quem nao esta vendendo bem: este motor nao mexe (queima-margem e promocoes cuidam).
//
// TRAVAS (12/10/2026) — antes de sugerir subir, o anuncio passa por 5 conferencias:
//   1 promocao ....... em promocao ativa: subir tira o anuncio da campanha -> nao sobe sozinho
//   2 frete79 ........ o preco novo cruzaria R$ 79 (frete gratis obrigatorio): a margem mudaria -> nao sobe
//   3 concorrente .... ja mais de CONCORRENTE_MAX_PCT% acima do lider do Nubimetrics -> nao sobe
//   4 dia_isolado .... vendeu 2+ ontem mas a media e baixa (um dia bom isolado) -> nao conta como vendendo bem
//   5 pos-subida ..... OBSERVAR_DIAS depois de subir, compara as vendas/dia antes e depois; se cairam
//                      (abaixo de QUEDA% da media de antes) avisa e oferece voltar o preco
// Travado aparece com o motivo e pode ser subido a mao ("subir mesmo assim"), nunca sozinho.
//
// MODOS: "semi" (padrao) analisa todo dia depois da coleta da manha e AVISA, sem mudar nada;
//        "automatico" aplica os SUBIR que passaram nas travas (ate MAX_POR_DIA, ate MAX_AUMENTO_PCT)
//        e volta o preco dos que cairam depois da subida. Tudo registrado em precos_historico.jsonl.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const P = require('./precificador');
const ia = require('./ia');
const metas = require('./metas');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const CACHE = path.join(STORAGE, 'motor_preco.json');
const HIST = path.join(STORAGE, 'precos_historico.jsonl');
const CFG = path.join(STORAGE, 'motor_preco_config.json');
const MUDANCAS = path.join(STORAGE, 'motor_preco_mudancas.json');   // media de vendas antes de cada subida (trava 5)
const VALIDADE_MS = 30 * 60 * 1000;
const ML = 'https://api.mercadolibre.com';
const REGRAS = { VENDENDO_BEM_ONTEM: 2, MARGEM_TRACIONADO: 15, PASSO_PONTOS: 1 };
// Produtos com META de vendas (lib/metas.js, ex.: os tapetes): sobem +1% no preço só se bateram a meta ONTEM,
// estão até o 3º no grupo do Nubimetrics e a margem está abaixo de 15% (definido pelo usuário em 13/10/2026).
const REGRA_META = { RANK_MAX: 3, SUBIR_PCT: 1 };
const OBSERVAR_DIAS = 3;
const TRAVAS = { MEDIA_DIA_MINIMA: 0.3, CONCORRENTE_MAX_PCT: 10, FRETE_GRATIS: 79, QUEDA: 0.6, POS_ATE_DIAS: 14, MAX_POR_DIA: 10, MAX_AUMENTO_PCT: 3 };
const NOME_TRAVA = {
    promocao: 'Em promoção', frete79: 'Cruzaria R$ 79', concorrente: 'Mais caro que o líder', dia_isolado: 'Um dia bom isolado', estoque: 'Falta estoque / falta um lado',
};
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
const gravar = (arq, d) => { fs.mkdirSync(STORAGE, { recursive: true }); fs.writeFileSync(arq, JSON.stringify(d, null, 2), 'utf8'); };
const hojeBR = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);

// ---- configuracao (modo) --------------------------------------------------------------------------
function configuracao() {
    const c = { modo: 'semi', ...lerJson(CFG, {}) };
    if (c.automatico === true && !lerJson(CFG, {}).modo) c.modo = 'automatico';   // configuracao antiga
    delete c.automatico;
    return c;
}
function salvarConfiguracao(parcial) {
    const c = configuracao();
    if (parcial.modo === 'semi' || parcial.modo === 'automatico') c.modo = parcial.modo;
    if (parcial.automatico != null) c.modo = parcial.automatico ? 'automatico' : 'semi';
    gravar(CFG, c);
    return c;
}

// ---- historico das mudancas -----------------------------------------------------------------------
function historico() {
    const out = [];
    try {
        for (const l of fs.readFileSync(HIST, 'utf8').split(/\r?\n/)) {
            if (!l.trim()) continue;
            try { out.push(JSON.parse(l)); } catch {}
        }
    } catch {}
    return out;
}
function alteracoesRecentes() {
    const lim = Date.now() - OBSERVAR_DIAS * 86400000, m = new Map();
    for (const h of historico()) if (new Date(h.quando).getTime() >= lim) m.set(h.item_id, h);
    return m;
}
function registrarMudanca(l, origem) {
    const d = lerJson(MUDANCAS, {});
    d[l.item_id] = { item_id: l.item_id, sku: l.sku, titulo: l.titulo, quando: new Date().toISOString(), antes: l.preco, depois: l.sugerido.preco, media_antes: l.media_dia || 0, origem, status: 'observando' };
    gravar(MUDANCAS, d);
}

// ---- calculo de margem ----------------------------------------------------------------------------
async function calcular(headers, userId, itemId, impostoPct) {
    const { data: it } = await axios.get(`${ML}/items/${itemId}`, { headers, params: { include_attributes: 'all' }, timeout: 20000 });
    const sku = it.seller_custom_field || ((it.attributes || []).find(a => a.id === 'SELLER_SKU') || {}).value_name || '';
    const custo = P.custoDoSku(sku);
    let frete = null;
    try { frete = (await axios.get(`${ML}/users/${userId}/shipping_options/free`, { headers, params: { item_id: itemId }, timeout: 20000 })).data.coverage?.all_country?.list_cost ?? null; } catch {}
    const base = { preco: it.price, tipo: it.listing_type_id, categoria: it.category_id, custo: custo ? custo.valor : null, frete, status: it.status };
    if (!custo || frete == null) return base;
    const t = await P.tarifa(headers, it.price, it.listing_type_id, it.category_id);
    if (!t) return base;
    const m = P.margem(it.price, frete, custo.valor, impostoPct, t.valor);
    return { ...base, margem: m.margem, margem_pct: m.margem_pct };
}
async function precoParaMargem(headers, c, alvoPct, impostoPct) {
    let preco = c.preco, tar = await P.tarifa(headers, preco, c.tipo, c.categoria);
    for (let i = 0; i < 6; i++) {
        const pct = (tar && tar.pct != null ? Number(tar.pct) : 0) / 100, fixa = tar && tar.fixa != null ? Number(tar.fixa) : 0;
        const novo = r2((c.frete + c.custo + fixa) / (1 - impostoPct / 100 - pct - alvoPct / 100));
        if (Math.abs(novo - preco) < 0.01) break;
        preco = novo; tar = await P.tarifa(headers, preco, c.tipo, c.categoria);
    }
    const m = P.margem(preco, c.frete, c.custo, impostoPct, tar && tar.valor);
    return { preco, margem: m.margem, margem_pct: m.margem_pct };
}
// preco atual + pct%, com a margem recalculada (tarifa do ML no preco novo)
async function precoMaisPct(headers, c, pct, impostoPct) {
    const preco = r2(c.preco * (1 + pct / 100));
    const tar = await P.tarifa(headers, preco, c.tipo, c.categoria);
    const m = P.margem(preco, c.frete, c.custo, impostoPct, tar && tar.valor);
    return { preco, margem: m.margem, margem_pct: m.margem_pct };
}
// Regra das metas: devolve { regra, motivo } para produto com meta, ou null para usar a regra geral
function regraMeta(l) {
    const mt = metas.metaDe(l.sku, l.titulo);
    if (!mt) return null;
    l.meta = mt.meta; l.bateu_meta = mt.meta != null && (l.ontem || 0) >= mt.meta;
    const m = String(l.margem_pct).replace('.', ','), meta = String(mt.meta).replace('.', ',');
    if (l.margem_pct >= REGRAS.MARGEM_TRACIONADO) return { regra: 'TRACIONADO', motivo: `Margem de ${m}% (≥ ${REGRAS.MARGEM_TRACIONADO}%): já está tracionado, não precisa subir agora.` };
    if (mt.meta == null) return { regra: 'MANTER', motivo: 'Produto sem meta de vendas definida: não sobe pela regra de metas.' };
    if (!l.bateu_meta) return { regra: 'MANTER', motivo: `Vendeu ${l.ontem || 0} ontem e a meta é ${meta}/dia: não bateu a meta.` };
    if (l.rank_nub == null || l.rank_nub > REGRA_META.RANK_MAX) return { regra: 'MANTER', motivo: `Bateu a meta (${l.ontem} ontem, meta ${meta}/dia), mas ${l.rank_nub ? `está em ${l.rank_nub}º` : 'não aparece'} no grupo do Nubimetrics (precisa estar até o ${REGRA_META.RANK_MAX}º).` };
    return { regra: 'SUBIR', motivo: `Bateu a meta (${l.ontem} ontem, meta ${meta}/dia), está em ${l.rank_nub}º no Nubimetrics e a margem é ${m}% (< ${REGRAS.MARGEM_TRACIONADO}%): subir ${REGRA_META.SUBIR_PCT}% no preço e observar.` };
}
async function promocaoAtiva(headers, itemId) {
    try {
        const { data } = await axios.get(`${ML}/seller-promotions/items/${itemId}`, { headers, params: { app_version: 'v2' }, timeout: 20000 });
        const a = (Array.isArray(data) ? data : []).find(p => p.status === 'started');
        return a ? (a.name || a.type) : null;
    } catch { return null; }
}

// Travas 1-4 de um anuncio com preco sugerido. Devolve [] se pode subir.
async function travas(headers, l) {
    const t = [];
    // quem tem meta de vendas ja foi julgado pela meta de ontem (escolha do usuario): a trava do dia isolado nao vale
    if (l.regra === 'SUBIR' && l.meta === undefined && (l.media_dia || 0) < TRAVAS.MEDIA_DIA_MINIMA)
        t.push({ id: 'dia_isolado', txt: `Vendeu ${l.ontem} ontem, mas a média é ${String(l.media_dia ?? 0).replace('.', ',')}/dia: um dia bom isolado, não uma tendência.` });
    if (l.preco < TRAVAS.FRETE_GRATIS && l.sugerido.preco >= TRAVAS.FRETE_GRATIS)
        t.push({ id: 'frete79', txt: `O preço novo (R$ ${l.sugerido.preco}) passaria de R$ ${TRAVAS.FRETE_GRATIS}: o frete grátis vira obrigatório e a margem calculada deixa de valer.` });
    if (l.df != null && l.df > TRAVAS.CONCORRENTE_MAX_PCT)
        t.push({ id: 'concorrente', txt: `Já está ${String(l.df).replace('.', ',')}% acima do líder${l.lider ? ` (${l.lider})` : ''} no Nubimetrics: subir mais pode derrubar as vendas.` });
    const promo = await promocaoAtiva(headers, l.item_id);
    if (promo) t.push({ id: 'promocao', txt: `Está na promoção "${promo}": mudar o preço tira o anúncio da campanha.` });
    // regra do usuario (13/10/2026): produto zerado, outro lado zerado ou par com um lado faltando -> nao subir
    const est = require('./lados').travaEstoqueItem(l.item_id, l.sku);
    if (est) t.push({ id: 'estoque', txt: est });
    return t;
}

// ---- avaliacao ------------------------------------------------------------------------------------
async function avaliar({ forcar = false } = {}) {
    const cache = lerJson(CACHE, null);
    if (!forcar && cache && Date.now() - new Date(cache.atualizado_em).getTime() < VALIDADE_MS) return cache;
    const s = await ia.saude();
    const { headers, userId } = await P.auth();
    const impostoPct = Number(lerJson(path.join(STORAGE, 'config.json'), {}).imposto_pct ?? 3);
    const recentes = alteracoesRecentes();
    const alvo = s.itens.filter(i => i.status === 'active' && !recentes.has(i.item_id) && (i.ontem >= REGRAS.VENDENDO_BEM_ONTEM || i.rank_nub === 1 || metas.metaDe(i.sku, i.titulo)));
    const linhas = [];
    for (const i of alvo) {
        const l = { item_id: i.item_id, sku: i.sku, titulo: i.titulo, curva: i.curva, ontem: i.ontem, media_dia: i.media_dia, vendas_mes: i.vendas_mes,
            rank_nub: i.rank_nub, grupo_anuncios: i.grupo_anuncios, grupo: i.grupo, lider: i.lider, df: i.df,
            rank_ml: i.rank_ml ? `${i.rank_ml.posicao}º na pág. ${i.rank_ml.pagina}` : null,
            vendendo_bem: i.ontem >= REGRAS.VENDENDO_BEM_ONTEM };
        try { Object.assign(l, await calcular(headers, userId, i.item_id, impostoPct)); }
        catch (e) { l.erro = e.response?.status ? `ML ${e.response.status}` : e.message; }
        const rm = l.margem_pct != null ? regraMeta(l) : null;
        if (rm) { l.regra = rm.regra; l.motivo = rm.motivo; l.vendendo_bem = !!l.bateu_meta; }
        else if (l.margem_pct == null) { l.regra = 'SEM_DADOS'; l.motivo = l.erro || (l.custo == null ? 'Sem custo na planilha.' : 'Frete ou tarifa indisponível.'); }
        else if (l.margem_pct >= REGRAS.MARGEM_TRACIONADO) { l.regra = 'TRACIONADO'; l.motivo = `Margem de ${l.margem_pct}% (≥ ${REGRAS.MARGEM_TRACIONADO}%): já está tracionado, não precisa subir agora.`; }
        else if (l.vendendo_bem) { l.regra = 'SUBIR'; l.motivo = `Vendeu ${l.ontem} ontem e a margem está em ${l.margem_pct}% (< ${REGRAS.MARGEM_TRACIONADO}%): subir +${REGRAS.PASSO_PONTOS} ponto e observar.`; }
        else { l.regra = 'MANTER'; l.motivo = `1º no grupo, mas margem de ${l.margem_pct}% e não vendeu ${REGRAS.VENDENDO_BEM_ONTEM}+ ontem: sem mudança pela regra.`; }
        if (l.margem_pct != null && (l.regra === 'SUBIR' || (l.regra === 'TRACIONADO' && l.rank_nub === 1 && l.meta === undefined))) {
            try { l.sugerido = l.meta !== undefined && l.regra === 'SUBIR' ? await precoMaisPct(headers, l, REGRA_META.SUBIR_PCT, impostoPct) : await precoParaMargem(headers, l, l.margem_pct + REGRAS.PASSO_PONTOS, impostoPct); l.aumento_pct = r2((l.sugerido.preco / l.preco - 1) * 100); }
            catch { l.sugerido = null; }
            if (l.sugerido) {
                l.travas = await travas(headers, l);
                if (l.travas.length) { l.regra_original = l.regra; l.regra = 'TRAVADO'; l.motivo = l.travas.map(t => t.txt).join(' '); }
            }
        }
        linhas.push(l);
    }
    const pos = await posSubida(headers, userId);
    const r = {
        atualizado_em: new Date().toISOString(), regras: REGRAS, regra_meta: REGRA_META, travas: TRAVAS, nome_trava: NOME_TRAVA, imposto_pct: impostoPct,
        subir: linhas.filter(l => l.regra === 'SUBIR').sort((a, b) => b.ontem - a.ontem),
        tracionados: linhas.filter(l => l.regra === 'TRACIONADO' && l.rank_nub === 1).sort((a, b) => b.vendas_mes - a.vendas_mes),
        travados: linhas.filter(l => l.regra === 'TRAVADO').sort((a, b) => b.ontem - a.ontem),
        tracionados_outros: linhas.filter(l => l.regra === 'TRACIONADO' && l.rank_nub !== 1),
        manter: linhas.filter(l => l.regra === 'MANTER'), sem_dados: linhas.filter(l => l.regra === 'SEM_DADOS'),
        em_observacao: [...recentes.values()].sort((a, b) => String(b.quando).localeCompare(String(a.quando))),
        pos_subida: pos, observar_dias: OBSERVAR_DIAS, config: configuracao(),
    };
    gravar(CACHE, r);
    return r;
}

// ---- trava 5: o que aconteceu com as vendas depois da subida ---------------------------------------
async function unidadesDesde(headers, userId, itemId, desdeISO) {
    let total = 0;
    for (let off = 0; off < 500; off += 50) {
        const { data } = await axios.get(`${ML}/orders/search`, { headers, timeout: 20000,
            params: { seller: userId, item: itemId, 'order.date_created.from': desdeISO, limit: 50, offset: off } });
        for (const o of data.results || []) {
            if (o.status === 'cancelled') continue;
            for (const it of o.order_items || []) if (it.item?.id === itemId) total += Number(it.quantity) || 0;
        }
        if (off + 50 >= (data.paging?.total || 0)) break;
    }
    return total;
}
async function posSubida(headers, userId) {
    const d = lerJson(MUDANCAS, {});
    // mudancas feitas antes deste controle existir: entram com a media atual como referencia
    const coleta = lerJson(path.join(STORAGE, 'reposicao.json'), []);
    for (const h of historico()) {
        if (d[h.item_id] || !/^regra_margem|^automatico/.test(h.origem || '')) continue;
        if (Date.now() - new Date(h.quando).getTime() > TRAVAS.POS_ATE_DIAS * 86400000) continue;
        const p = coleta.find(x => x.item_id === h.item_id) || {};
        d[h.item_id] = { item_id: h.item_id, sku: p.sku || '', titulo: h.titulo, quando: h.quando, antes: h.antes, depois: h.depois, media_antes: (p.vendas30 || 0) / 30, origem: h.origem, status: 'observando', media_aproximada: true };
    }
    const out = [];
    for (const m of Object.values(d)) {
        const dias = (Date.now() - new Date(m.quando).getTime()) / 86400000;
        if (dias < OBSERVAR_DIAS || dias > TRAVAS.POS_ATE_DIAS || m.status === 'revertido') continue;
        try {
            const un = await unidadesDesde(headers, userId, m.item_id, m.quando);
            m.media_depois = r2(un / dias); m.dias = Math.round(dias);
            m.status = m.media_antes > 0 && m.media_depois < m.media_antes * TRAVAS.QUEDA ? 'caiu' : 'ok';
            m.variacao_pct = m.media_antes > 0 ? r2((m.media_depois / m.media_antes - 1) * 100) : null;
            out.push(m);
        } catch {}
    }
    gravar(MUDANCAS, d);
    return out.sort((a, b) => (a.status === 'caiu' ? -1 : 1) - (b.status === 'caiu' ? -1 : 1));
}
async function reverter(itemId, origem = 'reversao') {
    const d = lerJson(MUDANCAS, {}); const m = d[itemId];
    if (!m) return { ok: false, erro: 'Esta mudança não está mais em acompanhamento.' };
    const res = await P.aplicar(itemId, m.antes, { origem, motivo: `vendas caíram depois da subida (${m.media_antes?.toFixed?.(2)} → ${m.media_depois}/dia): voltou ao preço anterior` });
    if (res.ok) { m.status = 'revertido'; m.revertido_em = new Date().toISOString(); gravar(MUDANCAS, d); fs.rmSync(CACHE, { force: true }); }
    return res;
}

// ---- aplicar --------------------------------------------------------------------------------------
// Um anuncio (botao). "forcar" = subir mesmo travado (so a mao, com confirmacao forte na tela).
async function aplicar(itemId, precoEsperado, { forcar = false } = {}) {
    const r = await avaliar();
    const lista = [...r.subir, ...r.tracionados, ...(forcar ? r.travados : [])];
    const l = lista.find(x => x.item_id === itemId);
    if (!l || !l.sugerido) return { ok: false, erro: 'Este anúncio não tem sugestão de preço agora. Atualize a lista.' };
    if (Math.abs(l.sugerido.preco - Number(precoEsperado)) > 0.05) return { ok: false, erro: `O preço sugerido mudou (agora R$ ${l.sugerido.preco}). Atualize a lista.` };
    const res = await P.aplicar(itemId, l.sugerido.preco, { origem: forcar ? 'regra_margem_forcado' : 'regra_margem', motivo: `${l.regra_original || l.regra}: margem ${l.margem_pct}% -> ${l.sugerido.margem_pct}%` });
    if (res.ok) { registrarMudanca(l, forcar ? 'forcado' : 'manual'); fs.rmSync(CACHE, { force: true }); }
    return res;
}
// Todos os "Subir +1 ponto" (que ja passaram nas travas). No automatico, com limite por dia e de aumento.
async function aplicarTodos({ origem = 'regra_margem_lote', automatico = false } = {}) {
    fs.rmSync(CACHE, { force: true });
    const r = await avaliar({ forcar: true });
    let lista = r.subir.filter(l => l.sugerido);
    const pulados = [];
    if (automatico) {
        lista = lista.filter(l => {
            if ((l.aumento_pct || 0) > TRAVAS.MAX_AUMENTO_PCT) { pulados.push({ sku: l.sku, motivo: `aumento de ${l.aumento_pct}% acima de ${TRAVAS.MAX_AUMENTO_PCT}%` }); return false; }
            return true;
        });
        lista.slice(TRAVAS.MAX_POR_DIA).forEach(l => pulados.push({ sku: l.sku, motivo: `limite de ${TRAVAS.MAX_POR_DIA} por dia` }));
        lista = lista.slice(0, TRAVAS.MAX_POR_DIA);
    }
    const feitos = [], falhas = [];
    for (const l of lista) {
        const res = await P.aplicar(l.item_id, l.sugerido.preco, { origem, motivo: `${l.regra}: margem ${l.margem_pct}% -> ${l.sugerido.margem_pct}%` });
        if (res.ok) registrarMudanca(l, origem);
        (res.ok ? feitos : falhas).push({ item_id: l.item_id, sku: l.sku, titulo: l.titulo, antes: l.preco, depois: l.sugerido.preco, erro: res.erro });
    }
    fs.rmSync(CACHE, { force: true });
    return { ok: true, feitos, falhas, pulados, travados: r.travados.length };
}

// ---- rodada diaria (os dois modos) -----------------------------------------------------------------
// Depois da coleta da manha (1a abertura do AD HEALTH), uma vez por dia:
//   semi ........ analisa e AVISA no Windows (sugestoes, travados, quedas depois da subida). Nao muda nada.
//   automatico .. aplica os SUBIR (com os limites), volta o preco dos que cairam e avisa o que fez.
let timer = null;
async function rodadaDiaria() {
    const c = configuracao(), hoje = hojeBR();
    if (c.ultima_rodada === hoje) return null;
    if (lerJson(path.join(STORAGE, 'adhealth_abertura.json'), {}).dia !== hoje) return null;   // espera a coleta do dia
    let resumo;
    if (c.modo === 'automatico') {
        const res = await aplicarTodos({ origem: 'automatico', automatico: true });
        const r = await avaliar({ forcar: true });
        const voltas = [];
        for (const m of r.pos_subida.filter(x => x.status === 'caiu')) { const v = await reverter(m.item_id, 'automatico_reversao'); if (v.ok) voltas.push(m); }
        resumo = { modo: 'automatico', subiu: res.feitos.length, falhas: res.falhas.length, pulados: res.pulados.length, travados: r.travados.length, voltou: voltas.length };
        const linhas = [...res.feitos.map(f => `↑ ${f.sku}: R$ ${f.antes} → R$ ${f.depois}`), ...voltas.map(m => `↓ ${m.sku}: voltou para R$ ${m.antes} (vendas caíram)`)];
        notificarResumo(`Preços (automático): ${res.feitos.length} aumento(s)${voltas.length ? `, ${voltas.length} volta(s)` : ''}`, linhas.join('\n') || 'Nada para mudar hoje.');
    } else {
        const r = await avaliar({ forcar: true });
        const caiu = r.pos_subida.filter(x => x.status === 'caiu');
        resumo = { modo: 'semi', sugestoes: r.subir.length, travados: r.travados.length, quedas: caiu.length };
        const partes = [`${r.subir.length} para subir +1 ponto`, `${r.tracionados.length} tracionado(s)`, `${r.travados.length} travado(s)`];
        if (caiu.length) partes.push(`${caiu.length} com queda depois da subida`);
        notificarResumo(`Preços: análise do dia pronta${caiu.length ? ' — atenção' : ''}`, partes.join(' · ') + '. Nada foi mudado: abra Regras de preço para decidir.');
    }
    const c2 = configuracao(); c2.ultima_rodada = hoje; c2.ultimo_resultado = { quando: new Date().toISOString(), ...resumo };
    gravar(CFG, c2);
    return resumo;
}
function notificarResumo(titulo, corpo) { try { require('./notificar').notificar(titulo, corpo, '/seven#regras'); } catch {} }
function iniciarAgendador() { pararAgendador(); timer = setInterval(() => rodadaDiaria().catch(() => {}), 15 * 60 * 1000); setTimeout(() => rodadaDiaria().catch(() => {}), 3 * 60 * 1000); }
function pararAgendador() { if (timer) clearInterval(timer); timer = null; }

// ---- camada prata: o Gemini revisa (nao decide nem muda nada) ---------------------------------------
const INSTRUCAO_REVISAO = [
    'Voce revisa decisoes de preco ja calculadas por regras fixas da empresa. Nao recalcule nada e nao invente numeros.',
    'Regras: vendeu 2+ ontem e margem < 15% -> subir +1 ponto; margem >= 15% -> tracionado, nao subir; tracionado 1o no Nubimetrics pode subir +1 ponto se o dono quiser.',
    'Travas ja aplicadas pelo codigo: promocao ativa, cruzar R$ 79, mais de 10% acima do lider, um dia bom isolado. Linhas TRAVADO nao sobem sozinhas.',
    'Para cada linha, diga em uma frase curta se a decisao faz sentido ou se ha uma EXCECAO.',
    'Formato: "SKU — OK" ou "SKU — ATENCAO: motivo". No final, uma frase de resumo.',
].join(' ');
async function revisarIA() {
    const r = await avaliar();
    const lin = (t, l) => `${t} | ${l.sku} | ${String(l.titulo || '').slice(0, 45)} | curva ${l.curva || '-'} | ontem ${l.ontem} | media/dia ${l.media_dia} | vendas mes ${l.vendas_mes} | nubimetrics ${l.rank_nub ?? '-'}/${l.grupo_anuncios ?? '-'} | DF vs lider ${l.df ?? '-'}% | busca ${l.rank_ml || '-'} | preco ${l.preco} | margem ${l.margem_pct}%${l.sugerido ? ` -> sugerido ${l.sugerido.preco} (${l.sugerido.margem_pct}%)` : ''}${l.travas && l.travas.length ? ' | travas: ' + l.travas.map(t => t.id).join(',') : ''}`;
    const dados = [...r.subir.map(l => lin('SUBIR', l)), ...r.tracionados.map(l => lin('TRACIONADO_1o', l)), ...r.travados.map(l => lin('TRAVADO', l))].join('\n') || 'nenhuma decisao hoje';
    return ia.perguntar({ dados, instrucao: INSTRUCAO_REVISAO, pergunta: 'Revise as decisoes de preco de hoje.', numPredict: 900 });
}

module.exports = { avaliar, aplicar, aplicarTodos, reverter, revisarIA, configuracao, salvarConfiguracao, iniciarAgendador, pararAgendador, rodadaDiaria, calcular, precoParaMargem, precoMaisPct, regraMeta, promocaoAtiva, REGRAS, REGRA_META, TRAVAS };
