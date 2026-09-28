// Seven: noticias urgentes, vendas de ontem x media e tabela de concorrentes.
//
// Le a coleta do Dashboard (reposicao.json) e busca no ML so o que ela nao tem:
// os pedidos de ontem. Concorrentes (PC, DF%, RANK NUB) dependem do Nubimetrics
// e do MT e ficam vazios ate essa parte ser ligada.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
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
    const termosOk = dados.resultados.filter(r => r.status === 'ok').map(r => r.termo);
    return {
        disponivel: true, coletado_em: dados.coletado_em || null, porItem, termosOk,
        termos: dados.termos || 0, feitos: (dados.resultados || []).filter(r => r.status === 'ok').length,
    };
}

// "Fora do ranking" so vale para produto que algum termo pesquisado descreve;
// sem isso, todo anuncio sem termo pareceria fora da busca.
const palavras = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/).filter(w => w.length > 1);
function coberto(titulo, termos) {
    const tt = new Set(palavras(titulo));
    return termos.some(ws => ws.length && ws.every(w => tt.has(w)));
}

// Concorrentes (PC, DF%, RANK NUB): o Dashboard NAO chama o Nubimetrics. Quem consulta e o
// Astra (seven/sala_de_maquinas, via MCP); aqui so lemos o que ele exporta (astra_v2.py exportar).
// Cada grupo de concorrencia do Nubimetrics e um produto ("TAPETE BANDEJA TORO"): o grupo vale
// para o anuncio cujo titulo tem todas as palavras do nome; entre varios anuncios nossos no
// grupo, o preco diz qual e qual.
const CONCORRENTES_PADRAO = 'C:/Users/Matheus Prata/Documents/business_Intelligence/seven/saidas/astra_concorrentes.json';
const MARCA_CONTA = 'STOCK';   // vendedor desta conta no Nubimetrics

function concorrentesAstra() {
    const cfg = lerJson(path.join(STORAGE, 'config.json'), {});
    const d = lerJson(cfg.concorrentes_arquivo || CONCORRENTES_PADRAO, null);
    if (!d || !Array.isArray(d.grupos)) return { disponivel: false, grupos: [] };
    return { disponivel: true, gerado_em: d.gerado_em, grupos: d.grupos, sem_dado: (d.grupos_sem_dado || []).length };
}

// Normaliza titulo para comparar com o do Nubimetrics (que vem cortado em ~40 caracteres).
const normTit = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function grupoDoAnuncio(p, grupos) {
    // 1) Pelo titulo do NOSSO anuncio que o Nubimetrics devolveu no grupo (mesma conta, preco mais proximo).
    const tp = normTit(p.titulo);
    let melhor = null;
    for (const g of grupos) {
        for (const x of g.nossos || []) {
            if (!String(x.vendedor || '').toUpperCase().includes(MARCA_CONTA)) continue;
            const tx = normTit(x.titulo);
            if (!tx || tx.length < 15 || !(tp.startsWith(tx) || tx.startsWith(tp))) continue;
            const dif = p.preco && x.preco ? Math.abs(x.preco - p.preco) / p.preco : 1;
            if (!melhor || dif < melhor.dif) melhor = { g, x, dif };
        }
    }
    if (melhor) {
        const g = melhor.g;
        return { grupo: g.grupo, group_id: g.group_id, dados_de: g.dados_de, anuncios: g.anuncios,
                 rank: melhor.x.posicao, lider: g.lider_concorrente };
    }
    // 2) Pelas palavras do nome do grupo.
    const tt = new Set(palavras(p.titulo));
    const candidatos = grupos.filter(g => { const w = palavras(g.grupo); return w.length && w.every(x => tt.has(x)); });
    if (!candidatos.length) return null;
    // o grupo mais especifico (mais palavras) vence
    const g = candidatos.sort((a, b) => palavras(b.grupo).length - palavras(a.grupo).length)[0];
    const meus = (g.nossos || []).filter(x => String(x.vendedor || '').toUpperCase().includes(MARCA_CONTA));
    const porPreco = p.preco ? meus.find(x => x.preco && Math.abs(x.preco - p.preco) / p.preco < 0.02) : null;
    const eu = porPreco || meus[0] || null;
    return { grupo: g.grupo, group_id: g.group_id, dados_de: g.dados_de, anuncios: g.anuncios,
             rank: eu ? eu.posicao : null, lider: g.lider_concorrente };
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
    const termosPalavras = (rk.termosOk || []).map(palavras);
    const linhas = lista.map(p => {
        const ontem = o.porItem[p.item_id] || 0;
        const noMes = m.porItem[p.item_id] || 0;
        const media = noMes / m.dias;
        return {
            item_id: p.item_id, sku: p.sku, titulo: p.titulo, status: p.status,
            chave: p.chave || p.sku, eFull: p.eFull, curvaAbc: p.curvaAbc, link: p.permalink || null,
            ontem, media_dia: +media.toFixed(2), vendas_mes: noMes,
            variacao: media > 0 ? +((ontem - media) / media).toFixed(3) : null,
            situacao: situacao(ontem, media, noMes), preco: p.preco || null,
            rank_ml: rk.porItem[p.item_id] || null,
            coberto: !!rk.porItem[p.item_id] || coberto(p.titulo, termosPalavras),
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
    const ca = concorrentesAstra();
    const linhas = produtos().filter(p => p.status === 'active').map(p => {
        const g = ca.disponivel ? grupoDoAnuncio(p, ca.grupos) : null;
        const pc = g && g.lider ? g.lider.preco : null;
        // sem preco no arquivo de estoque: preco medio dos ultimos 30 dias
        const mp = p.preco || (p.vendas30 ? +(p.faturamento30 / p.vendas30).toFixed(2) : null);
        return {
            item_id: p.item_id, sku: p.sku, titulo: p.titulo, chave: p.chave || p.sku, eFull: p.eFull,
            curvaAbc: p.curvaAbc, link: p.permalink || null, vendas30: p.vendas30 || 0,
            mp,                                                    // meu preco
            pc,                                                    // preco do concorrente que mais vende no grupo
            df: pc && mp ? +(((mp - pc) / pc) * 100).toFixed(1) : null,   // diferenca % (MP x PC)
            rank_nub: g ? g.rank : null,                           // nossa posicao no grupo (vendas)
            grupo: g ? g.grupo : null, group_id: g ? g.group_id : null, grupo_anuncios: g ? g.anuncios : null,
            lider: g && g.lider ? g.lider.vendedor : null, lider_vendas: g && g.lider ? g.lider.vendas : null,
            dados_de: g ? g.dados_de : null,
        };
    });
    linhas.sort((a, b) => (a.rank_nub == null) - (b.rank_nub == null) || (b.mp || 0) - (a.mp || 0));
    return {
        fonte: 'Astra (Nubimetrics via MCP)', disponivel: ca.disponivel, gerado_em: ca.gerado_em || null,
        grupos_com_dado: ca.grupos.length, grupos_sem_dado: ca.sem_dado || 0,
        com_rank: linhas.filter(l => l.rank_nub).length, linhas,
    };
}

const brl = (v) => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 });

const pct = (v) => (v >= 0 ? '+' : '') + Math.round(v * 100) + '%';
const nomeCurto = (l) => `${l.sku} · ${l.titulo}`;

async function noticias() {
    const v = await tabelaVendas(false);
    const r = v.resumo;
    const L = v.linhas;

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
            { id: 'concorrentes', titulo: 'Concorrentes', cor: '#0A84FF', itens: concorrentes },
        ],
    };
}

// Feed do Seven: mesmo formato do Feed de estoque (lib/feed.js), para a tela
// feed.html desenhar igual - capa "Mais urgentes", bolhas, folha em tela cheia.
const num = (v, casas = 1) => Number(v || 0).toFixed(casas).replace('.', ',');

function cardVenda(l, base, extra) {
    const m = [
        { rotulo: 'Ontem', valor: String(l.ontem), nota: 'unidades vendidas' },
        { rotulo: 'Média', valor: `${num(l.media_dia)}/dia`, nota: `em ${base.nome}` },
        { rotulo: `Em ${base.nome}`, valor: String(l.vendas_mes), nota: 'unidades no mês' },
        l.rank_ml
            ? { rotulo: 'Ranking ML', valor: `${l.rank_ml.posicao}º`, nota: `pág. ${l.rank_ml.pagina} · "${l.rank_ml.termo}"` }
            : { rotulo: 'Ranking ML', valor: '—', nota: 'fora das 3 primeiras páginas' },
    ];
    if (l.preco) m.push({ rotulo: 'Preço', valor: 'R$ ' + Number(l.preco).toLocaleString('pt-BR', { maximumFractionDigits: 0 }), nota: 'do anúncio' });
    return {
        chave: l.chave, item_id: l.item_id, sku: l.sku, titulo: l.titulo, eFull: l.eFull, curvaAbc: l.curvaAbc,
        link: l.link, metricas: m, ...extra,
    };
}

// Noticias do Seven: so ANUNCIOS (a partir do Ranking ML) e CONCORRENTES (a partir
// do ranking do Nubimetrics, quando ligado). Estoque fica no Feed; vendas, na tabela.
const FILAS_SEVEN = [
    {
        id: 'fora_ranking', titulo: 'Fora do ranking', icone: 'bi-search', cor: '#BF5AF2',
        porque: 'Vende e tem termo de busca, mas não aparece nas 3 primeiras páginas. Subir na busca é venda a mais.',
        rotulo_peso: 'faturamento do mês passado',
        cabe: (l) => l.coberto && !l.rank_ml && l.vendas_mes > 0,
        montar: (l, b) => cardVenda(l, b, {
            peso: l.vendas_mes * (l.preco || 0),
            acao: 'Melhorar a posição na busca', acao_detalhe: 'fora das 3 primeiras páginas',
            motivo: `Vendeu ${l.vendas_mes} em ${b.nome} mesmo sem aparecer: título, preço e frete podem trazê-lo para a 1ª página.`,
        }),
    },
    {
        id: 'bem_posicionado', titulo: 'Na 1ª página sem venda', icone: 'bi-eye', cor: '#FF9F0A',
        porque: 'Está bem posicionado na busca e mesmo assim não vendeu ontem. O comprador vê e não compra.',
        rotulo_peso: 'faturamento de 30 dias em risco',
        cabe: (l) => l.rank_ml && l.rank_ml.pagina === 1 && l.ontem === 0 && l.media_dia >= 0.3,
        montar: (l, b) => cardVenda(l, b, {
            peso: l.media_dia * 30 * (l.preco || 0),
            acao: 'Revisar preço e anúncio', acao_detalhe: `${l.rank_ml.posicao}º na busca e zerou ontem`,
            motivo: `Aparece em "${l.rank_ml.termo}", mas não converteu: compare preço e frete com quem está à frente.`,
        }),
    },
    {
        id: 'quase_primeira', titulo: 'Quase na 1ª página', icone: 'bi-arrow-up-circle', cor: '#0A84FF',
        porque: 'Já vende e está na 2ª ou 3ª página. Um ajuste pode levá-lo para a 1ª, onde está a maior parte das vendas.',
        rotulo_peso: 'faturamento do mês passado',
        cabe: (l) => l.rank_ml && l.rank_ml.pagina >= 2 && l.vendas_mes > 0,
        montar: (l, b) => cardVenda(l, b, {
            peso: l.vendas_mes * (l.preco || 0),
            acao: 'Subir para a 1ª página', acao_detalhe: `${l.rank_ml.posicao}º na busca (pág. ${l.rank_ml.pagina})`,
            motivo: `Em "${l.rank_ml.termo}" já vendeu ${l.vendas_mes} em ${b.nome} fora da 1ª página: título, preço e frete fazem diferença aqui.`,
        }),
    },
];

function filaConcorrentes() {
    const c = tabelaConcorrentes();
    const itens = c.linhas.filter(l => l.rank_nub && l.rank_nub > 1 && l.pc).map(l => ({
        chave: l.chave, item_id: l.item_id, sku: l.sku, titulo: l.titulo, eFull: l.eFull, curvaAbc: l.curvaAbc, link: l.link,
        peso: (l.vendas30 || 0) * (l.mp || 0),
        acao: 'Disputar a liderança', acao_detalhe: `${l.rank_nub}º no grupo "${l.grupo}"`,
        motivo: `Quem lidera é ${l.lider} a R$ ${Number(l.pc).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` +
            (l.df != null ? ` — o nosso está ${l.df > 0 ? l.df + '% acima' : Math.abs(l.df) + '% abaixo'}.` : '.'),
        metricas: [
            { rotulo: 'RANK NUB', valor: `${l.rank_nub}º`, nota: `de ${l.grupo_anuncios} no grupo` },
            { rotulo: 'MP', valor: 'R$ ' + Number(l.mp || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 }), nota: 'meu preço' },
            { rotulo: 'PC', valor: 'R$ ' + Number(l.pc).toLocaleString('pt-BR', { maximumFractionDigits: 0 }), nota: `${l.lider}` },
            { rotulo: 'DF%', valor: l.df == null ? '—' : (l.df > 0 ? '+' : '') + l.df + '%', nota: 'MP x PC' },
        ],
    })).sort((a, b) => b.peso - a.peso);
    if (!itens.length) return null;
    return { id: 'concorrentes', titulo: 'Concorrentes', icone: 'bi-people', cor: '#FF375F',
        porque: 'No grupo de concorrência do Nubimetrics, alguém vende mais do que nós. Preço e anúncio do líder são a referência.',
        rotulo_peso: 'faturamento de 30 dias', total: itens.length, dinheiro: itens.reduce((s, p) => s + p.peso, 0), itens };
}

async function feedSeven() {
    const v = await tabelaVendas(false);
    const filas = [];
    for (const F of FILAS_SEVEN) {
        // sem coleta de ranking, todo anuncio pareceria 'fora do ranking'
        if (!v.ranking_ml.disponivel) continue;
        const itens = v.linhas.filter(F.cabe).map(l => F.montar(l, v.base)).sort((a, b) => b.peso - a.peso);
        if (!itens.length) continue;
        filas.push({ id: F.id, titulo: F.titulo, icone: F.icone, cor: F.cor, porque: F.porque, rotulo_peso: F.rotulo_peso,
            total: itens.length, dinheiro: itens.reduce((s, p) => s + p.peso, 0), itens });
    }
    const fc = filaConcorrentes();
    if (fc) filas.push(fc);
    // capa: as 10 mais caras de todas as filas, sem repetir anuncio
    const todas = filas.flatMap(f => f.itens.map(p => ({ ...p, cor: f.cor, icone: f.icone, fila_titulo: f.titulo, rotulo_peso: f.rotulo_peso })));
    const vistos = new Set();
    const prioridades = todas.sort((a, b) => b.peso - a.peso).filter(p => !vistos.has(p.item_id) && vistos.add(p.item_id)).slice(0, 10)
        .map((p, i) => ({ ...p, posicao: i + 1 }));
    return {
        gerado_em: new Date().toISOString(), coletado_em: v.coletado_em,
        base_total: v.linhas.length, em_acao: filas.reduce((s, f) => s + f.total, 0),
        dinheiro_em_jogo: filas.reduce((s, f) => s + f.dinheiro, 0),
        dia_vendas: v.dia, ranking_ml: v.ranking_ml, prioridades, filas,
    };
}

// Planilhas do Seven, formatadas (ExcelJS): titulo, cabecalho azul, filtro,
// cabecalho congelado, numeros com formato e situacao colorida.
const ExcelJS = require('exceljs');
const AZUL = 'FF1F3864';
const COR_SITUACAO = {
    'Acima da média': 'FF1E8E3E', 'Na média': 'FF6E6E73', 'Abaixo da média': 'FFB25E00',
    'Não vendeu': 'FFC62828', 'Sem giro': 'FF8E8E93', 'Vendeu (raro)': 'FF0277BD', 'Sem base no mês': 'FF7B1FA2',
};

function montarAba(wb, nomeAba, titulo, subtitulo, colunas, linhas) {
    const ws = wb.addWorksheet(nomeAba.slice(0, 31), { views: [{ state: 'frozen', ySplit: 3 }] });
    ws.columns = colunas.map(c => ({ key: c.key, width: c.largura }));
    const ultima = String.fromCharCode(64 + colunas.length);

    ws.mergeCells(`A1:${ultima}1`);
    ws.getCell('A1').value = titulo;
    ws.getCell('A1').font = { name: 'Arial', size: 14, bold: true, color: { argb: AZUL } };
    ws.getRow(1).height = 24;
    ws.mergeCells(`A2:${ultima}2`);
    ws.getCell('A2').value = subtitulo;
    ws.getCell('A2').font = { name: 'Arial', size: 9, italic: true, color: { argb: 'FF6E6E73' } };

    const cab = ws.getRow(3);
    colunas.forEach((c, i) => { cab.getCell(i + 1).value = c.titulo; });
    cab.height = 30;
    cab.eachCell(cell => {
        cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AZUL } };
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });

    linhas.forEach((l, idx) => {
        const row = ws.addRow(colunas.map(c => l[c.key] ?? null));
        row.eachCell({ includeEmpty: true }, (cell, n) => {
            const c = colunas[n - 1];
            cell.font = { name: 'Arial', size: 10 };
            cell.border = { bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } } };
            if (idx % 2) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF6F8FB' } };
            if (c.formato) cell.numFmt = c.formato;
            if (c.alinhar) cell.alignment = { horizontal: c.alinhar };
            if (c.estilo) c.estilo(cell, l);
        });
    });
    ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: colunas.length } };
    return ws;
}

const corVariacao = (cell) => {
    if (typeof cell.value === 'number') cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: cell.value >= 0 ? 'FF1E8E3E' : 'FFC62828' } };
};
const corSituacao = (cell) => {
    const cor = COR_SITUACAO[cell.value];
    if (cor) cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: cor } };
};

async function planilha(tipo) {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'SEVEN';
    let nome;
    if (tipo === 'concorrentes') {
        nome = 'Concorrentes';
        const c = tabelaConcorrentes();
        montarAba(wb, 'Concorrentes', 'SEVEN · Análise de concorrentes',
            `Gerado em ${new Date().toLocaleString('pt-BR')} · dados do Astra de ${c.gerado_em || '-'} · MP = meu preço · PC = preço do concorrente que mais vende no grupo · DF% = MP x PC · RANK NUB = nossa posição no grupo`,
            [
                { key: 'sku', titulo: 'SKU', largura: 22 },
                { key: 'item_id', titulo: 'Anúncio', largura: 17 },
                { key: 'titulo', titulo: 'Produto', largura: 70 },
                { key: 'mp', titulo: 'MP', largura: 14, formato: '"R$" #,##0.00' },
                { key: 'pc', titulo: 'PC', largura: 14, formato: '"R$" #,##0.00' },
                { key: 'df', titulo: 'DF%', largura: 10, formato: '0.0%', estilo: corVariacao },
                { key: 'rank_nub', titulo: 'RANK NUB', largura: 11, alinhar: 'center' },
                { key: 'lider', titulo: 'Líder do grupo', largura: 24 },
                { key: 'grupo', titulo: 'Grupo Nubimetrics', largura: 30 },
            ],
            c.linhas.map(l => ({ ...l, df: l.df == null ? null : l.df / 100 })));
    } else {
        const v = await tabelaVendas(false);
        nome = 'Vendas ' + v.dia;
        const r = v.resumo;
        const diaBR = v.dia.split('-').reverse().join('/');
        montarAba(wb, 'Vendas ' + v.dia, `SEVEN · Vendas de ${diaBR} x ${v.base.nome}`,
            `${r.unidades_ontem} unidades ontem · média de ${v.base.nome}: ${r.media_dia_base}/dia` +
            (r.variacao != null ? ` (${r.variacao >= 0 ? '+' : ''}${Math.round(r.variacao * 100)}%)` : '') +
            (v.ranking_ml.disponivel ? ` · Ranking ML de ${v.ranking_ml.coletado_em}` : ' · Ranking ML ainda não coletado'),
            [
                { key: 'sku', titulo: 'SKU', largura: 22 },
                { key: 'item_id', titulo: 'Anúncio', largura: 17 },
                { key: 'titulo', titulo: 'Produto', largura: 70 },
                { key: 'ontem', titulo: 'Vendas ontem', largura: 12, alinhar: 'center' },
                { key: 'media_dia', titulo: `Média/dia (${v.base.nome})`, largura: 14, formato: '0.0' },
                { key: 'vendas_mes', titulo: `Vendas em ${v.base.nome}`, largura: 14, alinhar: 'center' },
                { key: 'variacao', titulo: 'Variação', largura: 11, formato: '+0%;-0%;0%', estilo: corVariacao },
                { key: 'rank_pagina', titulo: 'Ranking ML (página)', largura: 12, alinhar: 'center' },
                { key: 'rank_posicao', titulo: 'Ranking ML (posição)', largura: 12, alinhar: 'center' },
                { key: 'rank_termo', titulo: 'Termo pesquisado', largura: 34 },
                { key: 'situacao', titulo: 'Situação', largura: 17, estilo: corSituacao },
            ],
            v.linhas.map(l => ({
                ...l,
                rank_pagina: l.rank_ml ? l.rank_ml.pagina : (l.coberto ? 'fora' : null),
                rank_posicao: l.rank_ml ? l.rank_ml.posicao : null,
                rank_termo: l.rank_ml ? l.rank_ml.termo : null,
            })));
    }
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    return { nome, buffer };
}

module.exports = { feedSeven, noticias, tabelaVendas, tabelaConcorrentes, planilha, vendasOntem, vendasMesAnterior };
