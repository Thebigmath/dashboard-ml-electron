// Simulacao de precos da Analise de vendas (pedido do usuario em 16/10/2026).
// A IA analisa TODOS os anuncios que venderam no periodo (a mesma analise do botao Precificar, anuncio por anuncio),
// monta a simulacao com o preco que ela sugere e a margem nova, e entrega pronta: o usuario so APROVA ou REJEITA.
// Nada muda no Mercado Livre sem a aprovacao. Roda pelo botao "Simular com a IA" e sozinha todo dia de manha
// (vendas de ontem), com aviso do Windows quando fica pronta.
const fs = require('fs');
const path = require('path');
const P = require('./precificador');

const STORAGE = () => process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ARQ = () => path.join(STORAGE(), 'simulacao_precos.json');
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
const gravar = (v) => fs.writeFileSync(ARQ(), JSON.stringify(v), 'utf8');
const hojeBR = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);

const estado = { rodando: false, feitos: 0, total: 0, periodo: null, erro: null };

function simular(periodo = 'ontem') {
    if (estado.rodando) return { ok: false, erro: 'A simulação já está rodando.' };
    Object.assign(estado, { rodando: true, feitos: 0, total: 0, periodo, erro: null });
    (async () => {
        try {
            const d = await require('./vendas_mc').analisar({ periodo });
            const alt = d.alterados || {};
            // anuncio com preco mudado nos ultimos 3 dias esta em observacao: fica fora (como na lista)
            const alvos = d.anuncios.filter(a => !alt[a.item_id]);
            estado.total = alvos.length;
            const itens = [];
            for (const a of alvos) {
                const vs = d.vendas.filter(v => v.item_id === a.item_id);
                const ctx = { periodo: d.periodo, titulo: a.titulo, sku: a.sku, unidades: a.unidades, mc_pct: a.mc_pct,
                    vendas: vs.map(v => ({ data: v.data, valor: v.valor, qtd: v.qtd, cupom: v.cupom, custo: v.custo, tarifa: v.tarifa, frete_vendedor: v.frete_vendedor, mc: v.mc, mc_pct: v.mc_pct, logistica: v.logistica })) };
                const it = { item_id: a.item_id, titulo: a.titulo, sku: a.sku, unidades: a.unidades, mc_pct: a.mc_pct, status: 'pendente' };
                try {
                    const s = await require('./preco_ia').sugerir(a.item_id, ctx);
                    Object.assign(it, { acao: s.acao, preco_atual: s.base ? s.base.preco_atual : null, preco_sugerido: s.preco, motivo: s.motivo || '', travas: s.travas || [],
                        riscos: s.riscos || [], confianca: s.confianca || null, fonte: s.fonte, agente: s.agente || null, aviso_ia: s.aviso_ia || null, margem_atual: s.base ? s.base.margem_anuncio_pct : null, erro: s.erro || null });
                    if (s.acao === 'subir' && s.preco) {
                        // margem do anuncio no preco sugerido (a mesma conta do precificador)
                        try { const x = await P.dados(a.item_id, s.preco); const col = x.colunas[x.tipo_atual]; it.margem_nova = col ? col.margem_pct : null; } catch {}
                    } else it.status = 'manter';
                } catch (e) { it.acao = 'erro'; it.erro = String(e.message).slice(0, 160); it.status = 'erro'; }
                itens.push(it);
                estado.feitos++;
                if (estado.feitos % 5 === 0) gravar({ periodo, de: d.de, ate: d.ate, em: new Date().toISOString(), parcial: true, itens });
            }
            const sim = { periodo, de: d.de, ate: d.ate, em: new Date().toISOString(), dia: hojeBR(), parcial: false, itens };
            gravar(sim);
            const n = itens.filter(i => i.status === 'pendente').length;
            try { require('./notificar').notificar('Simulação de preços pronta', `${n} sugestão(ões) da IA para aprovar ou rejeitar (${itens.length} anúncios analisados).`, '/seven#vendasmc'); } catch {}
        } catch (e) { estado.erro = e.message; }
        finally { estado.rodando = false; }
    })();
    return { ok: true };
}

// vendas dos concorrentes (Nubimetrics via Astra) para o card da sugestao: o lider do grupo e a soma dos rivais, em 7 e 30 dias.
// Lido na hora, do arquivo do Astra (6 ms por anuncio); anuncio fora do Nubimetrics fica sem o bloco.
function concorrencia(itemId) {
    try {
        const S = require('./seven'), c = S.concorrenciaDoAnuncio(itemId);
        if (!c) return null;
        const rivais = (c.ranking || []).filter(r => !r.nosso && !r.outra_conta);
        const soma = (k) => rivais.some(r => r[k] != null) ? rivais.reduce((s, r) => s + (Number(r[k]) || 0), 0) : null;
        const rit = c.lider ? S.ritmoConcorrente(c.lider) : {};
        return { lider: c.lider ? c.lider.vendedor : null, lider_v7: rit.v7 ?? null, lider_v30: rit.v30 ?? null, ritmo_pct: rit.ritmo_pct ?? null,
            rivais: rivais.length, rivais_v7: soma('vendas'), rivais_v30: soma('vendas_30'), posicao: c.posicao, grupo_anuncios: c.anuncios, dados_de: c.dados_de || null, dados_30_de: c.dados_30_de || null };
    } catch { return null; }
}

function resultado() {
    const s = lerJson(ARQ(), { itens: [] });
    for (const it of s.itens || []) if (it.status === 'pendente') it.concorrencia = concorrencia(it.item_id);
    return { ...s, estado: { ...estado } };
}

async function decidir(itemId, aprovar) {
    const sim = lerJson(ARQ(), null);
    if (!sim) throw new Error('Não há simulação.');
    const it = sim.itens.find(i => i.item_id === itemId);
    if (!it) throw new Error('Anúncio fora da simulação.');
    if (it.status !== 'pendente') return { ok: false, erro: `Já está ${it.status}.` };
    if (!aprovar) { it.status = 'rejeitado'; it.decidido_em = new Date().toISOString(); gravar(sim); return { ok: true, status: it.status }; }
    // aprovado: aplica o preco sugerido (a IA nunca passa de +3%; a aprovacao do usuario vale como confirmacao)
    const r = await P.aplicar(itemId, it.preco_sugerido, { confirmarGrande: true, origem: 'simulacao-ia', motivo: 'Simulação da IA aprovada: ' + String(it.motivo || '').slice(0, 160) });
    const atual = lerJson(ARQ(), sim);
    const x = atual.itens.find(i => i.item_id === itemId);
    if (r.ok) Object.assign(x, { status: 'aprovado', decidido_em: new Date().toISOString(), antes: r.antes, depois: r.depois });
    else x.erro_aplicar = r.erro || 'não aplicou';
    gravar(atual);
    return { ...r, status: x.status };
}

// todo dia, a partir das 8h, uma simulacao das vendas de ontem (se ainda nao houver uma de hoje)
let timer = null;
function iniciarAgendador() {
    if (timer) return;
    const checar = () => {
        const h = Number(new Date(Date.now() - 3 * 3600000).toISOString().slice(11, 13));
        const s = lerJson(ARQ(), {});
        if (h >= 8 && s.dia !== hojeBR() && !estado.rodando) simular('ontem');
    };
    setTimeout(checar, 5 * 60 * 1000);
    timer = setInterval(checar, 30 * 60 * 1000);
}
function pararAgendador() { if (timer) clearInterval(timer); timer = null; }

module.exports = { simular, resultado, decidir, iniciarAgendador, pararAgendador };
