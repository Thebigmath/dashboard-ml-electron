// Monitor Premium x Classico (regra do usuario, 13/10/2026): para o MESMO produto, a margem do anuncio
// Premium (gold_pro) tem que ser SEMPRE maior que a do Classico (gold_special).
//   pares ....... anuncios ativos com o mesmo SKU, um Classico e um Premium (com SKU repetido em carros diferentes,
//                 ex. 035TB Argo/Cronos, o par e escolhido pelo titulo mais parecido)
//   margem ...... a mesma conta do precificador (preco - tarifa - custo - imposto - frete) de cada anuncio no seu tipo
//   sugestao .... preco do Premium para ficar 1 ponto acima da margem do Classico
// Resultado guardado 1 h (premium_monitor.json); "checar(item)" refaz so o par de um anuncio (usado depois de mudar preco).
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const P = require('./precificador');
const motor = require('./motor_preco');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const CACHE = path.join(STORAGE, 'premium_monitor.json');
const ML = 'https://api.mercadolibre.com';
const VALIDADE_MS = 60 * 60 * 1000;
const PONTOS_ACIMA = 1;
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const palavras = (t) => new Set(semAcento(t).split(/[^a-z0-9]+/).filter(w => w.length > 2));
const parecido = (a, b) => { const A = palavras(a), B = palavras(b); let n = 0; for (const w of A) if (B.has(w)) n++; return n; };
async function limitado(lista, n, fn) { let k = 0; await Promise.all(Array.from({ length: n }, async () => { while (k < lista.length) { const x = lista[k++]; await fn(x); } })); }
async function get(url, headers, params) {
    for (let t = 1; ; t++) {
        try { return (await axios.get(url, { headers, params, timeout: 30000 })).data; }
        catch (e) { const st = e.response?.status; if ((st === 429 || st >= 500 || !e.response) && t < 5) { await new Promise(r => setTimeout(r, 1500 * t)); continue; } throw e; }
    }
}
const skuDe = (it) => (it.seller_custom_field || ((it.attributes || []).find(a => a.id === 'SELLER_SKU') || {}).value_name || '').trim();

// anuncios ativos da conta -> pares Classico/Premium do mesmo SKU
async function montarPares(headers, userId) {
    // todos os anuncios ativos da conta (a coleta de estoque nao tem todos os Premium)
    const ids = [];
    let scroll = null;
    for (let i = 0; i < 200; i++) {
        const d = await get(`${ML}/users/${userId}/items/search`, headers, { status: 'active', search_type: 'scan', limit: 100, ...(scroll ? { scroll_id: scroll } : {}) });
        ids.push(...(d.results || [])); scroll = d.scroll_id;
        if (!(d.results || []).length) break;
    }
    const itens = [];
    for (let i = 0; i < ids.length; i += 20) {
        const lote = await get(`${ML}/items`, headers, { ids: ids.slice(i, i + 20).join(','), attributes: 'id,title,price,listing_type_id,status,seller_custom_field,attributes,variations' });
        for (const r of lote || []) if (r.code === 200 && r.body && r.body.status === 'active' && !(r.body.variations || []).length) itens.push(r.body);
    }
    const grupos = {};
    for (const it of itens) { const s = skuDe(it).toLowerCase(); if (s && ['gold_special', 'gold_pro'].includes(it.listing_type_id)) (grupos[s] ||= []).push(it); }
    const pares = [];
    for (const [sku, L] of Object.entries(grupos)) {
        const cls = L.filter(x => x.listing_type_id === 'gold_special'), pro = L.filter(x => x.listing_type_id === 'gold_pro');
        const usados = new Set();
        for (const p of pro) {
            const c = cls.filter(x => !usados.has(x.id)).sort((a, b) => parecido(b.title, p.title) - parecido(a.title, p.title))[0];
            if (!c) continue;
            usados.add(c.id);
            pares.push({ sku: skuDe(p), titulo: p.title, classico: c.id, premium: p.id });
        }
    }
    return pares;
}

async function avaliarPar(headers, userId, impostoPct, par) {
    const [c, p] = await Promise.all([motor.calcular(headers, userId, par.classico, impostoPct), motor.calcular(headers, userId, par.premium, impostoPct)]);
    const r = { ...par, classico: { item_id: par.classico, preco: c.preco, margem: c.margem ?? null, margem_pct: c.margem_pct ?? null },
        premium: { item_id: par.premium, preco: p.preco, margem: p.margem ?? null, margem_pct: p.margem_pct ?? null } };
    if (c.margem_pct == null || p.margem_pct == null) { r.status = 'sem_dados'; r.motivo = c.custo == null ? 'Sem custo na planilha.' : 'Frete ou tarifa indisponível.'; return r; }
    if (p.margem_pct > c.margem_pct) { r.status = 'ok'; return r; }
    r.status = 'subir';
    try { const s = await motor.precoParaMargem(headers, { ...p }, c.margem_pct + PONTOS_ACIMA, impostoPct); r.sugestao = { preco: s.preco, margem_pct: s.margem_pct, aumento_pct: Math.round((s.preco / p.preco - 1) * 1000) / 10 }; } catch {}
    r.motivo = `A margem do Premium (${String(p.margem_pct).replace('.', ',')}%) está ${p.margem_pct === c.margem_pct ? 'igual à' : 'menor que a'} do Clássico (${String(c.margem_pct).replace('.', ',')}%).`;
    return r;
}

async function monitor({ forcar = false } = {}) {
    const cache = lerJson(CACHE, null);
    if (!forcar && cache && Date.now() - new Date(cache.atualizado_em).getTime() < VALIDADE_MS) return cache;
    const { headers, userId } = await P.auth();
    const impostoPct = Number(lerJson(path.join(STORAGE, 'config.json'), {}).imposto_pct ?? 3);
    const pares = await montarPares(headers, userId);
    const out = [];
    await limitado(pares, 4, async (par) => { try { out.push(await avaliarPar(headers, userId, impostoPct, par)); } catch (e) { out.push({ ...par, status: 'sem_dados', motivo: e.message }); } });
    const ordem = { subir: 0, sem_dados: 1, ok: 2 };
    out.sort((a, b) => ordem[a.status] - ordem[b.status] || ((a.premium.margem_pct ?? 0) - (a.classico.margem_pct ?? 0)) - ((b.premium.margem_pct ?? 0) - (b.classico.margem_pct ?? 0)));
    const r = { atualizado_em: new Date().toISOString(), pontos_acima: PONTOS_ACIMA, total: out.length,
        subir: out.filter(x => x.status === 'subir').length, ok: out.filter(x => x.status === 'ok').length, sem_dados: out.filter(x => x.status === 'sem_dados').length, pares: out };
    fs.mkdirSync(STORAGE, { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(r), 'utf8');
    return r;
}

// Depois de mudar o preco de um anuncio: refaz o par dele e atualiza o monitor
async function checar(itemId) {
    let cache = lerJson(CACHE, null);
    if (!cache) cache = await monitor();
    const par = cache.pares.find(x => x.classico.item_id === itemId || x.premium.item_id === itemId);
    if (!par) return { tem_par: false };
    const { headers, userId } = await P.auth();
    const impostoPct = Number(lerJson(path.join(STORAGE, 'config.json'), {}).imposto_pct ?? 3);
    const novo = await avaliarPar(headers, userId, impostoPct, { sku: par.sku, titulo: par.titulo, classico: par.classico.item_id, premium: par.premium.item_id });
    cache.pares = cache.pares.map(x => x.premium.item_id === novo.premium.item_id ? novo : x);
    cache.subir = cache.pares.filter(x => x.status === 'subir').length; cache.ok = cache.pares.filter(x => x.status === 'ok').length;
    fs.writeFileSync(CACHE, JSON.stringify(cache), 'utf8');
    return { tem_par: true, par: novo };
}

module.exports = { monitor, checar, PONTOS_ACIMA };
