// Seven: noticias urgentes, vendas de ontem x media e tabela de concorrentes.
//
// Le a coleta do Dashboard (reposicao.json) e busca no ML so o que ela nao tem:
// os pedidos de ontem. Concorrentes (PC, DF%, RANK NUB) dependem do Nubimetrics
// e do MT e ficam vazios ate essa parte ser ligada.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const XLSX = require('xlsx');
const TokenManager = require('./tokenManager');
const feed = require('./feed');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const CACHE_ONTEM = path.join(STORAGE, 'seven_vendas_ontem.json');

function lerJson(arquivo, padrao) {
    try { return JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch { return padrao; }
}

// Data de ontem no horario de Brasilia (-03:00), como 'YYYY-MM-DD'.
function ontemBR() {
    const agoraBR = new Date(Date.now() - 3 * 3600 * 1000);
    agoraBR.setUTCDate(agoraBR.getUTCDate() - 1);
    return agoraBR.toISOString().slice(0, 10);
}

async function pagina(headers, params) {
    for (let tentativa = 0; ; tentativa++) {
        try {
            const { data } = await axios.get('https://api.mercadolibre.com/orders/search', { headers, params, timeout: 20000 });
            return data;
        } catch (e) {
            if (e.response?.status === 429 && tentativa < 5) { await new Promise(r => setTimeout(r, 1500 * (tentativa + 1))); continue; }
            throw e;
        }
    }
}

// Pedidos (nao cancelados) entre dois dias, somados por anuncio.
async function buscarPedidos(de, ate) {
    const { access_token, user_id } = await TokenManager.getToken();
    const headers = { Authorization: `Bearer ${access_token}` };
    const base = {
        seller: user_id, limit: 50,
        'order.date_created.from': `${de}T00:00:00.000-03:00`,
        'order.date_created.to': `${ate}T23:59:59.999-03:00`,
    };
    const primeira = await pagina(headers, { ...base, offset: 0 });
    const total = primeira.paging?.total || 0;
    const paginas = [primeira];
    const offsets = [];
    for (let o = 50; o < total; o += 50) offsets.push(o);
    for (let k = 0; k < offsets.length; k += 5) {
        const lote = await Promise.all(offsets.slice(k, k + 5).map(offset => pagina(headers, { ...base, offset })));
        paginas.push(...lote);
    }
    const porItem = {};
    let pedidos = 0;
    for (const pg of paginas) {
        for (const o of pg.results || []) {
            if (o.status === 'cancelled') continue;
            pedidos++;
            for (const it of o.order_items || []) {
                const id = it.item?.id;
                if (id) porItem[id] = (porItem[id] || 0) + Number(it.quantity || 0);
            }
        }
    }
    return { pedidos, porItem };
}

async function vendasOntem(forcar = false) {
    const dia = ontemBR();
    const cache = lerJson(CACHE_ONTEM, null);
    if (!forcar && cache && cache.dia === dia) return cache;
    const { pedidos, porItem } = await buscarPedidos(dia, dia);
    const novo = { dia, pedidos, porItem, coletado_em: new Date().toISOString() };
    fs.mkdirSync(STORAGE, { recursive: true });
    fs.writeFileSync(CACHE_ONTEM, JSON.stringify(novo, null, 2), 'utf8');
    return novo;
}

const CACHE_MES = path.join(STORAGE, 'seven_mes_anterior.json');

// Mes anterior ao atual (horario de Brasilia): a base de comparacao das vendas.
function mesAnteriorBR() {
    const agora = new Date(Date.now() - 3 * 3600 * 1000);
    const ini = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth() - 1, 1));
    const fim = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), 0));
    const nome = ini.toLocaleString('pt-BR', { month: 'long', timeZone: 'UTC' });
    return { mes: ini.toISOString().slice(0, 7), de: ini.toISOString().slice(0, 10), ate: fim.toISOString().slice(0, 10), dias: fim.getUTCDate(), nome };
}

// Mes fechado nao muda: busca uma vez e guarda.
async function vendasMesAnterior() {
    const m = mesAnteriorBR();
    const cache = lerJson(CACHE_MES, null);
    if (cache && cache.mes === m.mes) return cache;
    const { pedidos, porItem } = await buscarPedidos(m.de, m.ate);
    const novo = { ...m, pedidos, porItem, coletado_em: new Date().toISOString() };
    fs.mkdirSync(STORAGE, { recursive: true });
    fs.writeFileSync(CACHE_MES, JSON.stringify(novo, null, 2), 'utf8');
    return novo;
}

// Ranking ML: coletado pelo Issacar direto na busca do ML (lib/ranking_mt.js dispara).
// A contagem imita a API: sem patrocinados, cada anuncio uma vez, 50 por pagina.
// Cada termo traz TODOS os nossos anuncios achados (pelo MLB); fica a melhor posicao.
const RANKING_ML_PADRAO = 'C:/Users/Matheus Prata/.dotnet/MLScraper/saidas/ranking_issacar_flavia.json';

function rankingML() {
    const cfg = lerJson(path.join(STORAGE, 'config.json'), {});
    const arquivo = cfg.ranking_ml_arquivo || RANKING_ML_PADRAO;
    const dados = lerJson(arquivo, null);
    if (!dados || !Array.isArray(dados.resultados)) return { disponivel: false, porItem: {} };
    const porItem = {};
    for (const reg of dados.resultados) {
        for (const a of reg.achados || []) {
            const atual = porItem[a.item_id];
            if (!atual || a.posicao < atual.posicao) {
                porItem[a.item_id] = { pagina: a.pagina, posicao: a.posicao, posicao_full: a.posicao_full ?? null, termo: reg.termo };
            }
        }
    }
    return {
        disponivel: true, coletado_em: dados.coletado_em || null, porItem,
        termos: dados.termos || 0, feitos: (dados.resultados || []).filter(r => r.status === 'ok').length,
    };
}

function produtos() {
    return lerJson(path.join(STORAGE, 'reposicao.json'), []).filter(p => p.item_id && !feed.ehEmpilhadeira(p));
}

function situacao(ontem, media, noMes) {
    if (noMes === 0) return ontem > 0 ? 'Sem base no mês' : 'Sem giro';
    if (media < 0.2) return ontem > 0 ? 'Vendeu (raro)' : 'Sem giro';
    if (ontem === 0) return 'Não vendeu';
    if (ontem >= media * 1.2) return 'Acima da média';
    if (ontem <= media * 0.8) return 'Abaixo da média';
    return 'Na média';
}

async function tabelaVendas(forcar = false) {
    const [o, m] = await Promise.all([vendasOntem(forcar), vendasMesAnterior()]);
    const lista = produtos();
    const rk = rankingML();
    const linhas = lista.map(p => {
        const ontem = o.porItem[p.item_id] || 0;
        const noMes = m.porItem[p.item_id] || 0;
        const media = noMes / m.dias;
        return {
            item_id: p.item_id, sku: p.sku, titulo: p.titulo, status: p.status,
            ontem, media_dia: +media.toFixed(2), vendas_mes: noMes,
            variacao: media > 0 ? +((ontem - media) / media).toFixed(3) : null,
            situacao: situacao(ontem, media, noMes), preco: p.preco || null,
            rank_ml: rk.porItem[p.item_id] || null,
        };
    });
    linhas.sort((a, b) => b.ontem - a.ontem || b.media_dia - a.media_dia);
    const totalOntem = linhas.reduce((s, l) => s + l.ontem, 0);
    const mediaTotal = linhas.reduce((s, l) => s + l.media_dia, 0);
    return {
        dia: o.dia, coletado_em: o.coletado_em, pedidos: o.pedidos,
        base: { mes: m.mes, nome: m.nome, dias: m.dias, pedidos: m.pedidos },
        ranking_ml: { disponivel: rk.disponivel, coletado_em: rk.coletado_em || null, termos: rk.termos || 0, feitos: rk.feitos || 0 },
        resumo: {
            unidades_ontem: totalOntem,
            media_dia_base: +mediaTotal.toFixed(1),
            variacao: mediaTotal > 0 ? +((totalOntem - mediaTotal) / mediaTotal).toFixed(3) : null,
            venderam: linhas.filter(l => l.ontem > 0).length,
            nao_venderam: linhas.filter(l => l.situacao === 'Não vendeu').length,
            rankeados: linhas.filter(l => l.rank_ml).length,
            pagina1: linhas.filter(l => l.rank_ml && l.rank_ml.pagina === 1).length,
        },
        linhas,
    };
}

function tabelaConcorrentes() {
    const linhas = produtos().filter(p => p.status === 'active').map(p => ({
        item_id: p.item_id, sku: p.sku, titulo: p.titulo,
        mp: p.preco || null,     // meu preco
        pc: null,                // preco do concorrente (Nubimetrics)
        df: null,                // diferenca % (MP x PC)
        rank_nub: null,          // ranking Nubimetrics
    }));
    linhas.sort((a, b) => (b.mp || 0) - (a.mp || 0));
    return { fonte_pendente: 'Nubimetrics e Mercado Turbo', linhas };
}

const brl = (v) => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 });

const pct = (v) => (v >= 0 ? '+' : '') + Math.round(v * 100) + '%';
const nomeCurto = (l) => `${l.sku} · ${l.titulo}`;

async function noticias() {
    const f = feed.montar();
    const v = await tabelaVendas(false);
    const r = v.resumo;
    const L = v.linhas;

    // Estoque: as 3 decisoes que mais valem dinheiro
    const estoque = (f.prioridades || []).slice(0, 3).map(p => ({
        titulo: `${p.acao}${p.acao_detalhe ? ': ' + p.acao_detalhe : ''}`,
        texto: p.motivo || '', produto: `${p.sku} · ${p.titulo}`,
        valor: p.peso ? brl(p.peso) : '', link: '/feed',
    }));

    // Vendas: o numero do dia e os destaques
    const naoVenderam = L.filter(l => l.situacao === 'Não vendeu').sort((a, b) => b.media_dia - a.media_dia);
    const acima = L.filter(l => l.situacao === 'Acima da média').sort((a, b) => (b.ontem - b.media_dia) - (a.ontem - a.media_dia));
    const vendas = [{
        titulo: `Ontem: ${r.unidades_ontem} unidades` + (r.variacao != null ? ` (${pct(r.variacao)} vs ${v.base.nome})` : ''),
        texto: `Média de ${v.base.nome}: ${r.media_dia_base}/dia. ${r.nao_venderam} anúncios que costumam vender ficaram zerados.`,
        produto: '', valor: '', link: '#vendas',
    }];
    for (const l of naoVenderam.slice(0, 2)) {
        vendas.push({
            titulo: 'Parou de vender ontem', produto: nomeCurto(l),
            texto: `Vendia ${l.media_dia.toFixed(1)}/dia em ${v.base.nome}` + (l.rank_ml ? `, e está em ${l.rank_ml.posicao}º na busca.` : ', e não aparece na busca.'),
            valor: '', link: '#vendas',
        });
    }
    if (acima[0]) {
        vendas.push({
            titulo: `Vendeu ${acima[0].ontem} ontem`, produto: nomeCurto(acima[0]),
            texto: `Acima da média de ${acima[0].media_dia.toFixed(1)}/dia.`, valor: '', link: '#vendas',
        });
    }

    // Ranking ML: rankeados x fora do ranking
    const ranking = [];
    if (v.ranking_ml.disponivel) {
        const rk = L.filter(l => l.rank_ml);
        const primeiros = rk.filter(l => l.rank_ml.posicao === 1);
        ranking.push({
            titulo: `${r.rankeados} anúncios rankeados · ${r.pagina1} na 1ª página`,
            texto: `${primeiros.length} em 1º lugar. Coleta de ${v.ranking_ml.coletado_em}, ${v.ranking_ml.feitos} de ${v.ranking_ml.termos} termos.`,
            produto: primeiros.slice(0, 3).map(l => l.sku).join(' · '), valor: '', link: '#vendas',
        });
        const foraVendendo = L.filter(l => !l.rank_ml && l.vendas_mes > 0).sort((a, b) => b.vendas_mes - a.vendas_mes);
        for (const l of foraVendendo.slice(0, 2)) {
            ranking.push({
                titulo: 'Vende, mas está fora do ranking', produto: nomeCurto(l),
                texto: `${l.vendas_mes} vendas em ${v.base.nome} e não aparece nas 3 primeiras páginas dos termos pesquisados.`,
                valor: '', link: '#vendas',
            });
        }
        const topSemVenda = rk.filter(l => l.rank_ml.pagina === 1 && l.ontem === 0 && l.media_dia >= 0.5)
            .sort((a, b) => a.rank_ml.posicao - b.rank_ml.posicao);
        if (topSemVenda[0]) {
            const l = topSemVenda[0];
            ranking.push({
                titulo: `${l.rank_ml.posicao}º na busca e não vendeu ontem`, produto: nomeCurto(l),
                texto: `Bem posicionado em "${l.rank_ml.termo}", mas zerou ontem (vendia ${l.media_dia.toFixed(1)}/dia).`,
                valor: '', link: '#vendas',
            });
        }
    } else {
        ranking.push({ titulo: 'Ranking ML ainda não coletado', texto: 'Use "Coletar ranking ML" na tela de vendas.', produto: '', valor: '', link: '#vendas' });
    }

    const concorrentes = [{
        titulo: 'Análise de concorrentes em preparação',
        texto: 'Preço do concorrente e diferença % entram quando o Nubimetrics for ligado.',
        produto: '', valor: '', link: '#concorrentes',
    }];

    return {
        gerado_em: new Date().toISOString(), dia_vendas: v.dia,
        categorias: [
            { id: 'vendas', titulo: 'Vendas', cor: '#30D158', itens: vendas },
            { id: 'ranking', titulo: 'Ranking ML', cor: '#BF5AF2', itens: ranking },
            { id: 'estoque', titulo: 'Inteligência de estoque', cor: '#FF9F0A', itens: estoque },
            { id: 'concorrentes', titulo: 'Concorrentes', cor: '#0A84FF', itens: concorrentes },
        ],
    };
}

async function planilha(tipo) {
    let linhas, nome;
    if (tipo === 'concorrentes') {
        nome = 'Concorrentes';
        linhas = tabelaConcorrentes().linhas.map(l => ({
            SKU: l.sku, Anúncio: l.item_id, Produto: l.titulo,
            MP: l.mp, PC: l.pc, 'DF%': l.df, 'RANK NUB': l.rank_nub,
        }));
    } else {
        const v = await tabelaVendas(false);
        nome = 'Vendas ' + v.dia;
        linhas = v.linhas.map(l => ({
            SKU: l.sku, Anúncio: l.item_id, Produto: l.titulo,
            'Vendas ontem': l.ontem, [`Média/dia (${v.base.nome})`]: l.media_dia, [`Vendas em ${v.base.nome}`]: l.vendas_mes,
            'Variação %': l.variacao == null ? null : Math.round(l.variacao * 100),
            'Ranking ML (página)': l.rank_ml ? l.rank_ml.pagina : null,
            'Ranking ML (posição)': l.rank_ml ? l.rank_ml.posicao : null,
            'Termo pesquisado': l.rank_ml ? l.rank_ml.termo : null,
            Situação: l.situacao,
        }));
    }
    const ws = XLSX.utils.json_to_sheet(linhas);
    ws['!cols'] = Object.keys(linhas[0] || { A: 1 }).map(k => ({ wch: k === 'Produto' ? 60 : Math.max(10, k.length + 2) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, nome.slice(0, 31));
    return { nome, buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) };
}

module.exports = { noticias, tabelaVendas, tabelaConcorrentes, planilha, vendasOntem, vendasMesAnterior };
