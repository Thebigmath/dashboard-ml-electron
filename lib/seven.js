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
    const linhas = produtos().map(p => {
        const ontem = o.porItem[p.item_id] || 0;
        const noMes = m.porItem[p.item_id] || 0;
        const media = noMes / m.dias;
        return {
            item_id: p.item_id, sku: p.sku, titulo: p.titulo, status: p.status,
            ontem, media_dia: +media.toFixed(2), vendas_mes: noMes,
            variacao: media > 0 ? +((ontem - media) / media).toFixed(3) : null,
            situacao: situacao(ontem, media, noMes), preco: p.preco || null,
        };
    });
    linhas.sort((a, b) => b.ontem - a.ontem || b.media_dia - a.media_dia);
    const totalOntem = linhas.reduce((s, l) => s + l.ontem, 0);
    const mediaTotal = linhas.reduce((s, l) => s + l.media_dia, 0);
    return {
        dia: o.dia, coletado_em: o.coletado_em, pedidos: o.pedidos,
        base: { mes: m.mes, nome: m.nome, dias: m.dias, pedidos: m.pedidos },
        resumo: {
            unidades_ontem: totalOntem,
            media_dia_base: +mediaTotal.toFixed(1),
            variacao: mediaTotal > 0 ? +((totalOntem - mediaTotal) / mediaTotal).toFixed(3) : null,
            venderam: linhas.filter(l => l.ontem > 0).length,
            nao_venderam: linhas.filter(l => l.situacao === 'Não vendeu').length,
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

async function noticias() {
    const f = feed.montar();
    const v = await tabelaVendas(false);
    const estoque = (f.prioridades || []).slice(0, 4).map(p => ({
        titulo: `${p.acao}${p.acao_detalhe ? ': ' + p.acao_detalhe : ''}`,
        texto: p.motivo || '',
        produto: `${p.sku} · ${p.titulo}`,
        valor: p.peso ? brl(p.peso) : '',
        link: '/feed',
    }));

    const naoVenderam = v.linhas.filter(l => l.situacao === 'Não vendeu').sort((a, b) => b.media_dia - a.media_dia);
    const acima = v.linhas.filter(l => l.situacao === 'Acima da média').sort((a, b) => (b.ontem - b.media_dia) - (a.ontem - a.media_dia));
    const r = v.resumo;
    const vendas = [{
        titulo: `Ontem: ${r.unidades_ontem} unidades vendidas`,
        texto: `Média de ${v.base.nome}: ${r.media_dia_base} por dia` + (r.variacao != null
            ? ` (${r.variacao >= 0 ? '+' : ''}${Math.round(r.variacao * 100)}%).` : '.'),
        produto: `${r.venderam} anúncios venderam · ${r.nao_venderam} que costumam vender não venderam`,
        valor: '', link: '#vendas',
    }];
    for (const l of naoVenderam.slice(0, 3)) {
        vendas.push({
            titulo: 'Não vendeu ontem', produto: `${l.sku} · ${l.titulo}`,
            texto: `Em ${v.base.nome} vendia ${l.media_dia.toFixed(1)} por dia (${l.vendas_mes} no mês).`,
            valor: '', link: '#vendas',
        });
    }
    for (const l of acima.slice(0, 2)) {
        vendas.push({
            titulo: `Vendeu ${l.ontem} ontem`, produto: `${l.sku} · ${l.titulo}`,
            texto: `Acima da média de ${v.base.nome}: ${l.media_dia.toFixed(1)} por dia.`, valor: '', link: '#vendas',
        });
    }

    const concorrentes = [{
        titulo: 'Análise de concorrentes em preparação',
        texto: 'Preço do concorrente, diferença % e ranking entram quando o Nubimetrics e o Mercado Turbo forem ligados.',
        produto: '', valor: '', link: '#concorrentes',
    }];

    return {
        gerado_em: new Date().toISOString(), dia_vendas: v.dia,
        categorias: [
            { id: 'estoque', titulo: 'Inteligência de estoque', cor: '#FF9F0A', itens: estoque },
            { id: 'vendas', titulo: 'Vendas', cor: '#30D158', itens: vendas },
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
