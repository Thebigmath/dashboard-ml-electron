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

// O campo "estoque" do motor soma o que esta disponivel no galpao com o que
// esta EM TRANSFERENCIA entre galpoes do ML. Para decidir, os dois nao valem o
// mesmo: transferencia ainda nao vende. Daqui para baixo, sempre separados.
const emTransito = (p) => Number(p.transferenciaMl || 0);
const disponivel = (p) => Math.max(0, Number(p.estoque || 0) - emTransito(p));
const un = (n) => `${n} ${n === 1 ? 'unidade' : 'unidades'}`;

// Os numeros que sustentam a decisao, cada um com a janela e a origem a mostra.
function metricas(p) {
    const m = [
        { rotulo: 'Vendas', valor: String(p.vendas30), nota: 'últimos 30 dias' },
        { rotulo: 'Média', valor: `${Number(p.mediaDia || 0).toFixed(1)}/dia`, nota: 'vendas ÷ 30' },
    ];
    m.push(p.eFull
        ? { rotulo: 'No galpão', valor: String(disponivel(p)), nota: 'disponível no Full' }
        : { rotulo: 'No anúncio', valor: String(p.estoque), nota: 'quantidade declarada' });
    if (emTransito(p) > 0) m.push({ rotulo: 'Em transferência', valor: String(emTransito(p)), nota: 'entre galpões do ML' });
    if ((p.bloqueado || 0) > 0) {
        m.push({ rotulo: 'Travado', valor: String(p.bloqueado), nota: (p.bloqueado_detalhe || []).map(d => d.status).join(', ') || 'retido pelo ML' });
    }
    if (p.cobertura > 0 && p.cobertura < 999) {
        m.push({ rotulo: 'Cobertura', valor: `${Math.round(p.cobertura)} d`, nota: 'no ritmo atual' });
    }
    if (p.preco) m.push({ rotulo: 'Preço', valor: 'R$ ' + Number(p.preco).toLocaleString('pt-BR', { maximumFractionDigits: 0 }), nota: 'do anúncio' });
    return m;
}

// ── as filas, em ordem de urgência ─────────────────────────────────────────
// Cada uma diz: por que existe, o que fazer e quanto custa ignorar.
const FILAS = [
    {
        id: 'travado',
        titulo: 'Travado no galpão',
        icone: 'bi-lock',
        cor: '#FF375F',
        porque: 'Mercadoria sua que está no Full mas o ML não põe à venda. Repor não resolve — só o ML liberando.',
        acao: (p) => ({
            verbo: 'Abrir chamado no ML',
            detalhe: `${un(p.bloqueado)} retidas em ${(p.bloqueado_detalhe || []).map(d => d.status).join(', ') || 'processo interno'}`,
            motivo: `O galpão tem a mercadoria, mas marcou como indisponível. Não é falta de estoque: é liberação.`,
        }),
        cabe: (p) => (p.bloqueado || 0) > 0,
        peso: (p) => (p.bloqueado || 0) * Number(p.preco || 0),
        rotuloPeso: 'retido × preço do anúncio',
    },
    {
        id: 'pausado_vendendo',
        titulo: 'Pausado vendendo',
        icone: 'bi-pause-circle',
        cor: '#FF9F0A',
        porque: 'Anúncio com venda comprovada, desligado. Cada dia parado é faturamento que não volta.',
        acao: (p) => {
            if (disponivel(p) > 0) {
                return { verbo: 'Reativar agora', detalhe: `${un(disponivel(p))} prontas no galpão`,
                    motivo: `Vendeu ${p.vendas30} un nos últimos 30 dias e está pausado com estoque disponível.` };
            }
            if (emTransito(p) > 0) {
                return { verbo: 'Aguardar a transferência', detalhe: `${un(emTransito(p))} a caminho do galpão`,
                    motivo: `Não dá para reativar ainda: o que existe está em transferência entre galpões do ML.` };
            }
            return { verbo: `Repor ${p.reposicao || Math.ceil((p.mediaDia || 0) * 30)} un.`, detalhe: 'e reativar o anúncio',
                motivo: `Vendia ${p.vendas30} un/mês (${Number(p.mediaDia || 0).toFixed(1)}/dia) e o galpão está zerado.` };
        },
        cabe: (p) => p.status === 'paused' && p.vendas30 > 0,
        peso: dinheiro,
        rotuloPeso: 'faturou nos últimos 30 dias',
    },
    {
        id: 'ruptura',
        titulo: 'Acaba em dias',
        icone: 'bi-hourglass-bottom',
        cor: '#FF9F0A',
        porque: 'Vendendo e com estoque para pouco tempo. Se não repuser, vira pausado na semana que vem.',
        acao: (p) => ({
            verbo: `Enviar ${p.reposicao || Math.ceil(p.mediaDia * 30)} un.`,
            detalhe: `o galpão acaba em ${Number(p.cobertura).toFixed(p.cobertura < 3 ? 1 : 0)} dias`,
            motivo: `${un(disponivel(p))} no galpão para um ritmo de ${Number(p.mediaDia || 0).toFixed(1)}/dia.`,
        }),
        cabe: (p) => p.status === 'active' && p.vendas30 > 0 && p.estoque > 0 && p.cobertura > 0 && p.cobertura <= COBERTURA_CURTA,
        peso: dinheiro,
        rotuloPeso: 'faturamento de 30 d em risco',
    },
    {
        id: 'zerado',
        titulo: 'Sem estoque, com venda',
        icone: 'bi-x-octagon',
        cor: '#FF375F',
        porque: 'Vendeu no último mês e está zerado. Ativo, mas sem nada para entregar.',
        acao: (p) => ({
            verbo: `Repor ${p.reposicao || Math.ceil((p.mediaDia || 0) * 30)} un.`,
            detalhe: emTransito(p) > 0 ? `${un(emTransito(p))} já em transferência` : 'anúncio ativo e sem estoque',
            motivo: `Vendeu ${p.vendas30} un nos últimos 30 dias e não tem o que entregar.`,
        }),
        cabe: (p) => p.status === 'active' && p.estoque <= 0 && p.vendas30 > 0,
        peso: dinheiro,
        rotuloPeso: 'faturou nos últimos 30 dias',
    },
    {
        id: 'capital_parado',
        titulo: 'Capital parado',
        icone: 'bi-cash-stack',
        cor: '#8A8E94',
        porque: 'Estoque no galpão sem nenhuma venda em 30 dias. Dinheiro imobilizado pagando armazenagem.',
        acao: (p) => ({
            verbo: 'Decidir o destino',
            detalhe: `${un(disponivel(p))} paradas — promoção, retirada ou revisão do anúncio`,
            motivo: `Nenhuma venda em 30 dias, com estoque no galpão pagando armazenagem.`,
        }),
        cabe: (p) => p.eFull && p.estoque > 0 && p.vendas30 === 0,
        peso: capital,
        rotuloPeso: 'estoque × preço do anúncio',
    },
    {
        id: 'excesso',
        titulo: 'Estoque demais',
        icone: 'bi-box-seam',
        cor: '#8A8E94',
        porque: 'Vende, mas o galpão tem estoque para meses. Sobra ocupando espaço e custo.',
        acao: (p) => ({
            verbo: 'Segurar a reposição',
            detalhe: `${un(disponivel(p))} cobrem ${Math.round(p.cobertura)} dias`,
            motivo: `Vende ${Number(p.mediaDia || 0).toFixed(1)}/dia; o galpão já tem estoque para meses.`,
        }),
        cabe: (p) => p.eFull && p.vendas30 > 0 && p.cobertura >= COBERTURA_EXCESSO && p.cobertura < 999,
        peso: capital,
        rotuloPeso: 'estoque × preço do anúncio',
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
                chave: x.chave || x.sku, item_id: x.item_id, sku: x.sku, titulo: x.titulo, status: x.status,
                estoque: x.estoque, disponivel: disponivel(x), em_transito: emTransito(x),
                preco: x.preco ?? null, vendas30: x.vendas30, media_dia: x.mediaDia,
                faturamento30: x.faturamento30, cobertura: x.cobertura, reposicao: x.reposicao,
                bloqueado: x.bloqueado || 0, bloqueado_detalhe: x.bloqueado_detalhe || [],
                eFull: x.eFull, curvaAbc: x.curvaAbc, link: x.permalink || '',
                peso: +x.peso.toFixed(2),
                acao: x.acao.verbo, acao_detalhe: x.acao.detalhe, motivo: x.acao.motivo,
                metricas: metricas(x),
            })),
        };
    }).filter(f => f.total > 0);

    return {
        gerado_em: new Date().toISOString(),
        coletado_em: (base && base.gerado_em) || coletadoEm('reposicao.json'),
        base_total: produtos.length,
        em_acao: filas.reduce((s, f) => s + f.total, 0),
        dinheiro_em_jogo: +filas.reduce((s, f) => s + f.dinheiro, 0).toFixed(2),
        prioridades: prioridades(filas, 10),
        filas,
    };
}

// A manhã: as N ações mais caras do dia inteiro, misturando as filas. É a
// primeira coisa da tela porque é a pergunta real de quem abre o app às 8h —
// "o que eu resolvo agora?" — e não "quantas filas existem".
function prioridades(filas, quantas = 10) {
    const todas = [];
    for (const f of filas) {
        for (const p of f.itens) {
            todas.push({ ...p, fila: f.id, fila_titulo: f.titulo, cor: f.cor, icone: f.icone, rotulo_peso: f.rotulo_peso });
        }
    }
    // dentro do mesmo dinheiro, urgência decide: travado e pausado vêm antes
    const urgencia = { travado: 0, zerado: 1, pausado_vendendo: 1, ruptura: 2, capital_parado: 3, excesso: 4 };
    return todas
        .sort((a, b) => b.peso - a.peso || (urgencia[a.fila] ?? 9) - (urgencia[b.fila] ?? 9))
        .slice(0, quantas)
        .map((p, i) => ({ ...p, posicao: i + 1 }));
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

module.exports = { montar, assinatura, prioridades, FILAS };
