// Analise com IA do SEVEN, via Ollama rodando na propria maquina.
// Sem chave de API, sem custo e sem dado saindo daqui.
//
//   Dashboard --(HTTP 127.0.0.1:11434)--> Ollama --> llama3.2
//   (a tela "Análise com IA" pede a pergunta; os numeros entram prontos e pequenos:
//    seven.js ja agrega tudo, aqui so vira texto. Modelo pequeno nao aguenta 300 linhas.)
//
// Decisoes que valem enquanto o hardware for este (i5 de notebook, sem GPU, ~15 GB RAM):
//   num_ctx 4096 + keep_alive 0 -> o modelo para de segurar 2,5 GB entre uma pergunta e outra.
//   stream:true                 -> a maquina faz ~3 tokens/s; sem stream a tela congela ~30 s.
//   num_predict limitado        -> 3B sem limite inventa continuacao em vez de responder.
//   temperatura baixa           -> analise de dado pede resposta estavel, nao texto criativo.
const { Readable } = require('stream');
const seven = require('./seven');

const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const MODELO_PADRAO = process.env.OLLAMA_MODELO || 'llama3.2';
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX) || 4096;
// teto de tokens por resposta: a maquina faz ~3 tokens/s, entao cada token a mais
// sao ~0,3 s de espera. 320 evita a resposta de 2 min cortada no meio sem virar um tidaco.
const NUM_PREDICT = Number(process.env.OLLAMA_NUM_PREDICT) || 320;
// 0 = o modelo descarrega depois de cada resposta (libera 2,5 GB, mas a proxima pergunta paga ~80 s
// de carga). 90s = fica quente enquanto a pessoa le a resposta e solta a RAM se ela sair da tela.
const KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '90s';
const TIMEOUT_ESTADO = 4000;

const SISTEMA = [
    'Voce e o analista da Seven, loja de autopeças no Mercado Livre com duas contas: Flavia e Cordeiro.',
    'Responda em português do Brasil, direto ao ponto, sem tratamento inicial.',
    'Use SOMENTE os números do bloco DADOS. Nunca invente número, produto, preço ou nome.',
    'Quando o dado não existir, escreva "sem dado" e não estime.',
    'Se a resposta for uma decisão, termine com uma recomendação em uma frase.',
].join(' ');

// ---------- estado do Ollama ----------

async function estado() {
    const t0 = Date.now();
    try {
        const ctrl = AbortSignal.timeout(TIMEOUT_ESTADO);          // ollama pode estar desligado
        const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: ctrl });
        if (!r.ok) throw new Error(`respondeu ${r.status}`);
        const d = await r.json();
        const modelos = (d.models || []).map(m => ({
            nome: m.name, gb: +(m.size / 1e9).toFixed(2), familia: (m.details || {}).parameter_family || null,
        }));
        return {
            online: true, url: OLLAMA_URL, ms: Date.now() - t0, modelos,
            modelo: modelos.find(m => m.nome.startsWith(MODELO_PADRAO))?.nome || modelos[0]?.nome || null,
            limite: { num_ctx: NUM_CTX, num_predict: NUM_PREDICT, keep_alive: KEEP_ALIVE },
            aviso: 'Sem GPU: a primeira pergunta demora mais (carrega o modelo) e cada resposta leva dezenas de segundos.',
        };
    } catch (e) {
        return { online: false, url: OLLAMA_URL, erro: String(e.message || e), modelos: [], modelo: null };
    }
}

// ---------- contexto: os numeros, prontos e pequenos ----------

const num = (v, c = 2) => (v == null || v === '' ? 'sem dado' : Number(v).toLocaleString('pt-BR', { maximumFractionDigits: c }));
const pct = (v) => (v == null ? 'sem dado' : `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`);

async function contexto({ vendas = 14, concorrentes = 12 } = {}) {
    // Cada bloco e independente: sem token do ML, sem dado do Astra ou sem reposicao.json a tela
    // ainda precisa responder, so que honestamente ("sem dado"), em vez de estourar erro.
    let v = null; let c = null; let s = null; const falhas = [];
    try { v = await seven.tabelaVendas(false); } catch (e) { falhas.push('vendas: ' + (e.message || e)); }
    try { c = seven.tabelaConcorrentes(); } catch (e) { falhas.push('concorrentes: ' + (e.message || e)); }
    try { s = await saude(); } catch (e) { falhas.push('saude: ' + (e.message || e)); }

    const L = [];

    L.push('VENDAS');
    if (v) {
        L.push(`(dia ${v.dia || '-'} x media do mes ${v.base?.mes || '-'}, ${v.base?.dias || '?'} dias)`);
        L.push(`Ontem: ${num(v.resumo.unidades_ontem, 0)} un | media/dia da base: ${num(v.resumo.media_dia_base, 1)} un | `
            + `variacao: ${pct(v.resumo.variacao)} | venderam ${v.resumo.venderam}, nao venderam ${v.resumo.nao_venderam}`);
        L.push(`Ranking ML: ${v.ranking_ml.disponivel ? `${v.ranking_ml.feitos}/${v.ranking_ml.termos} termos, ${v.resumo.rankeados} anuncios com posicao, ${v.resumo.pagina1} na pagina 1` : 'nao coletado'}`);
        for (const l of v.linhas.slice(0, vendas)) {
            L.push(`- ${l.sku} ${l.titulo} | ontem ${num(l.ontem, 0)} | media/dia ${num(l.media_dia, 2)} | mes ${num(l.vendas_mes, 0)}`
                + ` | ${l.situacao} | preco ${num(l.preco)} | rank ML ${l.rank_ml ? l.rank_ml.posicao + (l.rank_ml.pagina ? ' (p' + l.rank_ml.pagina + ')' : '') : 'sem dado'}`);
        }
    } else L.push('sem dado (nao deu para ler as vendas)');

    L.push('');
    L.push('CONCORRENTES');
    if (c) {
        L.push(`(${c.fonte}, dados de ${c.gerado_em || 'sem dado'})`);
        L.push(c.disponivel
            ? `Grupos com dado: ${c.grupos_com_dado} | sem dado: ${c.grupos_sem_dado} | anuncios com nossa posicao: ${c.com_rank}`
            : 'Nubimetrics ainda nao exportou nada (rode o Astra)');
        for (const l of c.linhas.slice(0, concorrentes)) {
            L.push(`- ${l.sku} ${l.titulo} | MP ${num(l.mp)} | PC ${num(l.pc)} | DF% ${l.df == null ? 'sem dado' : l.df + '%'}`
                + ` | rank NUB ${l.rank_nub ?? 'sem dado'} de ${l.grupo_anuncios ?? '?'} | grupo ${l.grupo || 'sem dado'}`
                + ` | vendas 30d ${num(l.vendas30, 0)} | curva ${l.curvaAbc || '-'}`);
        }
    } else L.push('sem dado (nao deu para ler os concorrentes)');

    // A analise ja esta pronta e com acao calculada: em vez de o modelo reinventar
    // (ele so copiava o bloco), a pergunta passa a ser respondida em cima dela.
    L.push('');
    L.push('SAUDE (regras ja aplicadas, com a acao de cada problema)');
    if (s) {
        L.push(textoSaude(s).split('\n').slice(1, 20).join('\n'));
    } else L.push('sem dado (nao deu para calcular a saude)');

    if (falhas.length) L.push('', 'AVISO DE LEITURA (o modelo deve ignorar): ' + falhas.join(' | '));
    return L.join('\n');
}

// ---------- pergunta (stream NDJSON para a tela) ----------

async function* eventos(res, t0) {
    const dec = new TextDecoder();
    let buf = '';
    for await (const pedaco of res.body) {
        buf += dec.decode(pedaco, { stream: true });
        let corte;
        while ((corte = buf.indexOf('\n')) >= 0) {
            const linha = buf.slice(0, corte); buf = buf.slice(corte + 1);
            if (!linha.trim()) continue;
            let o; try { o = JSON.parse(linha); } catch { continue; }
            if (o.error) { yield { tipo: 'erro', texto: String(o.error) }; return; }
            if (o.response) yield { tipo: 'token', texto: o.response };
            if (o.done) {
                const seg = (Date.now() - t0) / 1000;
                yield { tipo: 'fim', ms: Date.now() - t0, tokens: o.eval_count || 0,
                        tok_s: seg > 0 ? +((o.eval_count || 0) / seg).toFixed(1) : 0,
                        // prompt_tokens deixa ver se o modelo esta comendo o contexto inteiro:
                        // se passar de num_ctx, o Ollama corta o comeco dos dados sem avisar.
                        prompt_tokens: o.prompt_eval_count || 0,
                        // done_reason 'length' = o modelo bateu no teto de tokens e a
                        // resposta foi cortada no meio. A tela avisa em vez de fingir que acabou.
                        cortada: o.done_reason === 'length' };
                return;
            }
        }
    }
}

// ---------- saúde dos anúncios: regras fixas sobre as DUAS tabelas ------------------------
// Cruzamento da "Análise por tempo de vendas" (giro, ranking orgânico, termos) com a "Análise de
// concorrentes" (preço x líder, nossa posição no grupo). O cálculo é aqui, em cima dos números reais;
// o modelo recebe o resultado pronto e escreve a sugestão. Assim ele nunca inventa diagnóstico.

const PESO_CURVA = { A: 3, B: 2, C: 1 };
const curto = (t, n) => String(t || '').slice(0, n || 46);
// Ação concreta por tipo de sinal, calculada aqui e não pelo modelo: com 3 tok/s
// nao da pra pedir pro modelo "decidir" nada, e ele inventava frase generica
// ("otimize estoque") para todo problema.
const ACAO = {
    preco_caro_sem_venda: 'baixar o preco ou aumentar a quantidade no titulo/promocao ate parecer com o lider',
    subir_preco: 'subir o preco em degraus de 3% a 5% e conferir a venda no dia seguinte',
    margem_curta: 'rever o custo ou subir o preco: esta muito abaixo de quem mais vende',
    fora_do_podio: 'ajustar titulo/fotos/preco para sair do 4o lugar do grupo',
    fora_da_pagina1: 'mexer em titulo e preco ate voltar para a primeira pagina da busca',
    venda_sem_busca: 'descobrir por qual termo esse anuncio vende e colocar esse termo no titulo',
    parado: 'pausar o anuncio ou fazer promocao: esta no ar ha semanas sem sair nada',
    sem_ontem: 'conferir estoque e competencia: parou de vender com giro normal',
    oportunidade: 'avaliar subir o preco ou aumentar o estoque: esta vendendo acima da media',
};
const acao = (tipo) => ACAO[tipo] || 'rever o anuncio';

function avaliar(p, k) {
    const s = []; const lac = [];
    const add = (tipo, txt, peso) => s.push({ tipo, txt, peso, acao: acao(tipo) });
    // --- preço contra o concorrente que mais vende no grupo ---
    if (k && k.df != null) {
        if (k.df >= 5) {
            if (p.ontem >= p.media_dia) add('subir_preco', `preco ${k.df}% acima do lider (${k.lider}) e ainda vendendo acima da media`, 3);
            else add('preco_caro_sem_venda', `preco ${k.df}% acima do lider (${k.lider}) e venda abaixo da media`, 4);
        } else if (k.df <= -15) add('margem_curta', `preco ${k.df}% abaixo do lider (${k.lider}): sobra pouco para quem vende mais`, 3);
    }
    // --- visibilidade: grupo de concorrência e busca orgânica ---
    if (k && k.rank_nub != null && k.rank_nub > 3) add('fora_do_podio', `${k.rank_nub}o de ${k.grupo_anuncios} no grupo ${k.grupo}`, 3);
    if (p.rank_ml) {
        if (p.rank_ml.pagina > 1) add('fora_da_pagina1', `posicao ${p.rank_ml.posicao} na pagina ${p.rank_ml.pagina} da busca`, 3);
    } else if (p.ontem > 0) add('venda_sem_busca', 'vendeu ontem mas nao aparece em nenhum termo pesquisado', 3);
    // --- giro de estoque ---
    // parado = nada no mes-base E nada ontem (quem vendeu ontem nao esta parado, so e novo/raro)
    if (p.status === 'active' && p.vendas_mes === 0 && !p.ontem) add('parado', 'no ar e sem nenhuma venda no mes anterior nem ontem', 4);
    if (p.situacao === 'Não vendeu' && p.vendas_mes > 0) add('sem_ontem', `nao vendeu ontem mesmo com ${p.vendas_mes} un no mes (media ${num(p.media_dia, 2)}/dia)`, 3);
    if (p.situacao === 'Acima da média' && p.media_dia > 0 && p.ontem >= p.media_dia * 1.5) add('oportunidade', `vendeu ${p.ontem} contra media de ${num(p.media_dia, 1)}/dia: avalie preco ou estoque`, 1);
    // --- LACUNAS DE COLETA: nao e problema do anuncio, e dado que falta. Ficam fora da gravidade,
    //     senao 233 anuncios "sem termo" enterrariam os poucos problemas de verdade.
    if (!p.coberto) lac.push('sem_termo');
    if (k && k.pc == null) lac.push('sem_concorrente');
    if (!k) lac.push('sem_grupo');
    return { sinais: s, lacunas: lac };
}

async function saude() {
    const v = await seven.tabelaVendas(false);
    const c = seven.tabelaConcorrentes();
    const kmap = new Map(c.linhas.map(x => [x.item_id, x]));
    const itens = v.linhas.map(p => {
        const k = kmap.get(p.item_id) || null;
        const { sinais, lacunas } = avaliar(p, k);
        const gravidade = sinais.reduce((s, x) => s + x.peso, 0) * (PESO_CURVA[p.curvaAbc] || 1);
        return {
            item_id: p.item_id, sku: p.sku, titulo: p.titulo, curva: p.curvaAbc || '', status: p.status,
            ontem: p.ontem, media_dia: p.media_dia, vendas_mes: p.vendas_mes, situacao: p.situacao, preco: p.preco,
            df: k ? k.df : null, rank_nub: k ? k.rank_nub : null, grupo: k ? k.grupo : null,
            grupo_anuncios: k ? k.grupo_anuncios : null, lider: k ? k.lider : null,
            rank_ml: p.rank_ml || null, variacao: p.variacao, sinais, lacunas, gravidade,
        };
    });
    const ordem = [...itens].sort((a, b) => b.gravidade - a.gravidade || b.ontem - a.ontem);
    const contagem = {};
    const lacContagem = {};
    for (const i of itens) {
        for (const s of i.sinais) contagem[s.tipo] = (contagem[s.tipo] || 0) + 1;
        for (const l of i.lacunas) lacContagem[l] = (lacContagem[l] || 0) + 1;
    }
    return {
        gerado_em: new Date().toISOString(),
        base: {
            dia: v.dia, mes: v.base && v.base.mes, vendas_ontem: v.resumo.unidades_ontem,
            media_dia: v.resumo.media_dia_base, variacao: v.resumo.variacao,
            venderam: v.resumo.venderam, nao_venderam: v.resumo.nao_venderam,
            ranking_ml: v.ranking_ml, grupos_com_dado: c.grupos_com_dado, grupos_sem_dado: c.grupos_sem_dado,
            gerado_em_conc: c.gerado_em, conc_disponivel: c.disponivel,
        },
        contagem, lacContagem, itens, ordem,
        limpos: itens.filter(i => !i.sinais.length).map(i => i.sku),
    };
}

function textoSaude(s) {
    const L = [];
    L.push(`SAUDE DOS ANUNCIOS (dia ${s.base.dia}, media do mes ${s.base.mes})`);
    L.push(`Ontem: ${num(s.base.vendas_ontem, 0)} un | media/dia ${num(s.base.media_dia, 1)} | variacao ${pct(s.base.variacao)}`
        + ` | venderam ${s.base.venderam}, nao venderam ${s.base.nao_venderam} | anuncios ${s.itens.length}`);
    L.push(`Concorrentes: ${s.base.conc_disponivel ? `${s.base.grupos_com_dado} grupos com dado, ${s.base.grupos_sem_dado} sem dado (de ${s.base.gerado_em_conc || '-'})` : 'sem dado (Nubimetrics nao exportou)'}`);
    L.push(`Ranking ML: ${s.base.ranking_ml && s.base.ranking_ml.disponivel ? `${s.base.ranking_ml.feitos}/${s.base.ranking_ml.termos} termos` : 'nao coletado'}`);
    L.push('');
    const comSinal = s.ordem.filter(i => i.sinais.length);
    L.push(`PROBLEMAS (gravidade = sinais x curva ABC; ${comSinal.length} de ${s.itens.length} anuncios com sinal). A acao ja esta calculada:`);
    for (const i of comSinal.slice(0, 12)) {
        L.push(`- [grav ${i.gravidade}] ${curto(i.sku, 30)} ${curto(i.titulo, 34)} | curva ${i.curva || '-'} | ontem ${i.ontem} (media ${num(i.media_dia, 2)})`
            + ` | mes ${i.vendas_mes} | preco ${num(i.preco)}`
            + (i.df == null ? '' : ` | DF% ${i.df}`) + (i.rank_nub == null ? '' : ` | rank NUB ${i.rank_nub}/${i.grupo_anuncios}`)
            + (i.rank_ml ? ` | rank ML ${i.rank_ml.posicao} p${i.rank_ml.pagina}` : ''));
        for (const s2 of i.sinais) L.push(`      · ${s2.txt} -> ${s2.acao}`);
    }
    L.push('');
    L.push(`LACUNAS DE COLETA (faltam dados; NAO contam para a gravidade e nao sao problema do anuncio):`);
    const NOME_LAC = {
        sem_termo: 'nenhum termo pesquisado descreve o titulo do anuncio',
        sem_concorrente: 'grupo de concorrencia existe mas sem preco do lider',
        sem_grupo: 'sem grupo de concorrencia no Nubimetrics',
    };
    for (const [chave, n] of Object.entries(s.lacContagem || {})) L.push(`  - ${n} anuncios: ${NOME_LAC[chave] || chave}`);
    L.push('');
    L.push(`SEM SINAL ALERTA (${s.limpos.length}): ${s.limpos.slice(0, 22).join(', ')}`);
    return L.join('\n');
}

const INSTRUCAO_SAUDE = [
    'Voce avalia a SAUDE DE ANUNCIOS de uma loja de autopeças.',
    'O bloco DADOS ja traz, item a item, o problema encontrado e a acao concreta JA CALCULADA.',
    'Sua parte e escolher o que fazer primeiro. Nao e repetir a lista.',
    'REGRA OBRIGATORIA DE FORMATO: escreva em TEXTO SIMPLES. Nao use tabela markdown,',
    'nao escreva linha de cabecalho com | --- |, nao use marcador de lista com asterisco.',
    'Cada linha comeca com o SKU abreviado, seguido do problema em poucas palavras,',
    'seguido da acao que ja esta escrita no DADOS (nunca invente outra acao).',
    'Responda em portugues do Brasil, no maximo 5 linhas curtas, mais uma linha final',
    'comecando com "Falta coletar:". Pare de escrever depois disso. Nao escreva titulo,',
    'tabela,introducao,conclusao nem resumo. Nao repita o bloco DADOS e nao crie numero que nao esta la.',
].join(' ');

const PERGUNTA_SAUDE = 'Qual a saúde dos meus anúncios, o que fazer primeiro e onde dá para ganhar dinheiro?';

async function perguntarSaude({ modelo = MODELO_PADRAO } = {}) {
    const s = await saude();
    return perguntar({ modelo, dados: textoSaude(s), instrucao: INSTRUCAO_SAUDE, pergunta: PERGUNTA_SAUDE, resumo: s });
}

async function perguntar({ pergunta, modelo = MODELO_PADRAO, dados = null, instrucao = '', resumo = null }) {
    if (!pergunta || !String(pergunta).trim()) throw new Error('Pergunta vazia.');
    const bloco = dados == null ? await contexto() : dados;
    const sistema = instrucao ? `${SISTEMA}\n${instrucao}` : SISTEMA;
    const t0 = Date.now();
    const r = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: modelo, system: sistema, keep_alive: KEEP_ALIVE, stream: true,
            prompt: `DADOS\n${bloco}\n\nPERGUNTA\n${String(pergunta).trim()}`,
            options: { temperature: 0.2, top_p: 0.9, num_ctx: NUM_CTX, num_predict: NUM_PREDICT },
        }),
    });
    if (!r.ok || !r.body) throw new Error(`Ollama respondeu ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`);
    // A maquina pode ficar ~80 s sem devolver NADA (carregando o modelo em disco). Sem heartbeat a
    // tela parece travada e o navegador mata a conexao; com ele, a pessoa ve que ainda esta vivo.
    function relogio(ms) {
        let h;
        const p = new Promise(res => { h = setTimeout(() => res({ espera: true }), ms); });
        p.cancelar = () => clearTimeout(h);
        return p;
    }
    async function* ndjson() {
        yield JSON.stringify({
            tipo: 'contexto', chars: bloco.length, modelo, keep_alive: KEEP_ALIVE,
            saude: resumo ? {
                anuncios: resumo.itens.length,
                com_sinal: resumo.ordem.filter(i => i.sinais.length).length,
                contagem: resumo.contagem,
                grupos_sem_dado: resumo.base.grupos_sem_dado,
            } : null,
        }) + '\n';
        const it = eventos(r, t0);
        let primeiraVez = true;
        let ultimoAviso = -9;
        for (;;) {
            let passo;
            if (primeiraVez) {
                const espera = relogio(3000);
                passo = await Promise.race([it.next(), espera]);
                espera.cancelar();
            } else passo = await it.next();
            if (passo && passo.espera) {
                const s = Math.round((Date.now() - t0) / 1000);
                if (s - ultimoAviso >= 3) { ultimoAviso = s; yield JSON.stringify({ tipo: 'espera', s }) + '\n'; }
                continue;
            }
            if (!passo || passo.done) return;
            if (passo.value && passo.value.tipo === 'token') primeiraVez = false;
            yield JSON.stringify(passo.value) + '\n';
        }
    }
    return Readable.from(ndjson());
}


// ---- Faturamento para a retrospectiva da IA (so leitura, isolado: nao mexe no Seven) --------
// Ontem e do dia 1 ate agora, contra o mes anterior. Pedidos nao cancelados, preco x quantidade.
const axios = require('axios');
const TokenManager = require('./tokenManager');
const diaBR = (d) => new Date(new Date(d).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
async function pedidosPorDia(de, ate) {
    const { access_token, user_id } = await TokenManager.getToken();
    const headers = { Authorization: `Bearer ${access_token}` };
    const base = { seller: user_id, limit: 50, 'order.date_created.from': `${de}T00:00:00.000-03:00`, 'order.date_created.to': `${ate}T23:59:59.999-03:00` };
    const pag = async (offset) => {
        for (let t = 0; ; t++) {
            try { return (await axios.get('https://api.mercadolibre.com/orders/search', { headers, params: { ...base, offset }, timeout: 20000 })).data; }
            catch (e) { if (e.response?.status === 429 && t < 5) { await new Promise(r => setTimeout(r, 1500 * (t + 1))); continue; } throw e; }
        }
    };
    const primeira = await pag(0);
    const pags = [primeira];
    const offs = []; for (let o = 50; o < (primeira.paging?.total || 0); o += 50) offs.push(o);
    for (let k = 0; k < offs.length; k += 5) pags.push(...await Promise.all(offs.slice(k, k + 5).map(pag)));
    const porDia = {}; const pedDia = {};
    for (const pg of pags) for (const o of pg.results || []) {
        if (o.status === 'cancelled') continue;
        const d = diaBR(o.date_created);
        pedDia[d] = (pedDia[d] || 0) + 1;
        for (const it of o.order_items || []) porDia[d] = (porDia[d] || 0) + Number(it.quantity || 0) * Number(it.unit_price || 0);
    }
    return { porDia, pedDia };
}
let cacheFat = null, cacheAnt = null;
async function faturamento(forcar = false) {
    const hoje = diaBR(Date.now());
    const de = hoje.slice(0, 8) + '01';
    const d0 = new Date(hoje + 'T12:00:00Z'); d0.setUTCDate(d0.getUTCDate() - 1); const ontemDia = d0.toISOString().slice(0, 10);
    // no dia 1 o "ontem" e do mes anterior: a busca comeca em ontem para ele nao sair zerado
    const inicio = ontemDia < de ? ontemDia : de;
    if (forcar || !cacheFat || cacheFat.hoje !== hoje || Date.now() - cacheFat.t > 5 * 60 * 1000) {
        cacheFat = { hoje, t: Date.now(), ...(await pedidosPorDia(inicio, hoje)) };
    }
    const ini = new Date(Date.UTC(+hoje.slice(0, 4), +hoje.slice(5, 7) - 2, 1));
    const fim = new Date(Date.UTC(+hoje.slice(0, 4), +hoje.slice(5, 7) - 1, 0));
    const mesAnt = ini.toISOString().slice(0, 7);
    if (!cacheAnt || cacheAnt.mes !== mesAnt) {
        const r = await pedidosPorDia(ini.toISOString().slice(0, 10), fim.toISOString().slice(0, 10));
        cacheAnt = { mes: mesAnt, nome: ini.toLocaleString('pt-BR', { month: 'long', timeZone: 'UTC' }), dias: fim.getUTCDate(),
                     valor: Object.values(r.porDia).reduce((s, v) => s + v, 0) };
    }
    const d = new Date(hoje + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); const ontem = d.toISOString().slice(0, 10);
    const soma = (f) => Object.entries(cacheFat.porDia).filter(([k]) => f(k)).reduce((s, [, v]) => s + v, 0);
    const fechados = Number(hoje.slice(8, 10)) - 1;
    const ateOntem = soma(k => k >= de && k < hoje);
    const diasMes = new Date(Date.UTC(+hoje.slice(0, 4), +hoje.slice(5, 7), 0)).getUTCDate();
    const media = fechados ? ateOntem / fechados : 0;
    const mediaAnt = cacheAnt.valor / cacheAnt.dias;
    const r2 = (v) => +Number(v || 0).toFixed(2);
    return {
        ontem: { dia: ontem, valor: r2(cacheFat.porDia[ontem]), pedidos: cacheFat.pedDia[ontem] || 0 },
        hoje: { dia: hoje, valor: r2(cacheFat.porDia[hoje]) },
        mes: { de, ate: hoje, valor: r2(soma(k => k >= de)), pedidos: Object.entries(cacheFat.pedDia).filter(([k]) => k >= de).reduce((s, [, v]) => s + v, 0),
               media_dia: fechados ? r2(media) : null, projecao: fechados ? r2(media * diasMes) : null, dias_mes: diasMes,
               por_dia: Object.keys(cacheFat.porDia).filter(k => k >= de).sort().map(k => ({ dia: k, valor: r2(cacheFat.porDia[k]) })) },
        mes_anterior: { nome: cacheAnt.nome, valor: r2(cacheAnt.valor), media_dia: r2(mediaAnt) },
        ritmo: mediaAnt && fechados ? +((media / mediaAnt) - 1).toFixed(3) : null,   // no dia 1 ainda nao ha dia fechado
        atualizado_em: new Date(cacheFat.t).toISOString(),
    };
}

// ---- Card Rankeamento: produtos que mais faturam + analise de mudanca de preco (+/-1%) ----
// Junta vendas (reposicao/seven), concorrencia (Astra/Nubimetrics) e ranking de busca (Issacar).
// A decisao e SEMIAUTOMATICA: a analise sugere, a pessoa abre o precificador e confirma.
// 'nao vendeu ontem' sozinho nao e sinal de preco (um dia fraco); entra so junto com outro sinal
const PRECO_DESCE = ['preco_caro_sem_venda', 'fora_do_podio', 'fora_da_pagina1', 'parado'];
const PRECO_SOBE = ['subir_preco', 'margem_curta', 'oportunidade'];
async function rankeamento() {
    const fs = require('fs'); const path = require('path');
    const STG = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
    let rep = []; try { rep = JSON.parse(fs.readFileSync(path.join(STG, 'reposicao.json'), 'utf8')); } catch {}
    const porItem = new Map(rep.map(r => [r.item_id, r]));
    const s = await saude();
    const conc = new Map((seven.tabelaConcorrentes().linhas || []).map(l => [l.item_id, l]));
    const linhas = s.itens.map(i => {
        const r = porItem.get(i.item_id) || {}; const k = conc.get(i.item_id) || {};
        const tipos = i.sinais.map(x => x.tipo);
        const direcao = tipos.some(t => PRECO_DESCE.includes(t)) ? -1 : tipos.some(t => PRECO_SOBE.includes(t)) ? 1 : 0;
        const sinal = [...i.sinais].sort((a, b) => b.peso - a.peso).find(x => PRECO_DESCE.includes(x.tipo) || PRECO_SOBE.includes(x.tipo));
        return {
            item_id: i.item_id, sku: i.sku, titulo: i.titulo, curva: i.curva, status: i.status,
            qtd_vendida: r.vendas30 ?? null, faturamento: r.faturamento30 ?? null, preco: i.preco || k.mp || null,
            qtd_concorrente: k.lider_vendas ?? null, concorrente: k.lider || null, pc: k.pc ?? null, df: i.df,
            rank_nub: i.rank_nub, grupo_anuncios: i.grupo_anuncios,
            rank_busca: i.rank_ml ? i.rank_ml.posicao : null, pagina_busca: i.rank_ml ? i.rank_ml.pagina : null,
            ontem: i.ontem, media_dia: i.media_dia, direcao, sinal: sinal ? sinal.tipo : null, sinal_texto: sinal ? sinal.txt : '',
            sugestao_preco: (i.preco || k.mp) && direcao ? Math.round((i.preco || k.mp) * (1 + direcao / 100) * 100) / 100 : null,
        };
    });
    const top = linhas.filter(l => l.faturamento).sort((a, b) => b.faturamento - a.faturamento).slice(0, 40);
    const ajustar = linhas.filter(l => l.direcao && l.status === 'active')
        .sort((a, b) => (b.faturamento || 0) - (a.faturamento || 0)).slice(0, 30);
    return { gerado_em: new Date().toISOString(), top, ajustar,
        resumo: { produtos: linhas.length, para_baixar: ajustar.filter(l => l.direcao < 0).length, para_subir: ajustar.filter(l => l.direcao > 0).length } };
}

const INSTRUCAO_RANK = `Voce e o analista de preco do SEVEN. Recebe a tabela dos produtos que precisam de ajuste de preco, com:
faturamento e vendas dos ultimos 30 dias, preco, diferenca para o concorrente que mais vende (DF%), posicao no grupo do Nubimetrics (RANK) e posicao na busca do ML.
Para CADA produto, decida: SUBIR 1%, BAIXAR 1% ou MANTER, com 1 frase de motivo usando os numeros. Regras:
- So suba se estiver vendendo bem E (mais barato que o concorrente OU no topo do grupo). So baixe se estiver mais caro e vendendo pouco.
- Curva A pesa mais: em duvida num curva A, prefira MANTER e acompanhar.
- Nunca mais que 1%. A decisao final e da pessoa: voce so recomenda.
Formato: uma linha por produto: "SKU — DECISAO — motivo". Depois, 2 linhas de resumo.`;
async function perguntarRankeamento({ modelo = MODELO_PADRAO } = {}) {
    const r = await rankeamento();
    const n = (v, c = 0) => v == null ? '-' : Number(v).toFixed(c);
    const tab = r.ajustar.slice(0, 15).map(l => `${l.sku} | ${String(l.titulo).slice(0, 40)} | curva ${l.curva || '-'} | fat30 R$ ${n(l.faturamento)} | vendas30 ${n(l.qtd_vendida)} | preco R$ ${n(l.preco, 2)} | DF ${n(l.df, 1)}% | RANK ${l.rank_nub || '-'}/${l.grupo_anuncios || '-'} | busca ${l.rank_busca || '-'} | sinal: ${l.sinal_texto}`).join('\n');
    return perguntar({ modelo, dados: `PRODUTOS PARA AJUSTE DE PRECO (${r.ajustar.length}):\n${tab}`, instrucao: INSTRUCAO_RANK,
        pergunta: 'Para cada produto: SUBIR 1%, BAIXAR 1% ou MANTER, com o motivo em 1 frase.' });
}

module.exports = { rankeamento, perguntarRankeamento, faturamento, estado, contexto, perguntar, perguntarSaude, saude, textoSaude, OLLAMA_URL, MODELO_PADRAO, SISTEMA };
