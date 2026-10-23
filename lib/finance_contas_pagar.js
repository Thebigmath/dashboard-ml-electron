// Cada empresa le o ERP da propria empresa (23/10/2026): a Flavia le o Bling (pelo Nexus); a Cordeiro NAO tem Bling, entao le o
// Olist dela (contas.pagar.pesquisa.php). O Bling do app Nexus e da Flavia: a Cordeiro nunca pode mostrar as contas dele.
// Contas a pagar (22/10/2026): as contas lancadas no Bling (Financeiro > Contas a pagar), lidas pelo motor Nexus
// (API v3: /contas/pagar). O Olist tem o servico mas nao tem contas lancadas, entao a fonte e o Bling.
// So le: nada e baixado, pago ou alterado no Bling.
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

// situacao da tela: em aberto vira "vence hoje" ou "atrasada" pelo vencimento
function situacao(c, hoje = hojeBR()) {
    const s = SIT_BLING[c.situacao] || 'aberta';
    if (s !== 'aberta' && s !== 'parcial') return s;
    return c.vencimento < hoje ? 'atrasada' : c.vencimento === hoje ? 'vence_hoje' : s;
}

// Cordeiro: contas a pagar do Olist dela (API v2). Sem contas lancadas la, a lista fica vazia e a tela avisa.
async function atualizarOlist(de, ate) {
    const tk = lerJson(path.join(require('os').homedir(), '.seven', 'olist_cordeiro.json'), {}).token;
    if (!tk) throw new Error('Token do Olist da Cordeiro não cadastrado.');
    const br = (d) => d.split('-').reverse().join('/'), iso = (d) => String(d || '').split('/').reverse().join('-');
    const base = { contas: {}, contatos: {}, formas: {}, categorias: {}, fonte: 'Olist da Cordeiro' };
    for (let pg = 1; ; pg++) {
        const j = (await (await fetch('https://api.tiny.com.br/api2/contas.pagar.pesquisa.php', { method: 'POST', body: new URLSearchParams({ token: tk, formato: 'json', data_ini_vencimento: br(de), data_fim_vencimento: br(ate), pagina: String(pg) }) })).json()).retorno;
        if (j.status !== 'OK') break;
        for (const x of j.contas || []) {
            const c = x.conta || x, nome = c.nome_cliente || c.cliente || '—', sit = /pag|liquid/i.test(c.situacao || '') ? 2 : /cancel/i.test(c.situacao || '') ? 5 : 1;
            base.contas['o' + c.id] = { id: 'o' + c.id, situacao: sit, vencimento: iso(c.data_vencimento || c.vencimento), valor: Number(c.valor), contato: nome, forma: null, categoria: c.categoria || null,
                historico: c.historico || '', documento: c.nro_documento || '', detalhe: true };
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
    const hoje = hojeBR();
    de = /^\d{4}-\d{2}-\d{2}$/.test(de || '') ? de : somaDias(hoje, -60); ate = /^\d{4}-\d{2}-\d{2}$/.test(ate || '') ? ate : somaDias(hoje, 60);
    Object.assign(est, { rodando: true, etapa: EH_CORDEIRO ? 'Lendo as contas no Olist…' : 'Lendo as contas no Bling…', feito: 0, total: 0, erro: null });
    (async () => {
        try {
            if (EH_CORDEIRO) { await atualizarOlist(de, ate); return; }
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
            est.erro = !EH_CORDEIRO && /insufficient_scope|403/.test(e.message) ? 'O app NEXUS ENGINE no Bling ainda não tem permissão de Contas a pagar (e Contatos). Libere os escopos e autorize de novo.' : e.message;
        } finally { Object.assign(est, { rodando: false, etapa: '' }); }
    })();
    return { ok: true };
}
const estado = () => ({ ...est });

function listar({ de, ate } = {}) {
    const b = lerJson(ARQ(), null), hoje = hojeBR();
    if (!b) return { lido: false, hoje, linhas: [], resumo: null };
    const linhas = Object.values(b.contas).filter(c => (!de || c.vencimento >= de) && (!ate || c.vencimento <= ate)).map(c => ({
        id: c.id, fornecedor: b.contatos[c.contato] || '—', historico: c.historico || '', documento: c.documento || '', forma: b.formas[c.forma] || '—',
        categoria: b.categorias[c.categoria] || '', vencimento: c.vencimento, valor: r2(c.valor), situacao: situacao(c, hoje) }));
    const abertas = linhas.filter(l => ['aberta', 'parcial', 'vence_hoje', 'atrasada'].includes(l.situacao)), soma = (L) => r2(L.reduce((s, l) => s + l.valor, 0));
    const ate7 = somaDias(hoje, 7);
    return { lido: true, hoje, atualizado_em: b.atualizado_em, periodo: b.periodo, linhas: linhas.sort((x, y) => x.vencimento.localeCompare(y.vencimento) || y.valor - x.valor),
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
            const g = await Promise.race([ia.gerarGemini(sistema, prompt, 900, 'gemini-3.1-flash-lite', { json: true, area: 'finance', agente: 'fin_caixa', tarefa: 'Contas a pagar: 3 cards de resumo' }),
                new Promise((_, rej) => setTimeout(() => rej(new Error('a IA demorou mais de 60 s')), 60000))]);
            const j = JSON.parse(String(g.texto).replace(/^```(json)?|```$/g, '').trim());
            gravar(ARQ_IA(), { em: new Date().toISOString(), base_em: L.atualizado_em, agente: g.agente || null, modelo: g.modelo, cards: (j.cards || []).slice(0, 3) });
        } catch (e) { estIA.erro = e.message; }
        finally { estIA.rodando = false; }
    })();
    return { ok: true };
}
const cardsIA = () => ({ ...lerJson(ARQ_IA(), {}), estado: { ...estIA } });

module.exports = { atualizar, estado, listar, analisarIA, cardsIA, situacao };
