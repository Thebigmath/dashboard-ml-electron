// Parte fiscal da Planilha avancada (19/10/2026): as NF-e de venda emitidas pelo Olist (a partir de 13/10/2026; antes
// eram emitidas pelo Bling e ficam sem nota aqui). Para cada nota de saida guarda o numero/serie, o pedido do ML
// (numero_ecommerce = pedido ou pacote) e os totais de imposto do XML (ICMSTot):
//   debitos ... ICMS (vICMS), ST (vST), IPI (vIPI), PIS (vPIS), COFINS (vCOFINS), DIFAL (vICMSUFDest + vFCPUFDest)
//   CRT ....... 1 = Simples Nacional: o ICMS/PIS/COFINS vem dentro do DAS e o XML traz zero (CSOSN 500 = ST ja paga
//               na compra). Nesse caso o imposto do pedido = debitos do XML + DAS (aliquota efetiva x base).
//   vTotTrib .. so a estimativa da Lei da Transparencia (IBPT), nao e custo: fica como informacao.
// Creditos (notas de entrada) e imposto de importacao: por SKU, em STORAGE/fiscal_skus.json (por unidade), que a IA
// ou o usuario preenchem. Brinde e embalagem: por pedido, em STORAGE/config.json (planilha_brinde / planilha_embalagem).
// Leitura apenas: nada e gravado no Olist.
const fs = require('fs');
const path = require('path');
const os = require('os');

const STORAGE = () => process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ARQ = () => path.join(STORAGE(), 'finance_fiscal.json');
const ARQ_SKUS = () => path.join(STORAGE(), 'fiscal_skus.json');
const API = 'https://api.tiny.com.br/api2/';
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
const gravarJson = (arq, o) => { fs.mkdirSync(path.dirname(arq), { recursive: true }); fs.writeFileSync(arq, JSON.stringify(o)); };
const dormir = (ms) => new Promise(r => setTimeout(r, ms));
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const br = (iso) => iso.split('-').reverse().join('/');
const token = () => lerJson(path.join(os.homedir(), '.seven', 'olist.json'), {}).token || null;

const estado = { rodando: false, etapa: '', feito: 0, total: 0, erro: null, aviso: null };

async function chamar(rota, params, texto = false) {
    const tk = token(); if (!tk) throw new Error('Token do Olist não cadastrado.');
    for (let t = 0; t < 6; t++) {
        await dormir(1300);   // ritmo da API v2
        let corpo;
        try {
            const r = await fetch(API + rota, { method: 'POST', body: new URLSearchParams({ token: tk, ...(texto ? {} : { formato: 'json' }), ...params }), signal: AbortSignal.timeout(30000) });
            corpo = await r.text();
        } catch { await dormir(3000 * (t + 1)); continue; }
        if (texto) {
            if (/<status>OK<\/status>/.test(corpo)) return corpo;
            if (/<codigo_erro>6<\/codigo_erro>|bloquead|excedid/i.test(corpo)) { estado.aviso = 'O Olist pediu para esperar (limite da API): retomando em 60 s'; await dormir(60000); estado.aviso = null; continue; }
            return null;
        }
        let j; try { j = JSON.parse(corpo).retorno; } catch { continue; }
        if (j.status === 'OK') return j;
        const cod = String(j.codigo_erro || ''), msg = JSON.stringify(j.erros || '').toLowerCase();
        if (cod === '6' || /bloquead|excedido|limite|muitas/.test(msg)) { estado.aviso = 'O Olist pediu para esperar (limite da API): retomando em 60 s'; await dormir(60000); estado.aviso = null; continue; }
        if (cod === '20' || /n[aã]o (retornou|encontr)/.test(msg)) return null;
        throw new Error('Olist: ' + JSON.stringify(j.erros || j).slice(0, 160));
    }
    throw new Error('O Olist não respondeu.');
}

const tag = (x, t) => Number((x.match(new RegExp(`<${t}>([\\d.]+)</${t}>`)) || [])[1] || 0);
function lerXml(xml) {
    const tot = (xml.match(/<ICMSTot>[\s\S]*?<\/ICMSTot>/) || [''])[0];
    return {
        crt: Number((xml.match(/<CRT>(\d)<\/CRT>/) || [])[1] || 0),
        icms: tag(tot, 'vICMS'), st: tag(tot, 'vST'), ipi: tag(tot, 'vIPI'), pis: tag(tot, 'vPIS'), cofins: tag(tot, 'vCOFINS'),
        difal: r2(tag(tot, 'vICMSUFDest') + tag(tot, 'vFCPUFDest')), produtos: tag(tot, 'vProd'), total: tag(tot, 'vNF'), tot_trib: tag(tot, 'vTotTrib'),
        cfop: [...new Set([...xml.matchAll(/<CFOP>(\d+)<\/CFOP>/g)].map(m => m[1]))].join(','),
    };
}

// le as notas de saida do periodo (+5 dias: no Full a nota sai depois do pedido) e o XML das que sao pedidos desta conta
async function coletar({ de, ate, pedidos }) {
    if (estado.rodando) return { ok: false, erro: 'Já está lendo as notas.' };
    if (!token()) return { ok: false, erro: 'Token do Olist não cadastrado.' };
    const meus = new Set((pedidos || []).map(String));
    Object.assign(estado, { rodando: true, etapa: 'Procurando as notas fiscais no Olist…', feito: 0, total: 0, erro: null });
    const D = lerJson(ARQ(), { notas: {}, por_pedido: {} });
    try {
        const fim = new Date(ate + 'T12:00:00Z'); fim.setUTCDate(fim.getUTCDate() + 5);
        const lista = [];
        for (let pag = 1; pag <= 200; pag++) {
            const r = await chamar('notas.fiscais.pesquisa.php', { tipoNota: 'S', dataInicial: br(de), dataFinal: br(fim.toISOString().slice(0, 10)), pagina: pag });
            if (!r) break;
            for (const { nota_fiscal: n } of r.notas_fiscais || []) lista.push(n);
            estado.etapa = `Procurando as notas fiscais no Olist (página ${pag} de ${r.numero_paginas})…`;
            if (pag >= Number(r.numero_paginas || 1)) break;
        }
        const ler = lista.filter(n => meus.has(String(n.numero_ecommerce)) && (!D.notas[n.id] || D.notas[n.id].situacao !== n.descricao_situacao || !D.notas[n.id].xml));
        Object.assign(estado, { etapa: 'Lendo os impostos de cada nota (XML)…', total: ler.length });
        for (const n of lista) {
            if (!meus.has(String(n.numero_ecommerce))) continue;
            const velho = D.notas[n.id] || {};
            D.notas[n.id] = { ...velho, id: n.id, numero: n.numero, serie: n.serie, emissao: n.data_emissao, pedido: String(n.numero_ecommerce), situacao: n.descricao_situacao, valor: Number(n.valor) || 0 };
        }
        for (const n of ler) {
            const xml = await chamar('nota.fiscal.obter.xml.php', { id: n.id }, true);
            if (xml) D.notas[n.id].xml = lerXml(xml);
            estado.feito++;
            if (estado.feito % 25 === 0) gravarJson(ARQ(), D);
        }
        // pedido -> nota valida (a mais recente autorizada)
        D.por_pedido = {};
        for (const n of Object.values(D.notas)) if (!/cancel|deneg|inutil/i.test(n.situacao || '')) {
            const a = D.por_pedido[n.pedido]; if (!a || Number(n.id) > Number(a)) D.por_pedido[n.pedido] = n.id;
        }
        D.atualizado_em = new Date().toISOString();
        gravarJson(ARQ(), D);
        return { ok: true, notas: lista.length, lidas: ler.length };
    } catch (e) { estado.erro = e.message; gravarJson(ARQ(), D); return { ok: false, erro: e.message }; }
    finally { estado.rodando = false; estado.etapa = ''; }
}

// nota do pedido (procura pelo pedido e pelo pacote)
function base() {
    const D = lerJson(ARQ(), { notas: {}, por_pedido: {} });
    return { notaDo: (...ids) => { for (const id of ids.filter(Boolean)) { const n = D.notas[D.por_pedido[String(id)]]; if (n) return n; } return null; },
        skus: lerJson(ARQ_SKUS(), {}), atualizado_em: D.atualizado_em || null, notas: Object.keys(D.notas).length };
}

module.exports = { coletar, base, estado, lerXml };
