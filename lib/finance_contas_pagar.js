// Cada empresa le o ERP da propria empresa (23/10/2026): a Flavia le o Bling (pelo Nexus); a Cordeiro NAO tem Bling, entao le o
// Olist dela (contas.pagar.pesquisa.php). O Bling do app Nexus e da Flavia: a Cordeiro nunca pode mostrar as contas dele.
// Contas a pagar (22/10/2026): as contas lancadas no Bling (Financeiro > Contas a pagar), lidas pelo motor Nexus
// (API v3: /contas/pagar). O Olist tem o servico mas nao tem contas lancadas, entao a fonte e o Bling.
// So le: nada e baixado, pago ou alterado no Bling.
// Baixa ("marcar como paga", 27/10/2026): so no OLIST, so conta ABERTA, com o valor que a tela mostra, uma conta por vez (conta.pagar.baixar.php); le o Olist
// antes (a conta existe, esta aberta, valor igual) e depois (situacao "paga") e so entao atualiza a lista. Log em contas_pagar_baixas.jsonl.
//   lista ........ GET /contas/pagar?dataVencimentoInicial&dataVencimentoFinal (todas as paginas)
//   detalhe ...... GET /contas/pagar/{id}: historico, categoria, numero do documento (guardado por id)
//   nomes ........ GET /contatos/{id} (fornecedor), /formas-pagamentos/{id}, /categorias/receitas-despesas/{id} (cache)
// Escopos do app no Bling: Contas a pagar, Contatos, Formas de pagamento e Categorias financeiras.
// Situacao no Bling: 1 em aberto, 2 paga, 3 paga em parte, 4 devolvida, 5 cancelada. Na tela: "Vence hoje" e
// "Atrasada" saem do vencimento das contas em aberto.
// Cards de IA (agente "Fluxo de caixa" do Complexo, area Finance): 3 resumos curtos do que vem pela frente, usando
// tambem o total a liberar do Mercado Pago (Contas a receber / Liberacoes) para o caixa da semana.
const fs = require('fs');
const path = require('path');

const STORAGE = () => process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ARQ = () => path.join(STORAGE(), 'contas_pagar.json');
const ARQ_IA = () => path.join(STORAGE(), 'contas_pagar_ia.json');
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
const gravar = (arq, o) => { fs.mkdirSync(path.dirname(arq), { recursive: true }); fs.writeFileSync(arq, JSON.stringify(o)); };
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const hojeBR = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
const somaDias = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const EH_CORDEIRO = path.basename(path.dirname(process.env.STORAGE_PATH || path.join(__dirname, '../storage'))) === 'dashboard-cordeiro';
const SIT_BLING = { 1: 'aberta', 2: 'paga', 3: 'parcial', 4: 'devolvida', 5: 'cancelada' };
// Fonte das contas: o OLIST e o sistema oficial (decisao do usuario em 26/10/2026; a ponte de notas lanca nele). A Cordeiro nunca teve Bling.
// config.json { "contas_pagar_fonte": "bling" } volta a ler o Bling na Flavia.
const USA_OLIST = () => EH_CORDEIRO || (lerJson(path.join(STORAGE(), 'config.json'), {}).contas_pagar_fonte || 'olist') !== 'bling';

// situacao da tela: em aberto vira "vence hoje" ou "atrasada" pelo vencimento
function situacao(c, hoje = hojeBR()) {
    const s = SIT_BLING[c.situacao] || 'aberta';
    if (s !== 'aberta' && s !== 'parcial') return s;
    return c.vencimento < hoje ? 'atrasada' : c.vencimento === hoje ? 'vence_hoje' : s;
}

// Cordeiro: contas a pagar do Olist dela (API v2). Sem contas lancadas la, a lista fica vazia e a tela avisa.
async function atualizarOlist(de, ate) {
    const tk = lerJson(path.join(require('os').homedir(), '.seven', EH_CORDEIRO ? 'olist_cordeiro.json' : 'olist.json'), {}).token;
    if (!tk) throw new Error('Token do Olist da ' + (EH_CORDEIRO ? 'Cordeiro' : 'Flavia') + ' não cadastrado.');
    // a primeira leitura do Olist na Flavia troca o cache do Bling: guarda uma copia
    const antigo = lerJson(ARQ(), null); if (antigo && !antigo.fonte) { try { fs.copyFileSync(ARQ(), path.join(STORAGE(), 'contas_pagar_bling_backup.json')); } catch {} }
    const br = (d) => d.split('-').reverse().join('/'), iso = (d) => String(d || '').split('/').reverse().join('-');
    const base = { contas: {}, contatos: {}, formas: {}, categorias: {}, fonte: 'Olist da ' + (EH_CORDEIRO ? 'Cordeiro' : 'Flavia') };
    for (let pg = 1; ; pg++) {
        const j = (await (await fetch('https://api.tiny.com.br/api2/contas.pagar.pesquisa.php', { method: 'POST', body: new URLSearchParams({ token: tk, formato: 'json', data_ini_vencimento: br(de), data_fim_vencimento: br(ate), pagina: String(pg) }) })).json()).retorno;
        if (j.status !== 'OK') break;
        for (const x of j.contas || []) {
            const c = x.conta || x, nome = c.nome_cliente || c.cliente || '—', sit = /pag|liquid/i.test(c.situacao || '') ? 2 : /cancel/i.test(c.situacao || '') ? 5 : 1;
            base.contas['o' + c.id] = { id: 'o' + c.id, situacao: sit, vencimento: iso(c.data_vencimento || c.vencimento), valor: Number(c.valor), contato: nome, forma: null, categoria: c.categoria || null,
                historico: c.historico || '', documento: c.numero_doc || c.nro_documento || '', detalhe: true };
            base.contatos[nome] = nome; if (c.categoria) base.categorias[c.categoria] = c.categoria;
        }
        est.feito += (j.contas || []).length;
        if (pg >= Number(j.numero_paginas || 1)) break;
        await new Promise(r => setTimeout(r, 1100));
    }
    base.atualizado_em = new Date().toISOString(); base.periodo = { de, ate }; gravar(ARQ(), base); est.em = base.atualizado_em;
}

const est = { rodando: false, etapa: '', feito: 0, total: 0, erro: null, em: null };
function atualizar({ de, ate } = {}) {
    if (est.rodando) return { ok: false, erro: 'Já está lendo as contas.' };
    if (estB.rodando) return { ok: false, erro: 'Está dando baixa em contas. Espere terminar.' };
    const hoje = hojeBR();
    de = /^\d{4}-\d{2}-\d{2}$/.test(de || '') ? de : somaDias(hoje, -60); ate = /^\d{4}-\d{2}-\d{2}$/.test(ate || '') ? ate : somaDias(hoje, 60);
    Object.assign(est, { rodando: true, etapa: USA_OLIST() ? 'Lendo as contas no Olist…' : 'Lendo as contas no Bling…', feito: 0, total: 0, erro: null });
    (async () => {
        try {
            if (USA_OLIST()) { await atualizarOlist(de, ate); return; }
            const N = require('./nexus_bling');
            const base = lerJson(ARQ(), { contas: {}, contatos: {}, formas: {}, categorias: {} });
            const lista = await N.todasPaginas('/contas/pagar', { dataVencimentoInicial: de, dataVencimentoFinal: ate });
            // detalhe so do que mudou (ou nunca foi lido): situacao, valor ou vencimento diferentes
            const fila = lista.filter(c => { const a = base.contas[c.id]; return !a || a.situacao !== c.situacao || a.valor !== c.valor || a.vencimento !== c.vencimento || !a.detalhe; });
            Object.assign(est, { etapa: 'Lendo o detalhe de cada conta…', total: fila.length });
            for (const c of lista) base.contas[c.id] = { ...(base.contas[c.id] || {}), id: c.id, situacao: c.situacao, vencimento: c.vencimento, valor: c.valor, contato: c.contato?.id || null, forma: c.formaPagamento?.id || null };
            for (const c of fila) {
                const d = (await N.get(`/contas/pagar/${c.id}`))?.data || {};
                Object.assign(base.contas[c.id], { detalhe: true, historico: d.historico || '', documento: d.numeroDocumento || '', categoria: d.categoria?.id || null,
                    emissao: d.dataEmissao || null, saldo: d.saldo ?? null, contato: d.contato?.id || base.contas[c.id].contato, forma: d.formaPagamento?.id || base.contas[c.id].forma });
                est.feito++;
            }
            // nomes (fornecedor, forma de pagamento, categoria): uma leitura por id, guardada
            est.etapa = 'Lendo fornecedores e categorias…';
            const nome = async (mapa, ids, rota, campo) => { for (const id of [...new Set(ids.filter(Boolean))].filter(id => !mapa[id])) { try { mapa[id] = (await N.get(`${rota}/${id}`))?.data?.[campo] || String(id); } catch { mapa[id] = String(id); } } };
            const C = Object.values(base.contas);
            await nome(base.contatos, C.map(c => c.contato), '/contatos', 'nome');
            await nome(base.formas, C.map(c => c.forma), '/formas-pagamentos', 'descricao');
            await nome(base.categorias, C.map(c => c.categoria), '/categorias/receitas-despesas', 'descricao');
            base.atualizado_em = new Date().toISOString(); base.periodo = { de, ate };
            gravar(ARQ(), base); est.em = base.atualizado_em;
        } catch (e) {
            est.erro = !USA_OLIST() && /insufficient_scope|403/.test(e.message) ? 'O app NEXUS ENGINE no Bling ainda não tem permissão de Contas a pagar (e Contatos). Libere os escopos e autorize de novo.' : e.message;
        } finally { Object.assign(est, { rodando: false, etapa: '' }); }
    })();
    return { ok: true };
}
const estado = () => ({ ...est });

// ---------------------------------------------------------------- baixa ("marcar como paga") no Olist
const ARQ_LOG = () => path.join(STORAGE(), 'contas_pagar_baixas.jsonl');
const registrar = (o) => { try { fs.mkdirSync(path.dirname(ARQ_LOG()), { recursive: true }); fs.appendFileSync(ARQ_LOG(), JSON.stringify({ em: new Date().toISOString(), ...o }) + '\n'); } catch {} };
const tokenOlist = () => lerJson(path.join(require('os').homedir(), '.seven', EH_CORDEIRO ? 'olist_cordeiro.json' : 'olist.json'), {}).token || null;
const dormir = (ms) => new Promise(r => setTimeout(r, ms));
const brData = (d) => String(d).split('-').reverse().join('/');
let proximaOlist = 0;
async function olist(rota, params) {   // 60 chamadas por minuto: espaca ~1,02 s; espera se o Olist pedir
    const tk = tokenOlist(); if (!tk) throw new Error('Token do Olist não cadastrado neste PC.');
    for (let t = 0; t < 6; t++) {
        const agora = Date.now(), v = Math.max(agora, proximaOlist); proximaOlist = v + 1020; if (v > agora) await dormir(v - agora);
        let j;
        try { j = (await (await fetch('https://api.tiny.com.br/api2/' + rota, { method: 'POST', body: new URLSearchParams({ token: tk, formato: 'json', ...params }), signal: AbortSignal.timeout(30000) })).json()).retorno; }
        catch { await dormir(3000 * (t + 1)); continue; }
        const cod = String(j.codigo_erro || ''), msg = JSON.stringify(j.erros || j.registros || '').toLowerCase();
        if (j.status !== 'OK' && (cod === '6' || /bloquead|excedido|muitas/.test(msg))) { await dormir(60000); continue; }
        return j;
    }
    throw new Error('O Olist não respondeu.');
}
const erroOlist = (j) => { const r = j.registros && (Array.isArray(j.registros) ? j.registros[0] : j.registros), x = (r && r.registro) || r || {}, e = x.erros || j.erros || []; return (Array.isArray(e) ? e : [e]).map(y => y && (y.erro || y)).filter(Boolean).join('; ') || JSON.stringify(j).slice(0, 200); };
async function contasDoVencimento(venc) {   // as contas que o Olist tem num vencimento, por id
    const out = {};
    for (let pg = 1; pg <= 30; pg++) {
        const j = await olist('contas.pagar.pesquisa.php', { data_ini_vencimento: brData(venc), data_fim_vencimento: brData(venc), pagina: String(pg) });
        if (j.status !== 'OK') break;
        for (const x of j.contas || []) { const c = x.conta || x; out[String(c.id)] = c; }
        if (pg >= Number(j.numero_paginas || 1)) break;
    }
    return out;
}
const pagaNoOlist = (c) => !!c && /pag|liquid/i.test(c.situacao || '') && !/parcial/i.test(c.situacao || '');

const estB = { rodando: false, etapa: '', feito: 0, total: 0, erro: null, em: null, resultados: [] };
const estadoBaixa = () => ({ ...estB, resultados: [...estB.resultados] });
// ids: ['o123', ...] (ids da lista); data: 'aaaa-mm-dd' do pagamento; conta_origem: opcional (nome igual ao do Olist)
function baixar({ ids, data, conta_origem } = {}) {
    if (!USA_OLIST()) throw new Error('Esta empresa lê as contas do Bling: a baixa é feita no Bling.');
    if (estB.rodando || est.rodando) return { ok: false, erro: 'Já está trabalhando. Espere terminar.' };
    if (!tokenOlist()) return { ok: false, erro: 'Token do Olist não cadastrado neste PC.' };
    const lista = [...new Set((ids || []).map(String))].filter(i => /^o\d+$/.test(i));
    if (!lista.length) throw new Error('Escolha as contas.');
    if (lista.length > 200) throw new Error('No máximo 200 contas por vez.');
    const dia = String(data || hojeBR());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia) || isNaN(Date.parse(dia + 'T12:00:00Z'))) throw new Error('Data do pagamento inválida.');
    if (dia > hojeBR()) throw new Error('A data do pagamento não pode ser no futuro.');
    const origem = String(conta_origem || '').trim().slice(0, 100) || null;
    Object.assign(estB, { rodando: true, etapa: 'Conferindo as contas no Olist…', feito: 0, total: lista.length, erro: null, resultados: [] });
    (async () => {
        try {
            const b = lerJson(ARQ(), null); if (!b || !b.fonte) throw new Error('Atualize as contas antes de dar baixa.');
            const R = estB.resultados, pend = [];
            for (const id of lista) {
                const c = b.contas[id], r = { id, fornecedor: c ? (b.contatos[c.contato] || '—') : '—', valor: c ? r2(c.valor) : null, vencimento: c ? c.vencimento : null };
                if (!c) { r.status = 'erro'; r.motivo = 'A conta não está na lista: atualize as contas.'; R.push(r); estB.feito++; continue; }
                if (c.situacao !== 1) { r.status = 'erro'; r.motivo = 'Esta conta não está em aberto na lista: atualize as contas.'; R.push(r); estB.feito++; continue; }
                pend.push({ id, c, r });
            }
            const vivas = {}; for (const v of [...new Set(pend.map(p => p.c.vencimento))]) { estB.etapa = `Conferindo o Olist (vencimento ${brData(v)})…`; vivas[v] = await contasDoVencimento(v); }
            const baixadas = [];
            for (const p of pend) {
                const { id, c, r } = p, live = (vivas[c.vencimento] || {})[id.slice(1)];
                estB.etapa = `Dando baixa (${estB.feito + 1} de ${lista.length})…`;
                try {
                    if (!live) throw new Error('Não achei a conta no Olist (vencimento ' + brData(c.vencimento) + '): atualize as contas.');
                    if (Math.abs(Number(live.valor) - Number(c.valor)) > 0.005) throw new Error(`O valor no Olist é R$ ${r2(live.valor)}, diferente da lista: atualize as contas. Não baixei.`);
                    if (/cancel/i.test(live.situacao || '')) throw new Error('A conta está cancelada no Olist. Não baixei.');
                    if (/parcial/i.test(live.situacao || '')) throw new Error('A conta está paga em parte: dê a baixa do saldo direto no Olist.');
                    if (pagaNoOlist(live)) { r.status = 'ja_paga'; c.situacao = 2; c.baixa = { em: new Date().toISOString(), ja_estava_paga: true }; }
                    else {
                        const conta = { id: id.slice(1), data: brData(dia), valorPago: r2(c.valor) }; if (origem) conta.contaOrigem = origem;
                        const j = await olist('conta.pagar.baixar.php', { conta: JSON.stringify({ conta }) });
                        if (j.status !== 'OK' && !/já foi paga/i.test(erroOlist(j))) throw new Error('O Olist recusou a baixa: ' + erroOlist(j));
                        r.status = 'baixada'; baixadas.push(p);
                    }
                } catch (e) { r.status = 'erro'; r.motivo = e.message; }
                registrar({ acao: 'baixa', id, status: r.status, valor: r.valor, vencimento: r.vencimento, data_pagamento: dia, motivo: r.motivo || null });
                R.push(r); estB.feito++;
            }
            if (baixadas.length) {   // le de volta e so entao marca como paga na lista
                for (let tentativa = 0; tentativa < 2 && baixadas.some(p => p.r.status === 'baixada'); tentativa++) {
                    estB.etapa = 'Conferindo as baixas no Olist…'; if (tentativa) await dormir(3000);
                    for (const v of [...new Set(baixadas.filter(p => p.r.status === 'baixada').map(p => p.c.vencimento))]) vivas[v] = await contasDoVencimento(v);
                    for (const p of baixadas.filter(p => p.r.status === 'baixada')) if (pagaNoOlist((vivas[p.c.vencimento] || {})[p.id.slice(1)])) { p.r.status = 'paga'; p.c.situacao = 2; p.c.baixa = { em: new Date().toISOString(), data: dia, conta_origem: origem }; }
                }
                for (const p of baixadas.filter(p => p.r.status === 'baixada')) { p.r.status = 'baixa_sem_confirmacao'; p.r.motivo = 'Baixa enviada, mas não consegui confirmar no Olist: confira por lá.'; }
                registrar({ acao: 'confirmacao', pagas: baixadas.filter(p => p.r.status === 'paga').length, sem_confirmacao: baixadas.filter(p => p.r.status === 'baixa_sem_confirmacao').length });
            }
            gravar(ARQ(), b);
        } catch (e) { estB.erro = e.message; registrar({ acao: 'erro', erro: e.message }); }
        finally { Object.assign(estB, { rodando: false, etapa: '', em: new Date().toISOString() }); }
    })();
    return { ok: true };
}

function listar({ de, ate } = {}) {
    const b = lerJson(ARQ(), null), hoje = hojeBR();
    if (!b || (USA_OLIST() && !b.fonte)) return { lido: false, hoje, linhas: [], resumo: null, fonte: USA_OLIST() ? 'Olist' : 'Bling' };
    const linhas = Object.values(b.contas).filter(c => (!de || c.vencimento >= de) && (!ate || c.vencimento <= ate)).map(c => ({
        id: c.id, fornecedor: b.contatos[c.contato] || '—', historico: c.historico || '', documento: c.documento || '', forma: b.formas[c.forma] || '—',
        categoria: b.categorias[c.categoria] || '', vencimento: c.vencimento, valor: r2(c.valor), situacao: situacao(c, hoje) }));
    const abertas = linhas.filter(l => ['aberta', 'parcial', 'vence_hoje', 'atrasada'].includes(l.situacao)), soma = (L) => r2(L.reduce((s, l) => s + l.valor, 0));
    const ate7 = somaDias(hoje, 7);
    return { lido: true, hoje, fonte: b.fonte || 'Bling', atualizado_em: b.atualizado_em, periodo: b.periodo, linhas: linhas.sort((x, y) => x.vencimento.localeCompare(y.vencimento) || y.valor - x.valor),
        resumo: { qtd: abertas.length, total: soma(abertas), hoje: soma(abertas.filter(l => l.vencimento === hoje)), sete_dias: soma(abertas.filter(l => l.vencimento <= ate7)),
            atrasadas: abertas.filter(l => l.situacao === 'atrasada').length, valor_atrasadas: soma(abertas.filter(l => l.situacao === 'atrasada')),
            pagas_periodo: soma(linhas.filter(l => l.situacao === 'paga')) } };
}

// 3 cards da IA: so le os numeros prontos (motor) e escreve o resumo; nunca inventa valor
const estIA = { rodando: false, erro: null };
function analisarIA() {
    if (estIA.rodando) return { ok: false, erro: 'A IA já está analisando.' };
    const L = listar({}); if (!L.lido) return { ok: false, erro: 'Atualize as contas do Bling primeiro.' };
    Object.assign(estIA, { rodando: true, erro: null });
    (async () => {
        try {
            const hoje = L.hoje, ate7 = somaDias(hoje, 7), abertas = L.linhas.filter(l => ['aberta', 'parcial', 'vence_hoje', 'atrasada'].includes(l.situacao));
            const porForn = {}; for (const l of abertas.filter(l => l.vencimento <= ate7)) porForn[l.fornecedor] = r2((porForn[l.fornecedor] || 0) + l.valor);
            let receber = null; try { const R = require('./finance_liberacoes').calendario({}).resumo; receber = { hoje: R.hoje, sete_dias: R.sete_dias, total: R.total }; } catch {}
            const dados = { hoje, resumo: L.resumo, proximos_7_dias_por_fornecedor: Object.entries(porForn).sort((a, b) => b[1] - a[1]).slice(0, 8),
                atrasadas: abertas.filter(l => l.situacao === 'atrasada').slice(0, 10).map(l => ({ fornecedor: l.fornecedor, vencimento: l.vencimento, valor: l.valor })),
                a_receber_mercado_pago: receber };
            const sistema = 'Você é o agente de Fluxo de caixa do Finance de uma loja de autopeças no Mercado Livre. Recebe números prontos de contas a pagar (Bling) e do dinheiro a liberar no Mercado Pago. Escreva 3 cards curtos para o topo da tela de Contas a pagar. Nunca invente número: use só os do JSON. Português do Brasil, direto. Responda SÓ com o JSON pedido.';
            const prompt = `DADOS (JSON):\n${JSON.stringify(dados)}\n\nResponda com este JSON exato:\n{"cards":[{"titulo":"Próximos 7 dias","valor":"R$ ...","texto":"1 frase: quanto vence e os maiores fornecedores"},{"titulo":"Caixa da semana","valor":"R$ ...","texto":"1 frase: a pagar em 7 dias x a liberar no Mercado Pago em 7 dias, se sobra ou falta"},{"titulo":"Atenção","valor":"...","texto":"1 frase: atrasadas, concentração em um fornecedor ou o que mais pede cuidado"}]}`;
            const ia = require('./ia');
            const g = await Promise.race([ia.gerarGemini(sistema, prompt, 900, 'gemini-3.1-flash-lite', { json: true, tarefa: 'Contas a pagar: 3 cards de resumo' }),
                new Promise((_, rej) => setTimeout(() => rej(new Error('a IA demorou mais de 60 s')), 60000))]);
            const j = JSON.parse(String(g.texto).replace(/^```(json)?|```$/g, '').trim());
            gravar(ARQ_IA(), { em: new Date().toISOString(), base_em: L.atualizado_em, agente: g.agente || null, modelo: g.modelo, cards: (j.cards || []).slice(0, 3) });
        } catch (e) { estIA.erro = e.message; }
        finally { estIA.rodando = false; }
    })();
    return { ok: true };
}
const cardsIA = () => ({ ...lerJson(ARQ_IA(), {}), estado: { ...estIA } });

module.exports = { atualizar, estado, listar, analisarIA, cardsIA, situacao, baixar, estadoBaixa };
