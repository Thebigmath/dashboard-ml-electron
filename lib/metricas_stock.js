// Metricas do STOCK Ops (pedido do usuario em 19/10/2026): quanto dinheiro esta no Full, quanto esta parado e quanto
// perdemos com produto quebrado. Os tres a preco de CUSTO (planilha de custos, a mesma busca do Precificar), da conta
// deste Dashboard. A analise e do agente Orquestrador do STOCK Ops (Complexo de IA).
//   Full ....... reposicao.json, anuncios no Full: custo x estoque (inclui unidades em transferencia, como o Painel)
//   Parado ..... mesmo criterio do Controle de estoque parado: ativo, no Full, sem empilhadeira, estoque que dura
//                60+ dias no ritmo de 30 dias (ou sem venda): custo x estoque
//   Quebrados .. reclamacoes de produto quebrado (API do ML, motivos broken_item / damaged_package_broken_item) que
//                PERDEMOS (comprador ganhou): custo x qtd + frete pago pelo vendedor, sem descontar reembolso do ML.
//                As abertas aparecem a parte, como prejuizo possivel.
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const STORAGE = () => process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
const gravar = (nome, v) => fs.writeFileSync(path.join(STORAGE(), nome), JSON.stringify(v), 'utf8');
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const B = 'https://api.mercadolibre.com';
const dormir = (ms) => new Promise(r => setTimeout(r, ms));
const EMPILHADEIRA = ['empilhadeira', 'hyster', 'yale', 'bobcat', 'forklift', 'trator'];
function categoria(titulo, sku) {
    const t = String(titulo || '').toLowerCase(), s = String(sku || '').toLowerCase();
    if (EMPILHADEIRA.some(k => t.includes(k)) || s.startsWith('bf')) return 'Empilhadeira';
    if (t.includes('tapete')) return 'Tapetes';
    if (t.includes('lanterna')) return 'Lanternas';
    if (t.includes('retrovisor')) return 'Retrovisores';
    if (t.includes('farol')) return 'Faróis';
    if (t.includes('calota')) return 'Calotas';
    return 'Outros';
}
// custo absurdo (R$ 20.000 ou mais, ou mais de 10x o preco de venda) quase sempre e virgula perdida na planilha (901290836 = 132036 em vez de 2261,07):
// fica FORA da soma e aparece em separado, em vez de inflar o valor de estoque em silencio
const custoSuspeito = (c, preco) => c != null && (c >= 20000 || (Number(preco) > 0 && c > Number(preco) * 10));
const custoUnit = (sku) => { const c = require('./precificador').custoDoSku(sku); return c ? c.valor : null; };
function porCategoria(L, campo) {
    const o = {};
    for (const x of L) { const k = x.categoria; const g = (o[k] ||= { categoria: k, itens: 0, unidades: 0, valor: 0 }); g.itens++; g.unidades += x.estoque || x.qtd || 0; g.valor = r2(g.valor + (x[campo] || 0)); }
    return Object.values(o).sort((a, b) => b.valor - a.valor);
}

// ---- 1) valor de estoque no Full ----
function valorFull() {
    const rep = lerJson(path.join(STORAGE(), 'reposicao.json'), []).filter(p => p.eFull && Number(p.estoque) > 0);
    const L = rep.map(p => { const c0 = custoUnit(p.sku), susp = custoSuspeito(c0, p.preco), c = susp ? null : c0; const est = Number(p.estoque) || 0;
        return { sku: p.sku, titulo: p.titulo, estoque: est, custo_unit: c, valor: c == null ? 0 : r2(c * est), venda: r2((Number(p.preco) || 0) * est), sem_custo: c == null && !susp, suspeito: susp, custo_suspeito: susp ? c0 : null, preco: Number(p.preco) || 0, categoria: categoria(p.titulo, p.sku), vendas30: Number(p.vendas30) || 0 }; });
    const com = L.filter(x => !x.sem_custo && !x.suspeito);
    return { valor: r2(com.reduce((s, x) => s + x.valor, 0)), valor_venda: r2(L.reduce((s, x) => s + x.venda, 0)), skus: L.length, unidades: L.reduce((s, x) => s + x.estoque, 0),
        sem_custo: L.filter(x => x.sem_custo).length, unidades_sem_custo: L.filter(x => x.sem_custo).reduce((s, x) => s + x.estoque, 0),
        suspeitos: L.filter(x => x.suspeito).map(x => ({ sku: x.sku, titulo: x.titulo, estoque: x.estoque, custo_unit: x.custo_suspeito, preco: x.preco })),
        por_categoria: porCategoria(com, 'valor'), top: [...com].sort((a, b) => b.valor - a.valor).slice(0, 12),
        coletado_em: (() => { try { return fs.statSync(path.join(STORAGE(), 'reposicao.json')).mtime.toISOString(); } catch { return null; } })() };
}

// ---- 2) valor parado (a custo) ----
function valorParado(minDias = 60) {
    const rep = lerJson(path.join(STORAGE(), 'reposicao.json'), []);
    const L = rep.filter(p => p.item_id && p.status === 'active' && p.eFull && Number(p.estoque) > 0 && categoria(p.titulo, p.sku) !== 'Empilhadeira')
        .map(p => { const v30 = Number(p.vendas30) || 0, est = Number(p.estoque) || 0; const dias = v30 > 0 ? Math.round(est / (v30 / 30)) : null; const c0 = custoUnit(p.sku), susp = custoSuspeito(c0, p.preco), c = susp ? null : c0;
            return { sku: p.sku, titulo: p.titulo, estoque: est, vendas30: v30, dias, custo_unit: c, valor: c == null ? 0 : r2(c * est), sem_custo: c == null && !susp, suspeito: susp, categoria: categoria(p.titulo, p.sku) }; })
        .filter(x => x.dias == null || x.dias >= minDias);
    const com = L.filter(x => !x.sem_custo && !x.suspeito);
    return { min_dias: minDias, suspeitos: L.filter(x => x.suspeito).length, valor: r2(com.reduce((s, x) => s + x.valor, 0)), skus: L.length, unidades: L.reduce((s, x) => s + x.estoque, 0), sem_venda: L.filter(x => x.dias == null).length,
        valor_sem_venda: r2(com.filter(x => x.dias == null).reduce((s, x) => s + x.valor, 0)), sem_custo: L.filter(x => x.sem_custo).length,
        por_categoria: porCategoria(com, 'valor'), top: [...com].sort((a, b) => b.valor - a.valor).slice(0, 12) };
}

// ---- 3) quebrados que perdemos (API do ML, em segundo plano, guardado) ----
const QUEBRA = { broken_item: 'caixa intacta', broken_item_fashion: 'caixa intacta', damaged_package_broken_item: 'caixa danificada' };
const estQ = { rodando: false, etapa: null, erro: null };
async function get(h, url, params) {
    for (let t = 0; t < 4; t++) {
        try { return (await axios.get(url, { headers: h, params, timeout: 20000 })).data; }
        catch (e) { const s = e.response && e.response.status; if (s === 429 || !s || s >= 500) { await dormir(2000 * (t + 1)); continue; } throw e; }
    }
    throw new Error('o Mercado Livre não respondeu');
}
function coletarQuebrados() {
    if (estQ.rodando) return { ok: false, erro: 'Já está consultando.' };
    Object.assign(estQ, { rodando: true, etapa: 'lendo as reclamações', erro: null });
    (async () => {
        try {
            const tk = await require('./tokenManager').getToken();
            const h = { Authorization: 'Bearer ' + tk.access_token };
            const agora = new Date(Date.now() - 3 * 3600000);
            const desde = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth() - 1, 1, 3)).getTime();   // dia 1 do mes passado
            const motivos = {}, linhas = [];
            for (const status of ['opened', 'closed']) {
                for (let off = 0; off < 5000; off += 50) {
                    const s = await get(h, `${B}/post-purchase/v1/claims/search`, { 'players.role': 'respondent', 'players.user_id': tk.user_id, status, limit: 50, offset: off, sort: 'date_created:desc' });
                    const lote = (s && s.data) || []; if (!lote.length) break;
                    for (const x of lote) {
                        if (new Date(x.date_created).getTime() < desde || x.resource !== 'order') continue;
                        if (!(x.reason_id in motivos)) { const r = await get(h, `${B}/post-purchase/v1/claims/reasons/${x.reason_id}`).catch(() => null); motivos[x.reason_id] = (r && r.name) || ''; }
                        const tipo = QUEBRA[motivos[x.reason_id]]; if (!tipo) continue;
                        const ganhou = (x.resolution && x.resolution.benefited) || [];
                        const sit = x.status !== 'closed' ? 'aberta' : ganhou.includes('complainant') ? 'perdemos' : 'ganhamos';
                        if (sit === 'ganhamos') { linhas.push({ data: x.date_created.slice(0, 10), situacao: sit, tipo }); continue; }
                        estQ.etapa = `conferindo pedido ${x.resource_id}`;
                        const o = await get(h, `${B}/orders/${x.resource_id}`).catch(() => null); if (!o) continue;
                        const it = o.order_items[0]; const sku = it.item.seller_sku || it.item.seller_custom_field;
                        let frete = null;
                        if (o.shipping && o.shipping.id) { const k = await get(h, `${B}/shipments/${o.shipping.id}/costs`).catch(() => null); frete = k && k.senders ? r2(k.senders.reduce((a, z) => a + (z.cost || 0), 0)) : null; }
                        const c = custoUnit(sku), custo = c == null ? null : r2(c * it.quantity);
                        linhas.push({ data: x.date_created.slice(0, 10), situacao: sit, tipo, sku, produto: it.item.title, qtd: it.quantity, custo, frete, total: r2((custo || 0) + (frete || 0)), categoria: categoria(it.item.title, sku), pedido: x.resource_id });
                    }
                    if (new Date(lote[lote.length - 1].date_created).getTime() < desde) break;
                }
            }
            gravar('metricas_quebrados.json', { em: new Date().toISOString(), desde: new Date(desde).toISOString().slice(0, 10), linhas });
        } catch (e) { estQ.erro = e.response ? `ML ${e.response.status}` : e.message; }
        finally { estQ.rodando = false; estQ.etapa = null; }
    })();
    return { ok: true };
}
function quebrados() {
    const d = lerJson(path.join(STORAGE(), 'metricas_quebrados.json'), null);
    if (!d) return { em: null, estado: { ...estQ } };
    const perd = d.linhas.filter(x => x.situacao === 'perdemos'), ab = d.linhas.filter(x => x.situacao === 'aberta');
    const mes = (x) => x.data.slice(0, 7);
    const meses = [...new Set(d.linhas.map(mes))].sort().map(m => { const P = perd.filter(x => mes(x) === m);
        return { mes: m, quebras: d.linhas.filter(x => mes(x) === m).length, perdidas: P.length, custo: r2(P.reduce((s, x) => s + (x.custo || 0), 0)), frete: r2(P.reduce((s, x) => s + (x.frete || 0), 0)), valor: r2(P.reduce((s, x) => s + x.total, 0)) }; });
    const prod = {};
    for (const x of perd) { const p = (prod[x.sku] ||= { sku: x.sku, produto: x.produto, categoria: x.categoria, perdidas: 0, valor: 0 }); p.perdidas++; p.valor = r2(p.valor + x.total); }
    return { em: d.em, desde: d.desde, estado: { ...estQ }, quebras: d.linhas.length, perdidas: perd.length, ganhamos: d.linhas.filter(x => x.situacao === 'ganhamos').length, abertas: ab.length,
        custo: r2(perd.reduce((s, x) => s + (x.custo || 0), 0)), frete: r2(perd.reduce((s, x) => s + (x.frete || 0), 0)), valor: r2(perd.reduce((s, x) => s + x.total, 0)),
        valor_possivel: r2(ab.reduce((s, x) => s + x.total, 0)), caixa_intacta: d.linhas.filter(x => x.tipo === 'caixa intacta').length, sem_custo: perd.filter(x => x.custo == null).length,
        meses, por_categoria: porCategoria(perd.map(x => ({ ...x, estoque: x.qtd })), 'total'), produtos: Object.values(prod).sort((a, b) => b.valor - a.valor).slice(0, 12),
        perdidas_lista: perd.sort((a, b) => b.data.localeCompare(a.data)), abertas_lista: ab };
}

// ---- tudo junto + analise do agente Orquestrador do STOCK Ops ----
function resumo() {
    return { full: valorFull(), parado: valorParado(60), quebrados: quebrados(), ia: lerJson(path.join(STORAGE(), 'metricas_stock_ia.json'), null), ia_estado: { ...estIA } };
}
const estIA = { rodando: false, erro: null };
function analisar() {
    if (estIA.rodando) return { ok: false, erro: 'A análise já está rodando.' };
    Object.assign(estIA, { rodando: true, erro: null });
    (async () => {
        try {
            const f = valorFull(), p = valorParado(60), q = quebrados();
            const dados = {
                estoque_full: { valor_custo: f.valor, valor_venda: f.valor_venda, skus: f.skus, unidades: f.unidades, skus_sem_custo: f.sem_custo, por_categoria: f.por_categoria, maiores: f.top.slice(0, 6).map(x => ({ sku: x.sku, valor: x.valor, unidades: x.estoque, vendas30: x.vendas30 })) },
                parado_60_dias: { valor_custo: p.valor, skus: p.skus, unidades: p.unidades, sem_venda_30d: p.sem_venda, valor_sem_venda: p.valor_sem_venda, por_categoria: p.por_categoria, maiores: p.top.slice(0, 6).map(x => ({ sku: x.sku, valor: x.valor, dias_de_estoque: x.dias, vendas30: x.vendas30 })) },
                quebrados_perdidos: q.em ? { desde: q.desde, valor_custo_mais_frete: q.valor, perdidas: q.perdidas, ganhamos: q.ganhamos, abertas: q.abertas, valor_possivel_abertas: q.valor_possivel, caixa_intacta: q.caixa_intacta, por_mes: q.meses, por_categoria: q.por_categoria, piores: q.produtos.slice(0, 6) } : 'ainda não consultado',
            };
            const sistema = 'Você é o Orquestrador da área STOCK Ops de uma loja de autopeças no Mercado Livre (lanternas, tapetes, retrovisores, peças de empilhadeira). '
                + 'Recebe números JÁ CALCULADOS a preço de custo. "Quebrados" são SÓ produtos que chegaram quebrados e cuja reclamação perdemos (não inclui extravio nem outros motivos). Nunca invente número. Português do Brasil, direto, com valores em R$. Responda SÓ com o JSON pedido.';
            const prompt = `NÚMEROS (JSON):\n${JSON.stringify(dados)}\n\nResponda com este JSON exato:\n{"resumo":"3 a 4 linhas com o quadro geral e os valores","estoque":"1 a 2 linhas sobre o valor no Full e onde está concentrado","parado":"1 a 2 linhas sobre o dinheiro parado e o que mais pesa","quebrados":"1 a 2 linhas sobre o prejuízo com quebra e a tendência","alertas":["até 4 alertas curtos com número"],"acoes":["até 5 ações práticas e específicas (SKU/categoria), em ordem de impacto"]}`;
            const ia = require('./ia');
            const g = await Promise.race([ia.gerarGemini(sistema, prompt, 2048, 'gemini-3.1-flash-lite', { json: true, area: 'stock_ops', agente: 'stock_orquestrador', tarefa: 'Métricas do STOCK Ops: estoque, parados e quebrados' }),
                new Promise((_, rej) => setTimeout(() => rej(new Error('a IA demorou mais de 60 s')), 60000))]);
            const j = JSON.parse(String(g.texto).replace(/^```(json)?|```$/g, '').trim());
            gravar('metricas_stock_ia.json', { em: new Date().toISOString(), agente: g.agente || null, modelo: g.modelo, ...j });
        } catch (e) { estIA.erro = e.message; }
        finally { estIA.rodando = false; }
    })();
    return { ok: true };
}

module.exports = { resumo, valorFull, valorParado, quebrados, coletarQuebrados, analisar };
