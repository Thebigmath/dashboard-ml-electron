// Produtos parados: têm estoque mas não vendem há N dias. Levanta, direto do
// ML, os pedidos dos últimos 90 dias (série diária por anúncio) e as visitas
// diárias dos anúncios parados, para a tela mostrar tabela + gráfico temporal
// de cada produto. Resultado fica em STORAGE/parados.json (cache) e é refeito
// pelo botão da tela ou quando tem mais de 6 h.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const TokenManager = require('./tokenManager');
const { mapaLimitado, comBackoff, paginarEmParalelo } = require('./paralelo');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ML = 'https://api.mercadolibre.com';
const DIAS_PARADO = 15;
const DIAS_HISTORICO = 90;
const CACHE_H = 6;

function lerJson(file, def) {
    const p = path.join(STORAGE, file);
    if (!fs.existsSync(p)) return def;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; }
}
const estado = { rodando: false, fase: '', ultimo_erro: null };
const tentar = (fn) => comBackoff(fn, { tentativas: 4, baseMs: 400 });
const dia = (iso) => String(iso).slice(0, 10);

async function coletar() {
    if (estado.rodando) return lerJson('parados.json', null);
    estado.rodando = true;
    try {
        const { access_token, user_id } = await TokenManager.getToken();
        const headers = { Authorization: `Bearer ${access_token}` };

        // 1. pedidos dos últimos 90 dias, em janelas de 8 dias (offset > 1000 é rejeitado)
        estado.fase = 'pedidos';
        const vendas = {}; // item_id -> { dias: {d: un}, ultima, un15, un30, un90 }
        const corte15 = new Date(Date.now() - DIAS_PARADO * 86400000).toISOString();
        const corte30 = new Date(Date.now() - 30 * 86400000).toISOString();
        for (let fim = Date.now(); fim > Date.now() - DIAS_HISTORICO * 86400000; fim -= 8 * 86400000) {
            const ini = Math.max(fim - 8 * 86400000, Date.now() - DIAS_HISTORICO * 86400000);
            const { itens } = await paginarEmParalelo({
                limite: 50, concorrencia: 8,
                buscarPagina: (offset) => axios.get(`${ML}/orders/search`, { headers, params: { seller: user_id, 'order.date_created.from': new Date(ini).toISOString(), 'order.date_created.to': new Date(fim).toISOString(), limit: 50, offset } }).then(r => r.data),
                extrair: (d) => d.results || [],
            });
            for (const o of itens) {
                if (o.status === 'cancelled') continue;
                for (const oi of o.order_items || []) {
                    const id = String((oi.item || {}).id || '').toUpperCase(); if (!id) continue;
                    const v = vendas[id] = vendas[id] || { dias: {}, ultima: '', un15: 0, un30: 0, un90: 0 };
                    const q = oi.quantity || 0, d = dia(o.date_created);
                    v.dias[d] = (v.dias[d] || 0) + q; v.un90 += q;
                    if (o.date_created >= corte30) v.un30 += q;
                    if (o.date_created >= corte15) v.un15 += q;
                    if (o.date_created > v.ultima) v.ultima = o.date_created;
                }
            }
        }

        // 2. candidatos: linhas da base com estoque > 0 e sem venda em 15 dias
        const base = lerJson('reposicao.json', []);
        const porAnuncio = {};
        for (const p of base) {
            const id = String(p.item_id || '').toUpperCase(); if (!id) continue;
            const a = porAnuncio[id] = porAnuncio[id] || { item_id: id, skus: new Set(), titulo: String(p.titulo || '').replace(/ - .*$/, ''), estoque: 0, eFull: !!p.eFull, inventory_id: p.inventory_id || null, status: p.status };
            a.skus.add(p.sku); a.estoque += Number(p.estoque) || 0;
        }
        // Empilhadeira fica de fora por enquanto (pedido do usuário): pelo título e pelo SKU.
        // "toyota" só conta como empilhadeira quando o título não é de carro.
        const carroToyota = /corolla|hilux|yaris|etios|sw4|rav4|hiace|prius|fielder/i;
        const ehEmpilhadeira = (a) => {
            const t = (a.titulo || '').toLowerCase(), s = [...a.skus].join(' ').toLowerCase();
            if (/empilhadeira|hyster|yale|bobcat|forklift|trator|clark|linde|paleteira|transpaleteira|hangcha/.test(t)) return true;
            if (/toyota/.test(t) && !carroToyota.test(t)) return true;
            return /^bf/.test(s);
        };
        const candidatos = Object.values(porAnuncio).filter(a => a.estoque > 0 && !ehEmpilhadeira(a) && !(vendas[a.item_id] && vendas[a.item_id].un15 > 0));

        // 3. preço/foto/link e visitas diárias (90 d) só dos candidatos
        estado.fase = `detalhes de ${candidatos.length} anúncios`;
        const info = {};
        const ids = candidatos.map(a => a.item_id);
        const lotes = []; for (let i = 0; i < ids.length; i += 20) lotes.push(ids.slice(i, i + 20));
        await mapaLimitado(lotes, 6, async (lote) => {
            try {
                const { data } = await tentar(() => axios.get(`${ML}/items`, { headers, params: { ids: lote.join(','), attributes: 'id,price,permalink,thumbnail,status,date_created' } }));
                for (const e of data || []) if (e.body && e.body.id) info[e.body.id] = e.body;
            } catch {}
        });
        const visitas = {};
        let feitas = 0;
        await mapaLimitado(ids, 10, async (id) => {
            try {
                const { data } = await tentar(() => axios.get(`${ML}/items/${id}/visits/time_window`, { headers, params: { last: DIAS_HISTORICO, unit: 'day' } }));
                const m = {}; for (const r of data.results || []) m[dia(r.date)] = r.total || 0;
                visitas[id] = { total: data.total_visits || 0, dias: m };
            } catch { visitas[id] = null; }
            feitas++; if (feitas % 25 === 0) estado.fase = `visitas ${feitas}/${ids.length}`;
        });

        // 4. irmãos: outro anúncio com o mesmo inventory_id que vendeu nos 15 dias
        const porInv = {};
        for (const a of Object.values(porAnuncio)) if (a.inventory_id) (porInv[a.inventory_id] = porInv[a.inventory_id] || []).push(a.item_id);

        // série semanal (13 semanas) de vendas e visitas
        const semanas = [];
        for (let i = 12; i >= 0; i--) { const fim = new Date(Date.now() - i * 7 * 86400000); const ini = new Date(fim.getTime() - 6 * 86400000); semanas.push({ ini: dia(ini.toISOString()), fim: dia(fim.toISOString()) }); }
        const somaSemana = (m, s) => { let t = 0; for (const [d, v] of Object.entries(m || {})) if (d >= s.ini && d <= s.fim) t += v; return t; };

        const corte30v = dia(new Date(Date.now() - 30 * 86400000).toISOString());
        const produtos = candidatos.map(a => {
            const it = info[a.item_id] || {}, v = vendas[a.item_id] || { dias: {}, ultima: '', un15: 0, un30: 0, un90: 0 }, vis = visitas[a.item_id];
            const vis30 = vis ? Object.entries(vis.dias).filter(([d]) => d >= corte30v).reduce((s, [, n]) => s + n, 0) : null;
            const irmaos = (a.inventory_id ? porInv[a.inventory_id] || [] : []).filter(id => id !== a.item_id);
            const irmaoVendeu = irmaos.reduce((s, id) => s + ((vendas[id] || {}).un15 || 0), 0);
            return {
                item_id: a.item_id, sku: [...a.skus].join(' / '), titulo: a.titulo, onde: a.eFull ? 'Full' : 'Fora do Full', status: it.status || a.status,
                estoque: a.estoque, preco: it.price ?? null, link: it.permalink || '', thumbnail: it.thumbnail || '', criado_em: dia(it.date_created || ''),
                ultima_venda: v.ultima ? dia(v.ultima) : null, dias_sem_venda: v.ultima ? Math.floor((Date.now() - new Date(v.ultima).getTime()) / 86400000) : null,
                un30: v.un30, un90: v.un90, visitas30: vis30, visitas90: vis ? vis.total : null,
                conversao30: vis30 ? Math.round(v.un30 / vis30 * 10000) / 100 : (vis30 === 0 ? 0 : null),
                irmao_vendeu: irmaoVendeu,
                serie: semanas.map(s => ({ ini: s.ini, fim: s.fim, vendas: somaSemana(v.dias, s), visitas: vis ? somaSemana(vis.dias, s) : null })),
            };
        }).sort((a, b) => (a.irmao_vendeu > 0) - (b.irmao_vendeu > 0) || b.estoque - a.estoque || (b.visitas30 || 0) - (a.visitas30 || 0));

        const saida = { gerado_em: new Date().toISOString(), dias_parado: DIAS_PARADO, dias_historico: DIAS_HISTORICO, total_base: Object.keys(porAnuncio).length, produtos };
        fs.writeFileSync(path.join(STORAGE, 'parados.json'), JSON.stringify(saida), 'utf8');
        estado.ultimo_erro = null;
        return saida;
    } catch (e) {
        estado.ultimo_erro = String(e.response?.data?.message || e.message || e).slice(0, 200);
        console.error('[PARADOS] ' + estado.ultimo_erro);
        throw e;
    } finally {
        estado.rodando = false; estado.fase = '';
    }
}

async function obter({ forcar = false } = {}) {
    const cache = lerJson('parados.json', null);
    const idadeH = cache ? (Date.now() - new Date(cache.gerado_em).getTime()) / 3600000 : Infinity;
    if (cache && !forcar && idadeH < CACHE_H) return { ...cache, estado: { ...estado }, do_cache: true };
    if (estado.rodando && cache) return { ...cache, estado: { ...estado }, do_cache: true };
    const novo = await coletar();
    return { ...novo, estado: { ...estado }, do_cache: false };
}

module.exports = { obter, coletar, estado };
