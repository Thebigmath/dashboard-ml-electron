// Defesa (AD HEALTH > card Defesa > aba "Defender"), 13/10/2026: produto com margem de 15% ou mais ja esta
// "conquistado" — o trabalho deixa de ser subir preco e passa a ser DEFENDER a posicao. Aqui ficam todos os
// anuncios com margem >= 15% que vendem com frequencia, com as ameacas de cada um:
//   concorrente .. o lider do Nubimetrics esta mais de 5% mais barato que nos
//   posicao ...... nao esta em 1o no grupo do Nubimetrics
//   busca ........ fora da pagina 1 do Ranking ML (ou nao achado)
//   vendas ....... media dos ultimos 7 dias abaixo de 60% da media de 30 dias
//   estoque ...... cobertura no Full abaixo de ESTOQUE_MIN_DIAS
// Status: protegido (sem ameaca); ameacado = vendas caindo + concorrente/posicao, estoque < 7 dias ou lider > 15% mais barato; atencao = o resto.
const fs = require('fs');
const path = require('path');
const ia = require('./ia');
const P = require('./precificador');
const M = require('./motor_preco');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const CACHE = path.join(STORAGE, 'defesa.json');
const VALIDADE_MS = 30 * 60 * 1000;
const LIMITES = { MARGEM_MIN: 15, MEDIA_DIA_MIN: 0.3, ESTOQUE_MIN_DIAS: 15, ESTOQUE_CRITICO_DIAS: 7, QUEDA_7D: 0.6, CONCORRENTE_PCT: 5, CONCORRENTE_GRAVE_PCT: 15 };
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };

function ameacas(i, l, rep, promo, ads) {
    const a = [];
    if (i.df != null && i.df > LIMITES.CONCORRENTE_PCT) a.push({ id: 'concorrente', txt: `O líder${i.lider ? ` (${i.lider})` : ''} está ${String(i.df).replace('.', ',')}% mais barato que nós.`, acao: 'Acompanhar o preço do líder; se as vendas caírem, considerar promoção ou ADS em vez de baixar o preço.' });
    if (i.rank_nub && i.rank_nub > 1) a.push({ id: 'posicao', txt: `${i.rank_nub}º de ${i.grupo_anuncios} no grupo do Nubimetrics.`, acao: 'Reforçar com ADS ou promoção subsidiada para voltar ao 1º.' });
    if (i.rank_ml && i.rank_ml.pagina > 1) a.push({ id: 'busca', txt: `Na página ${i.rank_ml.pagina} da busca (posição ${i.rank_ml.posicao}).`, acao: 'Revisar título e fotos; ADS no termo principal.' });
    // vendas caindo: media dos ultimos 7 dias completos contra a media de 30 dias (um dia fraco isolado nao conta)
    const vd = (rep && rep.vendasDia) || {};
    const m30 = (Number(rep && rep.vendas30) || 0) / 30;
    const m7 = [1, 2, 3, 4, 5, 6, 7].reduce((t, k) => t + (Number(vd[k]) || 0), 0) / 7;
    if (m30 >= 0.5 && m7 < m30 * LIMITES.QUEDA_7D) a.push({ id: 'vendas', txt: `Últimos 7 dias: ${m7.toFixed(2).replace('.', ',')}/dia; média de 30 dias: ${m30.toFixed(2).replace('.', ',')}/dia.`, acao: 'Conferir se o anúncio está ativo, com estoque e sem concorrente novo mais barato.' });
    if (rep && rep.eFull && rep.cobertura != null && rep.cobertura < LIMITES.ESTOQUE_MIN_DIAS) a.push({ id: 'estoque', txt: `Estoque no Full para ${rep.cobertura} dia(s) (${rep.estoque} un).`, acao: 'Programar envio para o Full: sem estoque, perde a posição.' });
    return a;
}

async function avaliar({ forcar = false } = {}) {
    const c = lerJson(CACHE, null);
    if (!forcar && c && Date.now() - new Date(c.atualizado_em).getTime() < VALIDADE_MS) return c;
    const s = await ia.saude();
    const { headers, userId } = await P.auth();
    const impostoPct = Number(lerJson(path.join(STORAGE, 'config.json'), {}).imposto_pct ?? 7);
    const coleta = new Map(lerJson(path.join(STORAGE, 'reposicao.json'), []).map(r => [r.item_id, r]));
    const adsMapa = (lerJson(path.join(STORAGE, 'parado_ads.json'), {}).mapa) || {};
    const alvo = s.itens.filter(i => i.status === 'active' && ((i.media_dia || 0) >= LIMITES.MEDIA_DIA_MIN || i.ontem >= 2));
    const itens = [];
    for (const i of alvo) {
        let l;
        try { l = await M.calcular(headers, userId, i.item_id, impostoPct); } catch { continue; }
        if (l.margem_pct == null || l.margem_pct < LIMITES.MARGEM_MIN) continue;
        const rep = coleta.get(i.item_id) || {};
        const promo = await M.promocaoAtiva(headers, i.item_id);
        const am = ameacas(i, l, rep, promo, adsMapa[i.item_id]);
        // ameacado = risco real: vendas caindo junto com concorrente/posicao, estoque critico ou lider muito mais barato
        const tem = (id) => am.some(x => x.id === id);
        const grave = (tem('vendas') && (tem('concorrente') || tem('posicao')))
            || (rep.eFull && rep.cobertura != null && rep.cobertura < LIMITES.ESTOQUE_CRITICO_DIAS)
            || (i.df != null && i.df > LIMITES.CONCORRENTE_GRAVE_PCT);
        const status = !am.length ? 'protegido' : grave ? 'ameacado' : 'atencao';
        itens.push({ item_id: i.item_id, sku: i.sku, titulo: i.titulo, curva: i.curva, ontem: i.ontem, media_dia: i.media_dia, vendas_mes: i.vendas_mes,
            preco: l.preco, margem_pct: l.margem_pct, rank_nub: i.rank_nub, grupo_anuncios: i.grupo_anuncios, lider: i.lider, df: i.df,
            rank_ml: i.rank_ml ? `${i.rank_ml.posicao}º · pág. ${i.rank_ml.pagina}` : null,
            estoque: rep.estoque ?? null, cobertura: rep.cobertura ?? null, full: !!rep.eFull,
            promocao: promo, ads: adsMapa[i.item_id] || null, ameacas: am, status });
    }
    const ordem = { ameacado: 0, atencao: 1, protegido: 2 };
    itens.sort((a, b) => ordem[a.status] - ordem[b.status] || (b.media_dia || 0) - (a.media_dia || 0));
    const r = { atualizado_em: new Date().toISOString(), limites: LIMITES, itens,
        resumo: { total: itens.length, ameacado: itens.filter(x => x.status === 'ameacado').length, atencao: itens.filter(x => x.status === 'atencao').length, protegido: itens.filter(x => x.status === 'protegido').length } };
    fs.mkdirSync(STORAGE, { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(r), 'utf8');
    return r;
}

module.exports = { avaliar, LIMITES };
