// Configuracao fiscal por produto (22/10/2026): a regra de imposto de cada SKU, sempre com base na Base tributaria do
// contador (lib/base_tributaria.js). Ordem:
//   1. SKU na Base Completa ............................ regra do contador (fonte "base")
//   2. SKU fora da base, mas com NCM conhecido ......... regra de outro SKU da base com o mesmo NCM (fonte "NCM")
//      NCM vem da nota de compra (fiscal_skus.json, dataSeven) ou do cadastro no Olist (ncm_skus.json)
//   3. nada disso ...................................... sem regra: o calculo usa o padrao e a tela avisa
// O NCM do Olist e lido sob pedido (atualizarNcm) e guardado em STORAGE/ncm_skus.json; so le o Olist, nao grava nada nele.
const fs = require('fs');
const os = require('os');
const path = require('path');
const BT = require('./base_tributaria');

const STORAGE = () => process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ARQ_NCM = () => path.join(STORAGE(), 'ncm_skus.json');
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
const dormir = (ms) => new Promise(r => setTimeout(r, ms));

function fontes() { return { compra: lerJson(path.join(STORAGE(), 'fiscal_skus.json'), {}), olist: lerJson(ARQ_NCM(), {}) }; }

// regra fiscal do SKU; f = fontes() (passar quando for chamar muitas vezes)
function regra(sku, f = fontes()) {
    const s = String(sku || '').trim(); if (!s) return null;
    const b0 = BT.doSku(s);
    if (b0) return { ...b0, fonte: b0.par_de ? 'base (par)' : 'base' };
    const c = f.compra[s] || f.compra[s.toUpperCase()] || null, o = f.olist[s] || null;
    const ncm = String((c && c.ncm) || (o && o.ncm) || '').replace(/\D/g, '');
    if (!ncm) return null;
    const bn = BT.porNcm(ncm); if (!bn) return { sku: s, ncm, sem_regra: true, fonte: 'sem regra (NCM fora da base)' };
    const og = c && c.origem != null && c.origem !== '' ? c.origem : o && o.origem != null ? o.origem : null;
    const origem = BT.converterOrigem(og);
    return { ...bn, sku: s, ncm, origem, importado: origem != null ? [1, 2, 3, 8].includes(origem) : bn.importado,
        fonte: `NCM (${c && c.ncm ? 'nota de compra' : 'cadastro do Olist'})` };
}

// le no Olist o NCM/origem dos SKUs que nao estao na base e ainda nao tem NCM (devagar: limite da API)
const est = { rodando: false, feito: 0, total: 0, erro: null, em: null };
function atualizarNcm(skus) {
    if (est.rodando) return { ok: false, erro: 'Já está lendo os NCMs.' };
    const tk = lerJson(path.join(os.homedir(), '.seven', path.basename(path.dirname(STORAGE())) === 'dashboard-cordeiro' ? 'olist_cordeiro.json' : 'olist.json'), {}).token;
    if (!tk) return { ok: false, erro: 'Token do Olist não cadastrado.' };
    const f = fontes();
    const fila = [...new Set(skus.map(s => String(s || '').trim()).filter(Boolean))].filter(s => !BT.doSku(s) && !(f.compra[s] && f.compra[s].ncm) && !(f.olist[s] && (f.olist[s].ncm || f.olist[s].nao_achou)));
    Object.assign(est, { rodando: true, feito: 0, total: fila.length, erro: null });
    const chamar = async (rota, params) => {
        for (let t = 0; t < 5; t++) {
            let j; try { j = (await (await fetch('https://api.tiny.com.br/api2/' + rota, { method: 'POST', body: new URLSearchParams({ token: tk, formato: 'json', ...params }), signal: AbortSignal.timeout(30000) })).json()).retorno; }
            catch { await dormir(3000 * (t + 1)); continue; }
            await dormir(1200);
            if (j.status === 'OK') return j;
            const cod = String(j.codigo_erro || ''), msg = JSON.stringify(j.erros || '').toLowerCase();
            if (cod === '6' || /bloquead|excedido|muitas/.test(msg)) { await dormir(60000); continue; }
            return null;
        }
        return null;
    };
    (async () => {
        const dados = lerJson(ARQ_NCM(), {});
        try {
            for (const s of fila) {
                const r = await chamar('produtos.pesquisa.php', { pesquisa: s });
                const p = (r && r.produtos || []).map(x => x.produto).find(x => String(x.codigo || '').trim().toLowerCase() === s.toLowerCase());
                if (!p) dados[s] = { nao_achou: true, em: new Date().toISOString() };
                else { const d = await chamar('produto.obter.php', { id: p.id }); const pr = d && d.produto;
                    dados[s] = { ncm: pr && pr.ncm ? String(pr.ncm).replace(/\D/g, '') : null, origem: pr ? pr.origem : null, id_olist: p.id, em: new Date().toISOString() }; }
                est.feito++;
                if (est.feito % 10 === 0) fs.writeFileSync(ARQ_NCM(), JSON.stringify(dados, null, 1));
            }
            fs.writeFileSync(ARQ_NCM(), JSON.stringify(dados, null, 1)); est.em = new Date().toISOString();
        } catch (e) { est.erro = e.message; fs.writeFileSync(ARQ_NCM(), JSON.stringify(dados, null, 1)); }
        finally { est.rodando = false; }
    })();
    return { ok: true, total: fila.length };
}
const estado = () => ({ ...est });

module.exports = { regra, fontes, atualizarNcm, estado };

// regime da conta no dia (config.json: regime_tributario { regime: 'lucro_real', desde: 'AAAA-MM' }); sem config = Simples
function regimeNoDia(dia) {
    const rt = lerJson(path.join(STORAGE(), 'config.json'), {}).regime_tributario || {};
    return rt.regime === 'lucro_real' && String(dia || '').slice(0, 7) >= (rt.desde || '9999-99') ? 'lucro_real' : 'simples';
}
// imposto de UMA venda no Lucro Real (Analise de vendas, precos): o mesmo motor da Planilha avancada, item a item,
// pela regra fiscal do SKU e pela UF do comprador (sem UF: SP)
function impostoLucroReal({ sku, qtd = 1, valor, base, custoUnit = null, uf = 'SP', freteVendedor = 0 }, f = fontes()) {
    const b = regra(sku, f), ok = b && !b.sem_regra, c = f.compra[String(sku || '').trim()] || null;
    const rt = lerJson(path.join(STORAGE(), 'config.json'), {}).regime_tributario || {};
    const p = { id: 'x', status: '', state: uf || 'SP', valueWithDiscount: base, totalSale: base, paidFreight: -(freteVendedor || 0), commission: 0, freightDifference: 0, gift: 0, package: 0, totalCost: 0,
        products: [{ sku, quantidade: qtd, preco: valor, custo_unit: custoUnit, cred_icms_nota: c && c.icms_unit != null ? c.icms_unit * qtd : null,
            fiscal: ok ? { ncm: b.ncm, origem: b.origem, importado: b.importado, st: b.st, monofasico: b.monofasico, pis: b.pis, cofins: b.cofins, aliq_interna: b.aliq_interna } : null }] };
    const r = require('./finance_lucro_real').aplicar([p], 'produtos', { cenario: 'normal', ...(rt.opcoes || {}) }, 30).pedidos[0];
    return { imposto: r.tax, icms: r.debitIcms, difal: r.debitDifal, pis: r.debitPis, cofins: r.debitCofins, creditos: r.creditTotal, fonte: ok ? b.fonte : 'sem regra' };
}

module.exports.regimeNoDia = regimeNoDia;
module.exports.impostoLucroReal = impostoLucroReal;
