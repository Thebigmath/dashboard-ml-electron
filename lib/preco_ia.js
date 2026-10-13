// Sugestao de preco da IA para um anuncio que vendeu (Analise de vendas -> Precificar).
// Escalada de Prata: o motor (bronze) faz as contas com as regras de preco; a IA (prata) le os numeros,
// confirma ou ajusta a decisao e explica. A IA nunca passa dos limites: no maximo +3% / -3% do preco atual.
//   regra: MC% abaixo de 15% e vendendo -> subir +1 ponto de margem; 15% ou mais -> manter (defender)
//   travas: promocao ativa, cruzar R$ 79 (frete gratis), mais de 10% acima do lider no Nubimetrics
// Sem IA (sem chave, fora do ar) devolve a decisao do motor, marcada como fonte 'regra'.
const fs = require('fs');
const path = require('path');
const P = require('./precificador');
const motor = require('./motor_preco');
const ia = require('./ia');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const LIMITE_PCT = motor.TRAVAS.MAX_AUMENTO_PCT || 3;
const ALVO = motor.REGRAS.MARGEM_TRACIONADO;

const SISTEMA = `Você é o analista de preços de uma loja de autopeças no Mercado Livre.
Recebe os números de UM anúncio que vendeu e a decisão que o motor de regras calculou.
Regras da loja: MC% (margem de contribuição real da venda) abaixo de ${ALVO}% e vendendo -> subir 1 ponto de margem e observar 3 dias;
MC% de ${ALVO}% ou mais -> tracionado: manter o preço e defender. Nunca mexa no preço de anúncio em promoção.
Produtos com META de vendas por dia (ex.: tapetes): só sobem +1% no preço se venderam ontem pelo menos a meta, estão até o 3º no grupo do Nubimetrics e a margem está abaixo de ${ALVO}%; se não bateram a meta, manter.
Subir pouco e observar é melhor do que subir muito. Se um dia bom é isolado (média/dia baixa), seja cauteloso.
Responda SÓ em JSON: {"acao":"subir"|"manter"|"baixar","preco":número,"motivo":"2 ou 3 frases curtas em português, falando dos números","riscos":["..."],"confianca":"alta"|"media"|"baixa"}.
O preço tem que ficar entre o mínimo e o máximo informados.`;

async function sugerir(itemId, ctx = {}) {
    const { headers, userId } = await P.auth();
    const impostoPct = Number(lerJson(path.join(STORAGE, 'config.json'), {}).imposto_pct ?? 3);
    const c = await motor.calcular(headers, userId, itemId, impostoPct);
    let s = null;
    try { s = (await ia.saude()).itens.find(i => i.item_id === itemId) || null; } catch { /* sem dados de concorrencia */ }
    const rep = lerJson(path.join(STORAGE, 'reposicao.json'), []).find(r => r.item_id === itemId) || {};
    const sete = Object.entries(rep.vendasDia || {}).filter(([d]) => Number(d) >= 1 && Number(d) <= 7).reduce((t, [, q]) => t + q, 0);
    const mcReal = ctx.mc_pct != null ? Number(ctx.mc_pct) : null;
    const margemRef = mcReal ?? c.margem_pct;

    // bronze: a decisao pela regra
    const base = { preco_atual: c.preco, margem_anuncio_pct: c.margem_pct ?? null, mc_real_pct: mcReal, custo: c.custo, frete: c.frete, tipo: c.tipo,
        vendas_periodo: ctx.unidades ?? null, periodo: ctx.periodo || 'ontem', media_dia: s?.media_dia ?? (rep.vendas30 != null ? r2(rep.vendas30 / 30) : null),
        vendas_7d: sete, vendas_30d: rep.vendas30 ?? null, estoque: rep.estoque ?? null, rank_nub: s?.rank_nub ?? null, df_lider_pct: s?.df ?? null, lider: s?.lider ?? null,
        promocao: await motor.promocaoAtiva(headers, itemId) };
    let regra = { acao: 'manter', preco: c.preco, motivo: '' };
    const rm = margemRef != null && c.margem_pct != null
        ? motor.regraMeta({ sku: rep.sku || ctx.sku, titulo: ctx.titulo || rep.titulo || '', ontem: s?.ontem ?? 0, rank_nub: s?.rank_nub ?? null, margem_pct: margemRef }) : null;
    if (rm) {
        const mt = require('./metas').metaDe(rep.sku || ctx.sku, ctx.titulo || rep.titulo || '');
        base.meta_dia = mt ? mt.meta : null; base.ontem = s?.ontem ?? 0;
        regra = rm.regra === 'SUBIR' ? { acao: 'subir', preco: (await motor.precoMaisPct(headers, c, motor.REGRA_META.SUBIR_PCT, impostoPct)).preco, motivo: rm.motivo }
            : { acao: 'manter', preco: c.preco, motivo: rm.motivo };
    }
    else if (margemRef == null || c.margem_pct == null) regra.motivo = c.custo == null ? 'Sem custo na planilha: não dá para calcular a margem.' : 'Frete ou tarifa indisponível no Mercado Livre.';
    else if (margemRef >= ALVO) regra.motivo = `MC% de ${String(margemRef).replace('.', ',')}% (≥ ${ALVO}%): tracionado, manter e defender.`;
    else {
        const alvo = await motor.precoParaMargem(headers, { ...c }, c.margem_pct + motor.REGRAS.PASSO_PONTOS, impostoPct);
        regra = { acao: 'subir', preco: alvo.preco, motivo: `MC% de ${String(margemRef).replace('.', ',')}% (< ${ALVO}%): subir +1 ponto de margem e observar 3 dias.` };
    }
    const travas = [];
    if (base.promocao) travas.push(`Está na promoção "${base.promocao}": mudar o preço tira o anúncio da campanha.`);
    if (regra.acao === 'subir' && c.preco < motor.TRAVAS.FRETE_GRATIS && regra.preco >= motor.TRAVAS.FRETE_GRATIS) travas.push(`O preço novo passaria de R$ ${motor.TRAVAS.FRETE_GRATIS}: o frete grátis vira obrigatório.`);
    if (regra.acao === 'subir' && base.df_lider_pct != null && base.df_lider_pct > motor.TRAVAS.CONCORRENTE_MAX_PCT) travas.push(`Já está ${base.df_lider_pct}% acima do líder no Nubimetrics.`);
    if (travas.length && regra.acao === 'subir') regra = { acao: 'manter', preco: c.preco, motivo: 'A regra mandaria subir, mas uma trava segurou: ' + travas.join(' ') };

    const min = r2(c.preco * (1 - LIMITE_PCT / 100)), max = r2(c.preco * (1 + LIMITE_PCT / 100));
    const resp = { fonte: 'regra', ...regra, travas, base, limites: { min, max } };
    if (margemRef == null) return resp;

    // prata: a IA revisa a decisao e explica
    const prompt = `Anúncio: ${ctx.titulo || itemId} (${itemId}, SKU ${ctx.sku || '-'})
Números: ${JSON.stringify(base)}
Venda(s) do período: ${JSON.stringify(ctx.vendas || []).slice(0, 1500)}
Decisão do motor: ${JSON.stringify(regra)}
Travas: ${travas.length ? travas.join(' | ') : 'nenhuma'}
Preço mínimo permitido: ${min} · máximo permitido: ${max}`;
    try {
        // a IA tem 40 s; se o Gemini estiver lento/sobrecarregado, fica a decisao das regras.
        // Comeca pelo 3.1-flash-lite (rapido: ~5 s em 13/10/2026; o 3.5-flash-lite estava travando).
        const g = await Promise.race([ia.gerarGemini(SISTEMA, prompt, 2048, 'gemini-3.1-flash-lite', { json: true }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('demorou mais de 40 s')), 40000))]);
        const j = JSON.parse(String(g.texto).replace(/^```(json)?|```$/g, '').trim());
        let preco = Number(j.preco);
        if (!(preco > 0)) preco = regra.preco;
        if (travas.length && preco > c.preco) preco = c.preco;               // trava vale mais que a IA
        preco = r2(Math.min(max, Math.max(min, preco)));
        const acao = Math.abs(preco - c.preco) < 0.01 ? 'manter' : preco > c.preco ? 'subir' : 'baixar';
        return { ...resp, fonte: 'ia', modelo: g.modelo, acao, preco, motivo: String(j.motivo || regra.motivo), riscos: Array.isArray(j.riscos) ? j.riscos.slice(0, 4) : [],
            confianca: j.confianca || null, regra };
    } catch (e) {
        return { ...resp, aviso_ia: 'IA indisponível agora (' + String(e.message).slice(0, 120) + '): mostrando a decisão das regras.' };
    }
}

module.exports = { sugerir };
