// Motor de preco do AD HEALTH, com as regras da empresa (07/10/2026). Camada "bronze" da Escalada
// de Prata: o calculo e as regras ficam aqui, sem IA; o Gemini so revisa e explica (camada prata).
//
//   VENDENDO BEM ... vendeu VENDENDO_BEM_ONTEM ou mais unidades ontem
//   SUBIR .......... vendendo bem E margem < MARGEM_TRACIONADO% -> preco que da +1 ponto de margem
//   TRACIONADO ..... margem >= MARGEM_TRACIONADO%: nao precisa subir agora
//   FEED TRACIONADOS 1o no grupo do Nubimetrics E margem >= MARGEM_TRACIONADO% (opcao de subir +1 pt)
//   Quem nao esta vendendo bem: este motor nao mexe (queima-margem e promocoes cuidam).
//
// Margem = preco - tarifa - custo - imposto - frete (igual ao precificador). Aplicar = PUT do preco
// pelo precificador (historico em precos_historico.jsonl, origem 'regra_margem'), so com confirmacao.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const P = require('./precificador');
const ia = require('./ia');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const CACHE = path.join(STORAGE, 'motor_preco.json');
const VALIDADE_MS = 30 * 60 * 1000;
const ML = 'https://api.mercadolibre.com';
const REGRAS = { VENDENDO_BEM_ONTEM: 2, MARGEM_TRACIONADO: 15, PASSO_PONTOS: 1 };
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };

// Margem atual do anuncio e o preco que leva a margem alvo (a tarifa muda com o preco: repete)
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

async function avaliar({ forcar = false } = {}) {
    const cache = lerJson(CACHE, null);
    if (!forcar && cache && Date.now() - new Date(cache.atualizado_em).getTime() < VALIDADE_MS) return cache;
    const s = await ia.saude();
    const { headers, userId } = await P.auth();
    const impostoPct = Number(lerJson(path.join(STORAGE, 'config.json'), {}).imposto_pct ?? 3);
    const alvo = s.itens.filter(i => i.status === 'active' && (i.ontem >= REGRAS.VENDENDO_BEM_ONTEM || i.rank_nub === 1));
    const linhas = [];
    for (const i of alvo) {
        const l = { item_id: i.item_id, sku: i.sku, titulo: i.titulo, curva: i.curva, ontem: i.ontem, media_dia: i.media_dia, vendas_mes: i.vendas_mes,
            rank_nub: i.rank_nub, grupo_anuncios: i.grupo_anuncios, grupo: i.grupo, lider: i.lider, df: i.df,
            rank_ml: i.rank_ml ? `${i.rank_ml.posicao}º na pág. ${i.rank_ml.pagina}` : null,
            vendendo_bem: i.ontem >= REGRAS.VENDENDO_BEM_ONTEM };
        try { Object.assign(l, await calcular(headers, userId, i.item_id, impostoPct)); }
        catch (e) { l.erro = e.response?.status ? `ML ${e.response.status}` : e.message; }
        if (l.margem_pct == null) { l.regra = 'SEM_DADOS'; l.motivo = l.erro || (l.custo == null ? 'Sem custo na planilha.' : 'Frete ou tarifa indisponível.'); }
        else if (l.margem_pct >= REGRAS.MARGEM_TRACIONADO) { l.regra = 'TRACIONADO'; l.motivo = `Margem de ${l.margem_pct}% (≥ ${REGRAS.MARGEM_TRACIONADO}%): já está tracionado, não precisa subir agora.`; }
        else if (l.vendendo_bem) { l.regra = 'SUBIR'; l.motivo = `Vendeu ${l.ontem} ontem e a margem está em ${l.margem_pct}% (< ${REGRAS.MARGEM_TRACIONADO}%): subir +${REGRAS.PASSO_PONTOS} ponto e observar.`; }
        else { l.regra = 'MANTER'; l.motivo = `1º no grupo, mas margem de ${l.margem_pct}% e não vendeu ${REGRAS.VENDENDO_BEM_ONTEM}+ ontem: sem mudança pela regra.`; }
        // preco sugerido: SUBIR sempre; TRACIONADO 1o no Nubimetrics tem a opcao de +1 pt
        if (l.margem_pct != null && (l.regra === 'SUBIR' || (l.regra === 'TRACIONADO' && l.rank_nub === 1))) {
            try { l.sugerido = await precoParaMargem(headers, l, l.margem_pct + REGRAS.PASSO_PONTOS, impostoPct); l.aumento_pct = r2((l.sugerido.preco / l.preco - 1) * 100); }
            catch (e) { l.sugerido = null; }
        }
        linhas.push(l);
    }
    const r = {
        atualizado_em: new Date().toISOString(), regras: REGRAS, imposto_pct: impostoPct, base_vendas: s.base?.dia_vendas || null,
        subir: linhas.filter(l => l.regra === 'SUBIR').sort((a, b) => b.ontem - a.ontem),
        tracionados: linhas.filter(l => l.regra === 'TRACIONADO' && l.rank_nub === 1).sort((a, b) => b.vendas_mes - a.vendas_mes),
        tracionados_outros: linhas.filter(l => l.regra === 'TRACIONADO' && l.rank_nub !== 1),
        manter: linhas.filter(l => l.regra === 'MANTER'), sem_dados: linhas.filter(l => l.regra === 'SEM_DADOS'),
    };
    fs.mkdirSync(STORAGE, { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(r), 'utf8');
    return r;
}

// Aplica o preco sugerido (so pelo botao, com confirmacao). Confere de novo antes de enviar.
async function aplicar(itemId, precoEsperado) {
    const r = await avaliar();
    const l = [...r.subir, ...r.tracionados].find(x => x.item_id === itemId);
    if (!l || !l.sugerido) return { ok: false, erro: 'Este anúncio não tem sugestão de preço agora. Atualize a lista.' };
    if (Math.abs(l.sugerido.preco - Number(precoEsperado)) > 0.05) return { ok: false, erro: `O preço sugerido mudou (agora R$ ${l.sugerido.preco}). Atualize a lista.` };
    const res = await P.aplicar(itemId, l.sugerido.preco, { origem: 'regra_margem', motivo: `${l.regra}: margem ${l.margem_pct}% -> ${l.sugerido.margem_pct}%` });
    if (res.ok) try { fs.rmSync(CACHE, { force: true }); } catch {}
    return res;
}

// Camada prata: o Gemini le as decisoes ja calculadas e aponta excecoes. Nao decide nem muda nada.
const INSTRUCAO_REVISAO = [
    'Voce revisa decisoes de preco ja calculadas por regras fixas da empresa. Nao recalcule nada e nao invente numeros.',
    'Regras: vendeu 2+ ontem e margem < 15% -> subir +1 ponto; margem >= 15% -> tracionado, nao subir; tracionado 1o no Nubimetrics pode subir +1 ponto se o dono quiser.',
    'Para cada linha, diga em uma frase curta se a decisao faz sentido ou se ha uma EXCECAO (ex.: um unico dia bom muito acima da media, concorrente bem mais barato com DF negativo, curva C, produto que nao e lanterna).',
    'Formato: "SKU — OK" ou "SKU — ATENCAO: motivo". No final, uma frase de resumo.',
].join(' ');
async function revisarIA() {
    const r = await avaliar();
    const lin = (t, l) => `${t} | ${l.sku} | ${String(l.titulo || '').slice(0, 45)} | curva ${l.curva || '-'} | ontem ${l.ontem} | media/dia ${l.media_dia} | vendas mes ${l.vendas_mes} | nubimetrics ${l.rank_nub ?? '-'}/${l.grupo_anuncios ?? '-'} | DF vs lider ${l.df ?? '-'}% | busca ${l.rank_ml || '-'} | preco ${l.preco} | margem ${l.margem_pct}%${l.sugerido ? ` -> sugerido ${l.sugerido.preco} (${l.sugerido.margem_pct}%)` : ''}`;
    const dados = [...r.subir.map(l => lin('SUBIR', l)), ...r.tracionados.map(l => lin('TRACIONADO_1o', l))].join('\n') || 'nenhuma decisao hoje';
    return ia.perguntar({ dados, instrucao: INSTRUCAO_REVISAO, pergunta: 'Revise as decisoes de preco de hoje.', numPredict: 900 });
}

module.exports = { avaliar, aplicar, revisarIA, REGRAS };
