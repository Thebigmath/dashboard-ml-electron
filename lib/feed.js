// Feed de ações de estoque: o que precisa de decisão SUA, hoje, e mais nada.
//
// A tela de reposição mostra 788 linhas; nenhuma delas diz "faça isto agora".
// Aqui o trabalho é o inverso: classificar tudo em poucas filas de AÇÃO, e
// dentro de cada fila ordenar pelo dinheiro em jogo. O que não muda decisão
// não aparece.
//
// Fonte: reposicao.json, que o motor já produz (vendas 30 d, estoque do galpão,
// status, cobertura). Nenhuma chamada nova à API — por isso abre instantâneo.
// Só o "travado no galpão" precisa de dado fresco, e vem da mesma coleta.
//
// O corte por dinheiro é o filtro: um anúncio que fatura R$ 40/mês parado não
// merece o seu tempo; um de R$ 18 mil, sim.
const fs = require('fs');
const path = require('path');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');

// Abaixo disso não vale sua atenção (por mês, em faturamento ou capital parado).
const MIN_FATURAMENTO = 300;
const MIN_CAPITAL = 500;
const COBERTURA_CURTA = 12;    // dias: ruptura à vista
const COBERTURA_EXCESSO = 120; // dias: dinheiro demais no galpão

function lerJson(arquivo, padrao) {
    try { return JSON.parse(fs.readFileSync(path.join(STORAGE, arquivo), 'utf8')); } catch { return padrao; }
}

// reposicao.json e um array puro (sem cabecalho), entao a hora da coleta vem da
// data de modificacao do arquivo.
function coletadoEm(arquivo) {
    try { return fs.statSync(path.join(STORAGE, arquivo)).mtime.toISOString(); } catch { return null; }
}

const dinheiro = (p) => Number(p.faturamento30 || 0);
const capital = (p) => Number(p.estoque || 0) * Number(p.preco || 0);

// ── as filas, em ordem de urgência ─────────────────────────────────────────
// Cada uma diz: por que existe, o que fazer e quanto custa ignorar.
const FILAS = [
    {
        id: 'travado',
        titulo: 'Travado no galpão',
        icone: 'bi-lock',
        cor: '#FF375F',
        porque: 'Mercadoria sua que está no Full mas o ML não põe à venda. Repor não resolve — só o ML liberando.',
        acao: (p) => `Abrir chamado no ML: ${p.bloqueado} un. em ${(p.bloqueado_detalhe || []).map(d => d.status).join(', ') || 'processo interno'}`,
        cabe: (p) => (p.bloqueado || 0) > 0,
        peso: (p) => (p.bloqueado || 0) * Number(p.preco || 0),
        rotuloPeso: 'parado no galpão',
    },
    {
        id: 'pausado_vendendo',
        titulo: 'Pausado vendendo',
        icone: 'bi-pause-circle',
        cor: '#FF9F0A',
        porque: 'Anúncio com venda comprovada, desligado. Cada dia parado é faturamento que não volta.',
        acao: (p) => p.estoque > 0
            ? `Reativar agora: tem ${p.estoque} un. no galpão`
            : `Repor e reativar: vendia ${p.vendas30} un/mês`,
        cabe: (p) => p.status === 'paused' && p.vendas30 > 0,
        peso: dinheiro,
        rotuloPeso: 'faturava por mês',
    },
    {
        id: 'ruptura',
        titulo: 'Acaba em dias',
        icone: 'bi-hourglass-bottom',
        cor: '#FF9F0A',
        porque: 'Vendendo e com estoque para pouco tempo. Se não repuser, vira pausado na semana que vem.',
        acao: (p) => `Enviar ~${p.reposicao || Math.ceil(p.mediaDia * 30)} un. (acaba em ${p.cobertura} dias)`,
        cabe: (p) => p.status === 'active' && p.vendas30 > 0 && p.estoque > 0 && p.cobertura > 0 && p.cobertura <= COBERTURA_CURTA,
        peso: dinheiro,
        rotuloPeso: 'faturamento em risco',
    },
    {
        id: 'zerado',
        titulo: 'Sem estoque, com venda',
        icone: 'bi-x-octagon',
        cor: '#FF375F',
        porque: 'Vendeu no último mês e está zerado. Ativo, mas sem nada para entregar.',
        acao: (p) => `Repor ${p.reposicao || Math.ceil((p.mediaDia || 0) * 30)} un. — vendeu ${p.vendas30} em 30 d`,
        cabe: (p) => p.status === 'active' && p.estoque <= 0 && p.vendas30 > 0,
        peso: dinheiro,
        rotuloPeso: 'faturava por mês',
    },
    {
        id: 'capital_parado',
        titulo: 'Capital parado',
        icone: 'bi-cash-stack',
        cor: '#8A8E94',
        porque: 'Estoque no galpão sem nenhuma venda em 30 dias. Dinheiro imobilizado pagando armazenagem.',
        acao: (p) => `Decidir: promoção, retirada ou revisão do anúncio (${p.estoque} un. paradas)`,
        cabe: (p) => p.eFull && p.estoque > 0 && p.vendas30 === 0,
        peso: capital,
        rotuloPeso: 'imobilizado',
    },
    {
        id: 'excesso',
        titulo: 'Estoque demais',
        icone: 'bi-box-seam',
        cor: '#8A8E94',
        porque: 'Vende, mas o galpão tem estoque para meses. Sobra ocupando espaço e custo.',
        acao: (p) => `Segurar reposição: ${p.estoque} un. cobrem ${Math.round(p.cobertura)} dias`,
        cabe: (p) => p.eFull && p.vendas30 > 0 && p.cobertura >= COBERTURA_EXCESSO && p.cobertura < 999,
        peso: capital,
        rotuloPeso: 'imobilizado',
    },
];

// Empilhadeira sai do feed: é outro negócio, com outro giro.
const carroToyota = /corolla|hilux|yaris|etios|sw4|rav4|hiace|prius|fielder/i;
function ehEmpilhadeira(p) {
    const t = (p.titulo || '').toLowerCase();
    if (/empilhadeira|hyster|yale|bobcat|forklift|trator|clark|linde|paleteira|transpaleteira|hangcha/.test(t)) return true;
    if (/toyota/.test(t) && !carroToyota.test(t)) return true;
    return /^bf/.test((p.sku || '').toLowerCase());
}

/** Monta o feed. Rápido: lê o que o motor já coletou, não chama a API. */
function montar({ incluirEmpilhadeira = false } = {}) {
    const base = lerJson('reposicao.json', null);
    const produtos = (base && (base.produtos || base)) || [];
    const lista = produtos.filter(p => incluirEmpilhadeira || !ehEmpilhadeira(p));

    const vistos = new Set();
    const filas = FILAS.map(f => {
        const itens = lista
            .filter(p => !vistos.has(p.item_id) && f.cabe(p))
            .map(p => ({ ...p, peso: f.peso(p), acao: f.acao(p) }))
            // o corte é o "bot": o que não move dinheiro não entra
            .filter(x => x.peso >= (f.id === 'capital_parado' || f.id === 'excesso' ? MIN_CAPITAL : MIN_FATURAMENTO))
            .sort((a, b) => b.peso - a.peso);
        // cada produto aparece numa fila só, a mais urgente — senão o mesmo
        // anúncio pipoca em três listas e a tela perde o sentido de prioridade
        for (const x of itens) vistos.add(x.item_id);
        return {
            id: f.id, titulo: f.titulo, icone: f.icone, cor: f.cor, porque: f.porque,
            rotulo_peso: f.rotuloPeso, total: itens.length,
            dinheiro: +itens.reduce((s, x) => s + x.peso, 0).toFixed(2),
            itens: itens.map(x => ({
                item_id: x.item_id, sku: x.sku, titulo: x.titulo, status: x.status,
                estoque: x.estoque, preco: x.preco ?? null, vendas30: x.vendas30,
                faturamento30: x.faturamento30, cobertura: x.cobertura, reposicao: x.reposicao,
                bloqueado: x.bloqueado || 0, bloqueado_detalhe: x.bloqueado_detalhe || [],
                eFull: x.eFull, curvaAbc: x.curvaAbc, link: x.permalink || '',
                peso: +x.peso.toFixed(2), acao: x.acao,
            })),
        };
    }).filter(f => f.total > 0);

    return {
        gerado_em: new Date().toISOString(),
        coletado_em: (base && base.gerado_em) || coletadoEm('reposicao.json'),
        base_total: produtos.length,
        em_acao: filas.reduce((s, f) => s + f.total, 0),
        dinheiro_em_jogo: +filas.reduce((s, f) => s + f.dinheiro, 0).toFixed(2),
        filas,
    };
}

/** Assinatura do estado: muda quando há novidade de verdade (para o auto-reload). */
function assinatura() {
    const f = montar();
    return {
        coletado_em: f.coletado_em,
        chave: f.filas.map(x => `${x.id}:${x.total}:${Math.round(x.dinheiro)}`).join('|'),
        em_acao: f.em_acao,
    };
}

module.exports = { montar, assinatura, FILAS };
