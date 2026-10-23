// ERP Commander: mediador de estoque entre o Mercado Livre e o ERP Olist (pedido do usuario em 15/10/2026).
//   ML ......... "Seu deposito" (campo "Estoque no deposito" do anuncio, NAO o Full), das DUAS contas, por SKU
//   ERP ........ um Olist para as duas contas (API v2, token): saldo do deposito "Geral"
//   diferenca .. deposito do ML - deposito Geral do Olist
//   Sincronizar: so com o botao e confirmacao, grava o valor do ML no Olist (balanco), com historico antes/depois.
// O token fica em ~/.seven/olist.json (fora do git e do AppData, os dois Dashboards usam o mesmo). A API v2 do Olist
// limita as chamadas por minuto: a coleta vai devagar (1 chamada a cada ~1,2 s), guarda o id de cada produto para nao
// pesquisar de novo e, se o Olist pedir para esperar, espera.
const fs = require('fs');
const os = require('os');
const path = require('path');

const PASTA = path.join(os.homedir(), '.seven');
// Cada empresa tem o seu Olist (23/10/2026): a Flavia usa olist.json e a Cordeiro olist_cordeiro.json; os dados do estoque,
// os saldos e os ajustes tambem ficam separados por empresa (sufixo _cordeiro). O app e reconhecido pela pasta de dados.
const EH_CORDEIRO = path.basename(path.dirname(process.env.STORAGE_PATH || path.join(__dirname, '../storage'))) === 'dashboard-cordeiro';
const SUF = EH_CORDEIRO ? '_cordeiro' : '';
const ARQ_TOKEN = path.join(PASTA, 'olist' + SUF + '.json');
const ARQ_DADOS = path.join(PASTA, 'olist_estoque' + SUF + '.json');
const API = 'https://api.tiny.com.br/api2/';
const PAUSA_MS = 1200;
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
const gravar = (arq, v) => { fs.mkdirSync(PASTA, { recursive: true }); fs.writeFileSync(arq, JSON.stringify(v), 'utf8'); };
const dormir = (ms) => new Promise(r => setTimeout(r, ms));
const norm = (s) => String(s || '').trim().toLowerCase();

function token() {
    const t = lerJson(ARQ_TOKEN, {}).token;
    if (t) return t;
    // primeira vez: o usuario salvou o token na Area de Trabalho ("API TOKENOLIST.txt"); passa para o lugar certo
    try {
        const raw = fs.readFileSync(path.join(os.homedir(), 'Desktop', 'API TOKENOLIST.txt'), 'utf8');
        const m = raw.match(/[A-Za-z0-9]{30,}/);
        if (m) { gravar(ARQ_TOKEN, { token: m[0], salvo_em: new Date().toISOString() }); return m[0]; }
    } catch {}
    return null;
}
function salvarToken(t) {
    t = String(t || '').trim();
    if (!/^[A-Za-z0-9]{30,}$/.test(t)) throw new Error('Token do Olist inválido.');
    gravar(ARQ_TOKEN, { token: t, salvo_em: new Date().toISOString() });
    return { ok: true, final: t.slice(-4) };
}

async function chamar(rota, params) {
    const tk = token(); if (!tk) throw new Error('Token do Olist não cadastrado.');
    for (let t = 0; t < 6; t++) {
        let j = null;
        try {
            const r = await fetch(API + rota, { method: 'POST', body: new URLSearchParams({ token: tk, formato: 'json', ...params }), signal: AbortSignal.timeout(30000) });
            j = (await r.json()).retorno;
        } catch (e) { await dormir(3000 * (t + 1)); continue; }
        if (j.status === 'OK') return j;
        const cod = String(j.codigo_erro || ''), msg = JSON.stringify(j.erros || '').toLowerCase();
        if (cod === '6' || /bloquead|excedido|limite|muitas/.test(msg)) { estado.aviso = 'O Olist pediu para esperar (limite da API): retomando em 60 s'; await dormir(60000); estado.aviso = null; continue; }
        if (cod === '20' || /n[aã]o (retornou|encontr)/.test(msg)) return null;   // nada encontrado
        throw new Error('Olist: ' + JSON.stringify(j.erros || j).slice(0, 160));
    }
    throw new Error('O Olist não respondeu.');
}

async function info() { const j = await chamar('info.php', {}); return { razao: j.conta?.razao_social, fantasia: j.conta?.fantasia }; }

// ---- "Seu deposito" no Mercado Livre, das duas contas, por SKU ----
// E o campo "Estoque no deposito" do anuncio (nao o Full). Vem de /user-products/{id}/stock: as localizacoes
// seller_warehouse (deposito cadastrado) e selling_address (endereco de venda); meli_facility e o Full e fica de fora.
// Anuncio Classico/Premium do mesmo produto divide o mesmo user_product: cada um e lido uma vez so.
// Por conta, vale o MAIOR deposito entre os anuncios do SKU (anuncios repetidos mostram o mesmo estoque fisico);
// anuncio so do Full com deposito 0 nao conta. Se as duas contas tem numeros diferentes, e conflito: o usuario decide.
const CONTAS = { flavia: 'dashboard-ml', cordeiro: 'dashboard-cordeiro' };
// Quem vai para o Olist: so a Flavia (decisao do usuario em 15/10/2026). A Cordeiro fica em standby: para voltar,
// e so incluir 'cordeiro' aqui (a comparacao entre as contas e o conflito continuam prontos).
// Cada app trabalha so com a conta dele (cada empresa tem o seu Olist): o da Flavia le a Flavia, o da Cordeiro le a Cordeiro.
const CONTAS_ATIVAS = EH_CORDEIRO ? ['cordeiro'] : ['flavia'];
async function cabecalhosDa(conta) {
    const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
    const esteApp = path.basename(path.dirname(STORAGE));
    if (CONTAS[conta] === esteApp) { const t = await require('./tokenManager').getToken(); return { headers: { Authorization: `Bearer ${t.access_token}` }, userId: t.user_id }; }
    return require('./outra_conta').cabecalhos();
}
async function mlGet(url, headers, params) {
    const axios = require('axios');
    for (let t = 0; t < 5; t++) {
        try { return (await axios.get(url, { headers, params, timeout: 20000 })).data; }
        catch (e) {
            const st = e.response && e.response.status;
            if (st === 404) return null;
            if (st === 429 || !st || st >= 500) { estado.aviso = st === 429 ? 'O Mercado Livre pediu calma (429): esperando' : null; await dormir(3000 * (t + 1)); estado.aviso = null; continue; }
            throw e;
        }
    }
    throw new Error('O Mercado Livre não respondeu');
}
async function emParalelo(lista, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < lista.length) { const x = lista[i++]; await fn(x); } })); }

async function depositoPorSku() {
    const mapa = {}, lidas = {};
    for (const conta of CONTAS_ATIVAS) {
        let headers, userId;
        try { ({ headers, userId } = await cabecalhosDa(conta)); } catch (e) { lidas[conta] = { erro: 'sem acesso à conta: ' + e.message }; continue; }
        estado.etapa = `lendo o depósito no Mercado Livre (${conta})`;
        // TODOS os anuncios ativos e pausados da conta (a reposicao guarda so 1 anuncio por SKU e perderia o do deposito)
        const ids = [];
        for (const status of ['active', 'paused']) {
            let scroll = null;
            for (let g = 0; g < 200; g++) {
                const r = await mlGet(`https://api.mercadolibre.com/users/${userId}/items/search`, headers, { search_type: 'scan', limit: 100, status, ...(scroll ? { scroll_id: scroll } : {}) });
                if (!r || !(r.results || []).length) break;
                ids.push(...r.results); scroll = r.scroll_id;
                if (!scroll) break;
            }
        }
        // anuncio -> user_product e SKU (20 por chamada)
        const rep = [], upDoItem = {};
        for (let i = 0; i < ids.length; i += 20) {
            const lote = await mlGet('https://api.mercadolibre.com/items', headers, { ids: ids.slice(i, i + 20).join(','), attributes: 'id,title,user_product_id,seller_custom_field,attributes,shipping' });
            for (const x of lote || []) {
                const b = x.code === 200 && x.body; if (!b || !b.user_product_id) continue;
                const sku = b.seller_custom_field || ((b.attributes || []).find(a => a.id === 'SELLER_SKU') || {}).value_name;
                if (!sku) continue;
                upDoItem[b.id] = b.user_product_id;
                rep.push({ item_id: b.id, sku: String(sku).trim(), titulo: b.title, eFull: (b.shipping || {}).logistic_type === 'fulfillment' });
            }
        }
        // estoque de cada user_product (uma vez so)
        const depDoUp = {};
        const ups = [...new Set(Object.values(upDoItem))];
        let feitos = 0;
        await emParalelo(ups, 4, async (up) => {
            const s = await mlGet(`https://api.mercadolibre.com/user-products/${up}/stock`, headers).catch(() => null);
            const locs = (s && s.locations) || [];
            const dep = locs.filter(l => l.type !== 'meli_facility');
            depDoUp[up] = dep.length ? dep.reduce((t, l) => t + (Number(l.quantity) || 0), 0) : null;
            if (++feitos % 50 === 0) estado.etapa = `lendo o depósito no Mercado Livre (${conta}): ${feitos} de ${ups.length}`;
        });
        lidas[conta] = { em: new Date().toISOString(), anuncios: rep.length, produtos: ups.length };
        for (const r of rep) {
            const up = upDoItem[r.item_id]; if (!up) continue;
            const dep = depDoUp[up];
            if (dep == null || (r.eFull && dep === 0)) continue;   // so Full, sem deposito proprio
            const k = norm(r.sku);
            const m = (mapa[k] ||= { sku: r.sku, titulo: r.titulo || '', flavia: null, cordeiro: null, anuncios: [] });
            m[conta] = Math.max(m[conta] == null ? 0 : m[conta], dep);
            if (!m.anuncios.some(a => a.conta === conta && a.up === up)) m.anuncios.push({ conta, item_id: r.item_id, up, deposito: dep });
        }
    }
    return { mapa, lidas };
}
// valor do ML para o SKU: igual nas contas (ou so uma tem) -> esse; diferente -> conflito (o usuario escolhe)
function valorMl(l) {
    const v = [l.dep_flavia, l.dep_cordeiro].filter(x => x != null);
    if (!v.length) return { valor: null, conflito: false };
    return new Set(v).size === 1 ? { valor: v[0], conflito: false } : { valor: null, conflito: true };
}
function situacaoDe(l) {
    const m = valorMl(l);
    l.ml_valor = m.valor; l.conflito = m.conflito;
    if (!l.olist_id) return l.situacao;
    if (l.erp_geral == null) return (l.situacao = 'sem depósito Geral no Olist');
    if (m.conflito) { l.diferenca = null; return (l.situacao = 'conflito entre contas'); }
    l.diferenca = m.valor - l.erp_geral;
    return (l.situacao = l.diferenca === 0 ? 'igual' : 'diferente');
}

// ---- coleta (em segundo plano, com progresso) ----
const estado = { rodando: false, feitos: 0, total: 0, inicio: null, aviso: null, erro: null, etapa: null };
async function coletar() {
    if (estado.rodando) return { ok: false, erro: 'A coleta já está rodando.' };
    if (up.rodando) return { ok: false, erro: 'Espere o envio em andamento terminar.' };
    if (!token()) return { ok: false, erro: 'Token do Olist não cadastrado.' };
    Object.assign(estado, { rodando: true, feitos: 0, total: 0, inicio: new Date().toISOString(), aviso: null, erro: null, etapa: 'lendo o depósito no Mercado Livre' });
    (async () => {
        try {
            const { mapa, lidas } = await depositoPorSku();
            const antes = lerJson(ARQ_DADOS, { ids: {}, linhas: {} });
            const ids = antes.ids || {};
            const linhas = {};
            const skus = Object.keys(mapa);
            estado.total = skus.length; estado.etapa = 'conferindo no Olist';
            for (const k of skus) {
                const f = mapa[k];
                const l = { sku: f.sku, titulo: f.titulo, dep_flavia: f.flavia, dep_cordeiro: f.cordeiro, anuncios: f.anuncios };
                try {
                    // id do produto no Olist (pesquisa uma vez e guarda); codigo exato, sem diferenciar maiusculas;
                    // rotulo do SEVEN (010tb-polo): tenta o codigo exato e vai tirando o final ("-polo")
                    let id = ids[k];
                    // 'null' guardado = nao achou da ultima vez; tenta de novo (o produto pode ter sido cadastrado no Olist depois)
                    if (id === undefined || id === null) {
                        id = null;
                        const partes = String(f.sku).trim().split('-');
                        for (let n = partes.length; n >= 1 && !id; n--) {
                            const cod = partes.slice(0, n).join('-');
                            await dormir(PAUSA_MS);
                            const p = await chamar('produtos.pesquisa.php', { pesquisa: cod });
                            const ex = ((p && p.produtos) || []).map(x => x.produto).find(x => norm(x.codigo) === norm(cod));
                            if (ex) { id = ex.id; l.erp_codigo = ex.codigo; l.erp_nome = ex.nome; }
                        }
                        ids[k] = id;
                    }
                    if (!id) l.situacao = 'SKU não encontrado no Olist';
                    else {
                        await dormir(PAUSA_MS);
                        const e = await chamar('produto.obter.estoque.php', { id });
                        const deps = ((e && e.produto && e.produto.depositos) || []).map(d => d.deposito);
                        const dGeral = deps.find(d => /geral/i.test(d.nome || ''));
                        const dFull = deps.find(d => /full/i.test(d.nome || ''));
                        l.olist_id = id;
                        l.erp_nome = l.erp_nome || (e && e.produto && e.produto.nome) || '';
                        l.erp_codigo = l.erp_codigo || (e && e.produto && e.produto.codigo) || null;
                        l.erp_geral_dep = dGeral ? dGeral.nome : null;
                        l.erp_geral = dGeral ? Number(dGeral.saldo) || 0 : null;
                        l.erp_full = dFull ? Number(dFull.saldo) || 0 : null;
                        situacaoDe(l);
                    }
                } catch (err) { l.situacao = 'erro: ' + String(err.message).slice(0, 100); }
                linhas[k] = l;
                estado.feitos++;
                if (estado.feitos % 20 === 0) gravar(ARQ_DADOS, { em: new Date().toISOString(), parcial: true, lidas, ids, linhas });
            }
            // rotulos diferentes que sao o mesmo produto no Olist (010tb-polo, 010tb-nivus -> 010TB): uma linha so,
            // com o maior deposito de cada conta
            const porId = {};
            for (const [k, l] of Object.entries(linhas)) {
                if (!l.olist_id) { porId['sku:' + k] = l; continue; }
                const j = porId[l.olist_id];
                if (!j) { porId[l.olist_id] = { ...l, rotulos: [l.sku] }; continue; }
                for (const c of ['dep_flavia', 'dep_cordeiro']) if (l[c] != null) j[c] = Math.max(j[c] == null ? 0 : j[c], l[c]);
                j.anuncios = j.anuncios.concat(l.anuncios); j.rotulos.push(l.sku);
                situacaoDe(j);
            }
            for (const l of Object.values(porId)) if (l.erp_codigo) l.sku = l.erp_codigo;
            gravar(ARQ_DADOS, { em: new Date().toISOString(), parcial: false, lidas, ids, linhas: porId });
        } catch (e) { estado.erro = e.message; }
        finally { estado.rodando = false; estado.etapa = null; }
    })();
    return { ok: true };
}

function resultado() {
    const d = lerJson(ARQ_DADOS, { linhas: {} });
    const L = Object.values(d.linhas || {}).filter(l => 'dep_flavia' in l);   // ignora dados antigos (comparacao do Full)
    return {
        em: L.length ? d.em || null : null, parcial: !!d.parcial, lidas: d.lidas || {}, contas: CONTAS_ATIVAS, coleta: { ...estado }, tem_token: !!token(), sinc: { ...up, itens: undefined, aviso: estado.aviso },
        resumo: { skus: L.length, iguais: L.filter(l => l.situacao === 'igual').length, diferentes: L.filter(l => l.situacao === 'diferente').length,
            conflitos: L.filter(l => l.situacao === 'conflito entre contas').length,
            nao_encontrados: L.filter(l => /não encontrado/.test(l.situacao || '')).length,
            ml_total: L.reduce((t, l) => t + (l.ml_valor || 0), 0), erp_geral: L.reduce((t, l) => t + (l.erp_geral || 0), 0) },
        linhas: L.sort((a, b) => Math.abs(b.diferenca || 0) - Math.abs(a.diferenca || 0)),
    };
}

// ==== Subir estoque por planilha (ERP Commander) ====
// O usuario manda uma planilha com SKU e quantidade. 1) PREVIA: acha cada SKU no Olist e le o saldo atual do deposito
// escolhido, sem alterar nada. 2) APLICAR: so depois da confirmacao, grava como BALANCO (tipo B: a quantidade vira o
// saldo do deposito) apenas as linhas marcadas que mudam. Cada ajuste fica registrado (antes/depois) em olist_ajustes.json.
const ARQ_AJUSTES = path.join(PASTA, 'olist_ajustes' + SUF + '.json');
const numBR = (v) => {
    if (typeof v === 'number') return v;
    let t = String(v == null ? '' : v).trim().replace(/\s/g, '');
    if (!t) return NaN;
    if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
    return Number(t);
};
// le a planilha (xlsx/xls/csv em base64): acha as colunas SKU e quantidade pelo cabecalho; sem cabecalho, A = SKU e B = quantidade
function lerPlanilha(base64, nome) {
    const XLSX = require('xlsx');
    const buf = Buffer.from(String(base64 || ''), 'base64');
    const wb = /\.csv$/i.test(nome || '') ? XLSX.read(buf.toString('utf8').replace(/^﻿/, ''), { type: 'string', raw: true }) : XLSX.read(buf, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
    let iSku = 0, iQtd = 1, ini = 0;
    for (let r = 0; r < Math.min(rows.length, 10); r++) {
        const cab = rows[r].map(c => norm(c).normalize('NFD').replace(/[̀-ͯ]/g, ''));
        const s = cab.findIndex(c => /^(sku|codigo|cod\.?|referencia)$/.test(c) || /\bsku\b/.test(c));
        const q = cab.findIndex(c => /estoque|quantidade|qtd|qtde|saldo|balanco/.test(c));
        if (s >= 0 && q >= 0) { iSku = s; iQtd = q; ini = r + 1; break; }
    }
    const linhas = [], invalidas = [], porSku = {};
    for (let r = ini; r < rows.length; r++) {
        const sku = String(rows[r][iSku] == null ? '' : rows[r][iSku]).trim();
        const brutoQ = rows[r][iQtd];
        if (!sku && (brutoQ === '' || brutoQ == null)) continue;
        const q = numBR(brutoQ);
        if (!sku || !Number.isFinite(q) || q < 0) { invalidas.push({ linha: r + 1, sku, valor: String(brutoQ) }); continue; }
        const k = norm(sku);
        if (porSku[k] != null) { linhas[porSku[k]].quantidade = q; linhas[porSku[k]].repetido = true; continue; }   // repetido: vale a ultima linha
        porSku[k] = linhas.length; linhas.push({ sku, quantidade: q });
    }
    return { linhas, invalidas, colunas: { sku: iSku + 1, quantidade: iQtd + 1, cabecalho: ini > 0 } };
}

// id do produto no Olist pelo codigo: exato primeiro; rotulo do SEVEN (010tb-polo) vai tirando o final
// Codigos do Olist que podem ser o SKU do anuncio, em ordem (regra de 16/10/2026):
//   1. o codigo exato;
//   2. PAR ("31178e-31178d-par"): o par com os lados na outra ordem. Par NUNCA casa com um lado sozinho;
//   3. rotulo do SEVEN no final ("010tb-polo", "tap-007-strada-0512"): vai tirando o final, MAS para se o pedaco
//      tirado marca outro produto (nac, original, importada, kit, pai...) ou e um segundo codigo de peca (6+ digitos).
const SUFIXO_OUTRO_PRODUTO = /^(par|kit|nac|nacional|original|importad[ao]?|i|n|m|o|r|l|pai|pelado|cinto|cr|tvh|\d+un)$/i;
function candidatosCodigo(sku) {
    const s = norm(sku);
    if (!s) return [];
    const par = s.match(/^([^-]+)-([^-]+)-par$/);
    if (par) return [s, `${par[2]}-${par[1]}-par`];
    const partes = s.split('-'), out = [s];
    for (let n = partes.length - 1; n >= 1; n--) {
        const tirado = partes[n];
        if (SUFIXO_OUTRO_PRODUTO.test(tirado) || /^\d{6,}$/.test(tirado)) break;
        out.push(partes.slice(0, n).join('-'));
    }
    return out;
}
async function idPorCodigo(sku, ids) {
    const k = norm(sku);
    const cands = candidatosCodigo(sku);
    for (let i = 0; i < cands.length; i++) {
        const cod = cands[i];
        await dormir(PAUSA_MS);
        const p = await chamar('produtos.pesquisa.php', { pesquisa: cod });
        const ex = ((p && p.produtos) || []).map(x => x.produto).find(x => norm(x.codigo) === cod);
        if (ex) { ids[k] = ex.id; return { id: ex.id, codigo: ex.codigo, nome: ex.nome, aproximado: i > 0 && !/-par$/.test(cod) }; }
    }
    return { id: null };
}

const up = { fase: null, rodando: false, feitos: 0, total: 0, deposito: null, arquivo: null, itens: [], invalidas: [], erro: null, em: null };
function upload() { return { ...up, aviso: estado.aviso }; }

function previa(base64, nome, deposito) {
    if (up.rodando) return { ok: false, erro: 'Já tem uma prévia ou um envio rodando.' };
    if (estado.rodando) return { ok: false, erro: 'Espere a consulta do Full × ERP terminar (o Olist limita as chamadas).' };
    if (!token()) return { ok: false, erro: 'Token do Olist não cadastrado.' };
    deposito = String(deposito || '').trim();
    if (!deposito) return { ok: false, erro: 'Escolha o depósito do Olist.' };
    let pl;
    try { pl = lerPlanilha(base64, nome); } catch (e) { return { ok: false, erro: 'Não consegui ler a planilha: ' + e.message }; }
    if (!pl.linhas.length) return { ok: false, erro: 'Nenhuma linha com SKU e quantidade válidos.', invalidas: pl.invalidas };
    Object.assign(up, { fase: 'previa', rodando: true, feitos: 0, total: pl.linhas.length, deposito, arquivo: nome || 'planilha', itens: [], invalidas: pl.invalidas, erro: null, em: new Date().toISOString(), colunas: pl.colunas });
    (async () => {
        try {
            const ids = { ...(lerJson(ARQ_DADOS, { ids: {} }).ids || {}) };
            for (const l of pl.linhas) {
                const it = { sku: l.sku, novo: l.quantidade, repetido: !!l.repetido };
                try {
                    const r = await idPorCodigo(l.sku, ids);
                    if (!r.id) it.situacao = 'SKU não encontrado no Olist';
                    else {
                        await dormir(PAUSA_MS);
                        const e = await chamar('produto.obter.estoque.php', { id: r.id });
                        const deps = ((e && e.produto && e.produto.depositos) || []).map(d => d.deposito);
                        const d = deps.find(x => norm(x.nome) === norm(deposito));
                        Object.assign(it, { olist_id: r.id, codigo: (e && e.produto && e.produto.codigo) || r.codigo || l.sku, nome: (e && e.produto && e.produto.nome) || r.nome || '', aproximado: !!r.aproximado });
                        if (!d) it.situacao = 'produto sem o depósito "' + deposito + '"';
                        else {
                            it.atual = Number(d.saldo) || 0;
                            it.diferenca = it.novo - it.atual;
                            it.situacao = it.diferenca === 0 ? 'já está igual' : 'vai mudar';
                        }
                    }
                } catch (err) { it.situacao = 'erro: ' + String(err.message).slice(0, 100); }
                up.itens.push(it); up.feitos++;
            }
            // duas linhas da planilha caindo no mesmo produto do Olist (010TB e 010tb-polo): nao grava nenhuma das duas
            const porId = {};
            for (const it of up.itens) if (it.olist_id) (porId[it.olist_id] ||= []).push(it);
            for (const L of Object.values(porId)) if (L.length > 1) for (const it of L) it.situacao = 'conflito: mesmo produto do Olist em ' + L.length + ' linhas (' + L.map(x => x.sku).join(', ') + ')';
            // guarda os ids achados (a proxima previa e a consulta do Full x ERP ficam mais rapidas)
            const d2 = lerJson(ARQ_DADOS, { linhas: {} }); d2.ids = { ...(d2.ids || {}), ...ids }; gravar(ARQ_DADOS, d2);
        } catch (e) { up.erro = e.message; }
        finally { up.rodando = false; }
    })();
    return { ok: true, linhas: pl.linhas.length, invalidas: pl.invalidas.length, colunas: pl.colunas };
}

function aplicar(skus) {
    if (up.rodando) return { ok: false, erro: 'Já tem algo rodando.' };
    if (estado.rodando) return { ok: false, erro: 'Espere a consulta do Full × ERP terminar.' };
    if (up.fase !== 'previa' || !up.itens.length) return { ok: false, erro: 'Faça a prévia da planilha primeiro.' };
    const marcados = new Set((skus || []).map(norm));
    const fila = up.itens.filter(it => marcados.has(norm(it.sku)) && it.olist_id && it.situacao === 'vai mudar');
    if (!fila.length) return { ok: false, erro: 'Nenhuma linha marcada para mudar.' };
    Object.assign(up, { fase: 'aplicando', rodando: true, feitos: 0, total: fila.length, erro: null });
    (async () => {
        const log = lerJson(ARQ_AJUSTES, []);
        try {
            for (const it of fila) {
                try {
                    await dormir(PAUSA_MS);
                    const estoque = { estoque: { idProduto: it.olist_id, tipo: 'B', quantidade: String(it.novo), deposito: up.deposito, observacoes: ('SEVEN ERP Commander - ' + String(up.arquivo)).slice(0, 100) } };
                    const j = await chamar('produto.atualizar.estoque.php', { estoque: JSON.stringify(estoque) });
                    if (!j) throw new Error('o Olist não achou o produto');
                    const reg = j.registros && j.registros[0] && j.registros[0].registro;
                    if (reg && reg.status && reg.status !== 'OK') throw new Error(JSON.stringify(reg.erros || reg).slice(0, 120));
                    it.depois = reg && reg.saldoEstoque != null ? Number(reg.saldoEstoque) : it.novo;
                    it.situacao = 'alterado';
                    log.unshift({ quando: new Date().toISOString(), sku: it.codigo || it.sku, olist_id: it.olist_id, nome: it.nome, deposito: up.deposito, antes: it.atual, depois: it.depois, arquivo: up.arquivo });
                } catch (err) { it.situacao = 'erro ao gravar: ' + String(err.message).slice(0, 100); }
                up.feitos++;
                gravar(ARQ_AJUSTES, log.slice(0, 3000));
            }
        } catch (e) { up.erro = e.message; }
        finally { gravar(ARQ_AJUSTES, log.slice(0, 3000)); up.fase = 'feito'; up.rodando = false; }
    })();
    return { ok: true, total: fila.length };
}
// SINCRONIZAR: o usuario aperta o botao e o deposito Geral do Olist passa a ter o que esta no "Seu deposito" do ML.
// Recebe [{id, valor}]: linha normal usa o valor do ML; linha em conflito entre contas usa o valor que o usuario escolheu
// (Flavia, Cordeiro ou digitado). Balanco (tipo B), so as linhas marcadas, com registro antes/depois.
function sincronizar(itens) {
    if (up.rodando || estado.rodando) return { ok: false, erro: 'Espere a consulta ou o envio em andamento terminar.' };
    if (!token()) return { ok: false, erro: 'Token do Olist não cadastrado.' };
    const d = lerJson(ARQ_DADOS, { linhas: {} });
    if (d.parcial) return { ok: false, erro: 'A consulta está incompleta: atualize antes de sincronizar.' };
    const porId = {};
    for (const [k, l] of Object.entries(d.linhas || {})) if (l.olist_id) porId[String(l.olist_id)] = [k, l];
    const fila = [];
    for (const it of itens || []) {
        const achou = porId[String(it.id)]; if (!achou) continue;
        const [k, l] = achou;
        if (l.erp_geral == null || !['diferente', 'conflito entre contas'].includes(l.situacao)) continue;
        const valor = l.situacao === 'conflito entre contas' ? Number(it.valor) : l.ml_valor;
        if (!Number.isFinite(valor) || valor < 0 || valor === l.erp_geral) continue;
        fila.push({ k, l, valor });
    }
    if (!fila.length) return { ok: false, erro: 'Nada para sincronizar (marque linhas com diferença; nas de conflito, escolha o valor).' };
    Object.assign(up, { fase: 'sincronizando', rodando: true, feitos: 0, total: fila.length, deposito: 'Geral', arquivo: 'Sincronizar depósito ML → Olist', itens: [], invalidas: [], erro: null, resultado: null, em: new Date().toISOString() });
    (async () => {
        const log = lerJson(ARQ_AJUSTES, []);
        let ok = 0, falhas = 0;
        try {
            for (const { k, l, valor } of fila) {
                const dep = l.erp_geral_dep || 'Geral';
                try {
                    await dormir(PAUSA_MS);
                    const estoque = { estoque: { idProduto: l.olist_id, tipo: 'B', quantidade: String(valor), deposito: dep, observacoes: 'SEVEN ERP Commander - sincronizado com o deposito do Mercado Livre' } };
                    const j = await chamar('produto.atualizar.estoque.php', { estoque: JSON.stringify(estoque) });
                    if (!j) throw new Error('o Olist não achou o produto');
                    const reg = j.registros && j.registros[0] && j.registros[0].registro;
                    if (reg && reg.status && reg.status !== 'OK') throw new Error(JSON.stringify(reg.erros || reg).slice(0, 120));
                    const depois = reg && reg.saldoEstoque != null ? Number(reg.saldoEstoque) : valor;
                    log.unshift({ quando: new Date().toISOString(), sku: l.erp_codigo || l.sku, olist_id: l.olist_id, nome: l.erp_nome || l.titulo, deposito: dep, antes: l.erp_geral, depois, arquivo: 'Sincronizar depósito ML → Olist' + (l.situacao === 'conflito entre contas' ? ' (valor escolhido)' : '') });
                    // a tabela ja mostra o novo saldo (sem consultar tudo de novo)
                    const atual = lerJson(ARQ_DADOS, { linhas: {} });
                    if (atual.linhas && atual.linhas[k]) {
                        Object.assign(atual.linhas[k], { erp_geral: valor, diferenca: 0, situacao: 'sincronizado', sincronizado_em: new Date().toISOString() });
                        gravar(ARQ_DADOS, atual);
                    }
                    ok++;
                } catch (err) { falhas++; up.erro = (l.erp_codigo || l.sku) + ': ' + String(err.message).slice(0, 100); }
                up.feitos++;
                gravar(ARQ_AJUSTES, log.slice(0, 3000));
            }
        } catch (e) { up.erro = e.message; }
        finally { up.resultado = { ok, falhas }; up.fase = 'sincronizado'; up.rodando = false; }
    })();
    return { ok: true, total: fila.length };
}

function ajustes(n) { return lerJson(ARQ_AJUSTES, []).slice(0, n || 200); }
function limparUpload() {
    if (up.rodando) return { ok: false, erro: 'Ainda rodando.' };
    Object.assign(up, { fase: null, itens: [], invalidas: [], total: 0, feitos: 0, erro: null, arquivo: null, deposito: null });
    return { ok: true };
}
// nomes dos depositos do Olist (le de um produto ja conhecido)
async function depositos() {
    const padrao = ['Geral', 'MERCADO LIVRE FULL'];
    const ids = Object.values(lerJson(ARQ_DADOS, { ids: {} }).ids || {}).filter(Boolean);
    if (!ids.length || estado.rodando || up.rodando) return padrao;
    const e = await chamar('produto.obter.estoque.php', { id: ids[0] });
    const nomes = ((e && e.produto && e.produto.depositos) || []).map(d => d.deposito.nome).filter(Boolean);
    return nomes.length ? nomes : padrao;
}

// ==== Retrato dos saldos do Olist (Lista ERP do Painel e Flex automatico) ====
// Guarda o saldo de cada produto do Olist por codigo em olist_saldos.json. A cada atualizacao pede ao Olist so o que
// mudou de estoque desde a ultima vez (lista.atualizacoes.estoque: ~1 chamada por 100 produtos, ate 30 dias para tras).
// SKU que nunca mudou nesses 30 dias e ainda nao esta no retrato e lido uma vez pelo id (pesquisa + estoque) e guardado.
const ARQ_SALDOS = path.join(PASTA, 'olist_saldos' + SUF + '.json');
const fmtTiny = (d) => { const p = (n) => String(n).padStart(2, '0'); const b = new Date(d.getTime() - 3 * 3600000); return `${p(b.getUTCDate())}/${p(b.getUTCMonth() + 1)}/${b.getUTCFullYear()} ${p(b.getUTCHours())}:${p(b.getUTCMinutes())}:${p(b.getUTCSeconds())}`; };
function lerSaldos() { return lerJson(ARQ_SALDOS, { atualizado_em: null, por_codigo: {}, ausentes: {} }); }
function guardarProduto(S, p) {
    const deps = (p.depositos || []).map(d => d.deposito);
    const g = deps.find(d => /geral/i.test(d.nome || '')), f = deps.find(d => /full/i.test(d.nome || ''));
    S.por_codigo[norm(p.codigo)] = { id: String(p.id), codigo: p.codigo, nome: p.nome || '', geral: g ? Number(g.saldo) || 0 : null, full: f ? Number(f.saldo) || 0 : null, em: new Date().toISOString() };
    delete S.ausentes[norm(p.codigo)];
}
let saldosRodando = null;
// pede ao Olist o que mudou desde a ultima atualizacao (ou dos ultimos 29 dias na primeira vez)
function atualizarSaldos() {
    if (saldosRodando) return saldosRodando;
    saldosRodando = (async () => {
        const S = lerSaldos();
        const agora = new Date();
        const desde = S.atualizado_em ? new Date(Math.max(new Date(S.atualizado_em).getTime() - 10 * 60000, agora.getTime() - 29 * 86400000)) : new Date(agora.getTime() - 29 * 86400000);
        let pag = 1, paginas = 1, lidos = 0;
        do {
            await dormir(PAUSA_MS);
            const j = await chamar('lista.atualizacoes.estoque.php', { dataAlteracao: fmtTiny(desde), pagina: String(pag) });
            if (!j) break;
            paginas = Number(j.numero_paginas) || 1;
            for (const x of j.produtos || []) if (x.produto && x.produto.codigo) { guardarProduto(S, x.produto); lidos++; }
        } while (++pag <= paginas && pag <= 60);
        S.atualizado_em = agora.toISOString();
        gravar(ARQ_SALDOS, S);
        return { lidos, paginas };
    })().finally(() => { saldosRodando = null; });
    return saldosRodando;
}
// saldo de um SKU do ML no retrato: codigo exato; rotulo do SEVEN (010tb-polo) vai tirando o final ("-polo")
function saldoDoRetrato(S, sku) {
    for (const c of candidatosCodigo(sku)) { const r = S.por_codigo[c]; if (r) return r; }
    return null;
}
// SKUs que ainda nao estao no retrato: pesquisa no Olist (o que nao existe fica marcado por 1 dia: o cadastro do
// Olist esta sendo completado, entao produto novo aparece logo)
async function completarSaldos(skus, aoAvancar) {
    const S = lerSaldos();
    const faltam = [...new Set(skus.filter(Boolean).map(s => String(s).trim()))].filter(s => !saldoDoRetrato(S, s) && !(S.ausentes[norm(s)] && Date.now() - new Date(S.ausentes[norm(s)]).getTime() < 86400000));
    let feitos = 0;
    for (const sku of faltam) {
        try {
            const r = await idPorCodigo(sku, {});
            if (!r.id) S.ausentes[norm(sku)] = new Date().toISOString();
            else {
                await dormir(PAUSA_MS);
                const e = await chamar('produto.obter.estoque.php', { id: r.id });
                if (e && e.produto) guardarProduto(S, e.produto);
            }
        } catch (err) { /* tenta de novo na proxima */ }
        if (++feitos % 10 === 0) gravar(ARQ_SALDOS, S);
        if (aoAvancar) aoAvancar(feitos, faltam.length);
    }
    gravar(ARQ_SALDOS, S);
    return { completados: feitos };
}

// ---- Lista ERP do Painel: saldo do deposito Geral para cada produto da reposicao deste Dashboard ----
const erp = { rodando: false, feitos: 0, total: 0, erro: null, aviso: null };
function skusDaReposicao() {
    const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
    return lerJson(path.join(STORAGE, 'reposicao.json'), []).filter(r => r.sku).map(r => ({ chave: r.chave || r.sku, sku: r.sku }));
}
function erpReposicao() {
    const S = lerSaldos();
    const mapa = {};
    for (const r of skusDaReposicao()) { const s = saldoDoRetrato(S, r.sku); mapa[r.chave] = s ? s.geral : null; }
    return { atualizado_em: S.atualizado_em, mapa, coleta: { ...erp, aviso: estado.aviso }, tem_token: !!token() };
}
function atualizarErpReposicao() {
    if (erp.rodando) return { ok: false, erro: 'Já está atualizando.' };
    if (!token()) return { ok: false, erro: 'Token do Olist não cadastrado.' };
    Object.assign(erp, { rodando: true, feitos: 0, total: 0, erro: null });
    (async () => {
        try {
            await atualizarSaldos();
            await completarSaldos(skusDaReposicao().map(r => r.sku), (f, t) => { erp.feitos = f; erp.total = t; });
        } catch (e) { erp.erro = e.message; }
        finally { erp.rodando = false; }
    })();
    return { ok: true };
}

module.exports = { info, coletar, resultado, salvarToken, depositoPorSku, lerPlanilha, previa, aplicar, upload, ajustes, limparUpload, depositos, sincronizar,
    chamar, cabecalhosDa, mlGet, atualizarSaldos, completarSaldos, lerSaldos, saldoDoRetrato, erpReposicao, atualizarErpReposicao };
