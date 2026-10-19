// Base tributaria (19/10/2026): a planilha "Base tributaria 4.0" do contador/consultor (xlsm) importada para o SEVEN.
// E a fonte oficial das regras fiscais por SKU e por estado usadas no Finance (Planilha avancada e simulacao do Lucro Real):
//   Base Completa .. por SKU: NCM, origem, tipo (importado/nacional), ICMS ST?, CEST, MVA, aliquota interna, FCP,
//                    CST PIS/COFINS (04 = monofasico, revenda a aliquota zero), aliquotas de PIS/COFINS, CST IPI, regras
//   ALQ.INTERNA .... por UF de destino (saindo de SP): aliquota interna, FCP, interestadual (importado/nacional), DIFAL
//   ORIGEM ......... tipo de cada origem (0-8) e a aliquota interestadual
//   Atalhos ........ regime, UF, CNPJ, empresa, quem elaborou
// Origem na revenda (tabela do contador): o que veio do fornecedor -> o que a loja cadastra: 1 -> 2 e 6 -> 7; o resto igual.
// Arquivo: STORAGE/base_tributaria.json. So le a planilha (as macros nao rodam).
const fs = require('fs');
const path = require('path');

const STORAGE = () => process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ARQ = () => path.join(STORAGE(), 'base_tributaria.json');
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
const ORIGEM_REVENDA = { 0: 0, 1: 2, 2: 2, 3: 3, 4: 4, 5: 5, 6: 7, 7: 7, 8: 8 };
const converterOrigem = (o) => (o === '' || o == null || isNaN(Number(o))) ? null : (ORIGEM_REVENDA[Number(o)] ?? Number(o));

// valor da celula do exceljs (formula -> resultado, rich text -> texto)
function val(c) {
    let v = c && c.value;
    if (v && typeof v === 'object') { if ('result' in v) v = v.result; else if (v.richText) v = v.richText.map(x => x.text).join(''); else if (v.text) v = v.text; else if (v instanceof Date) v = v.toISOString(); }
    return v == null ? null : v;
}
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
// "1,65%" / 0.0165 / 1.65 -> 1.65 (%)
function pct(v) {
    if (v == null || v === '' || v === '-') return null;
    if (typeof v === 'number') return v <= 1 ? Math.round(v * 10000) / 100 : v;
    const n = Number(String(v).replace('%', '').replace(',', '.').trim()); return isNaN(n) ? null : n;
}
function tabela(ws) {   // linhas da aba com o cabecalho na primeira linha que tiver 3+ textos
    const linhas = []; ws.eachRow({ includeEmpty: false }, (r) => linhas.push(Array.from(r.values.slice(1), x => val({ value: x }))));
    const hi = linhas.findIndex(l => l.filter(x => typeof x === 'string' && x.trim()).length >= 3);
    if (hi < 0) return { cab: [], dados: [] };
    return { cab: Array.from(linhas[hi], norm), dados: linhas.slice(hi + 1) };
}
const col = (cab, ...nomes) => { for (const n of nomes) { const i = cab.indexOf(norm(n)); if (i >= 0) return i; } for (const n of nomes) { const i = cab.findIndex(c => c.startsWith(norm(n))); if (i >= 0) return i; } return -1; };   // nome exato antes do comeco

async function importar(buffer, nome = '') {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const aba = (n) => wb.worksheets.find(w => norm(w.name) === norm(n));
    const out = { arquivo: nome, importado_em: new Date().toISOString(), info: {}, origens: {}, ufs: {}, skus: {} };
    // Atalhos
    const at = aba('Atalhos');
    if (at) at.eachRow((r) => { const v = Array.from(r.values.slice(1), x => val({ value: x })).filter(x => x != null && x !== ''); if (v.length >= 2 && typeof v[0] === 'string') out.info[norm(v[0]).replace(/[:\s]+$/, '').toLowerCase()] = v[1]; });
    // ORIGEM
    const og = aba('ORIGEM');
    if (og) { const { cab, dados } = tabela(og); const io = col(cab, 'Origem'), it = col(cab, 'TIPO');
        for (const l of dados) if (l[io] != null && l[io] !== '') out.origens[Number(l[io])] = { tipo: String(l[it] || '').toUpperCase(), descricao: String(l[col(cab, 'Tabela A')] || '') }; }
    // ALQ.INTERNA (saindo de SP)
    const ai = aba('ALQ.INTERNA');
    if (ai) { const { cab, dados } = tabela(ai); const c = { uf: col(cab, 'UF'), interna: col(cab, 'ALIQ. ICMS INTERNA'), fcp: col(cab, 'FCP'), ii: col(cab, 'ALIQ.ICMS INTERESTADUAL - IMPORTADO'),
            in: col(cab, 'ALIQ.ICMS INTERESTADUAL - NACIONAL'), di: col(cab, 'DIFAL - IMPORTADO'), dn: col(cab, 'DIFAL - NACIONAL'), ibs: col(cab, 'ALQ. IBS'), cbs: col(cab, 'ALQ. CBS') };
        for (const l of dados) { const uf = String(l[c.uf] || '').trim().toUpperCase(); if (!/^[A-Z]{2}$/.test(uf)) continue;
            out.ufs[uf] = { interna: pct(l[c.interna]), fcp: pct(l[c.fcp]) || 0, inter_importado: pct(l[c.ii]), inter_nacional: pct(l[c.in]), difal_importado: pct(l[c.di]), difal_nacional: pct(l[c.dn]), ibs: pct(l[c.ibs]), cbs: pct(l[c.cbs]) }; } }
    // Base Completa
    const bc = aba('Base Completa');
    if (!bc) throw new Error('A planilha não tem a aba "Base Completa".');
    const { cab, dados } = tabela(bc);
    const c = { ncm: col(cab, 'NCM'), sku: col(cab, 'SKU'), desc: col(cab, 'DESCRICAO'), origem: col(cab, 'ORIGEM'), st: col(cab, 'ICMS ST?'), cest: col(cab, 'CEST'), mva: col(cab, 'MVA ORIGINAL'),
        interna: col(cab, 'ALIQ INTERNA'), fcp: col(cab, 'FCP'), beneficio: col(cab, 'BENEFICIO FISCAL'), cstpc: col(cab, 'CST PIS/COFINS'), pis: col(cab, 'ALQ. PIS'), cofins: col(cab, 'ALQ COFINS'),
        cstipi: col(cab, 'CST IPI'), ipi: col(cab, 'IPI (%)'), regra: col(cab, 'REGRA ML'), regra_amz: col(cab, 'REGRA AMAZON'), cstm: col(cab, 'CST MESMO ESTADO'), csto: col(cab, 'CST OUTROS ESTADOS') };
    if (c.sku < 0) throw new Error('Não achei a coluna SKU na aba "Base Completa".');
    for (const l of dados) {
        const sku = String(l[c.sku] ?? '').trim(); if (!sku) continue;
        const origem = l[c.origem] === '' || l[c.origem] == null ? null : Number(l[c.origem]);
        const cstpc = String(l[c.cstpc] || '');
        out.skus[sku.toUpperCase()] = { sku, ncm: String(l[c.ncm] ?? '').replace(/\D/g, ''), descricao: String(l[c.desc] || '').slice(0, 120), origem,
            importado: origem != null && out.origens[origem] ? out.origens[origem].tipo === 'IMPORTADO' : [1, 2, 3, 8].includes(origem),
            st: /POSSUI ST/i.test(String(l[c.st] || '')) && !/N[AÃ]O POSSUI/i.test(norm(l[c.st])), cest: l[c.cest] || null, mva: pct(l[c.mva]),
            aliq_interna: pct(l[c.interna]), fcp: pct(l[c.fcp]) || 0, beneficio: l[c.beneficio] && l[c.beneficio] !== '-' ? l[c.beneficio] : null,
            cst_icms_mesmo_estado: l[c.cstm] || null, cst_icms_outros_estados: l[c.csto] || null,
            cst_pis_cofins: cstpc, monofasico: /^0?4\b/.test(cstpc.trim()), pis: pct(l[c.pis]), cofins: pct(l[c.cofins]), cst_ipi: l[c.cstipi] || null, ipi: pct(l[c.ipi]),
            regra_ml: l[c.regra] || null, regra_amazon: l[c.regra_amz] || null };
    }
    fs.writeFileSync(ARQ(), JSON.stringify(out, null, 1));
    return resumo();
}

let cache = null, cacheMs = 0;
function carregar() {
    let st; try { st = fs.statSync(ARQ()).mtimeMs; } catch { return null; }
    if (!cache || st !== cacheMs) { cache = lerJson(ARQ(), null); cacheMs = st; }
    return cache;
}
// SKU direto; par/kit ("31173D-31173E-par") herda a regra das pecas quando todas estao na base com a mesma regra
function doSku(sku) {
    const b = carregar(); if (!b || !sku) return null;
    const k = String(sku).trim().toUpperCase();
    if (b.skus[k]) return b.skus[k];
    const partes = k.replace(/-(PAR|KIT|JG)$/i, '').split('-').filter(x => x.length >= 4);
    if (partes.length < 2) return null;
    const ps = partes.map(x => b.skus[x]); if (ps.some(x => !x)) return null;
    const igual = (c) => ps.every(x => x[c] === ps[0][c]);
    if (!igual('st') || !igual('monofasico') || !igual('importado')) return null;
    return { ...ps[0], sku: String(sku), par_de: partes };
}
// SKU fora da base: a regra do NCM (da nota de compra), se todos os SKUs da base com esse NCM tem a mesma regra
function porNcm(ncm) {
    const b = carregar(); if (!b || !ncm) return null;
    const L = Object.values(b.skus).filter(x => x.ncm === String(ncm).replace(/\D/g, ''));
    if (!L.length || !L.every(x => x.st === L[0].st && x.monofasico === L[0].monofasico && x.pis === L[0].pis && x.cofins === L[0].cofins)) return null;
    return { ncm: L[0].ncm, origem: null, importado: null, st: L[0].st, monofasico: L[0].monofasico, pis: L[0].pis, cofins: L[0].cofins, aliq_interna: L[0].aliq_interna, pelo_ncm: true, skus_do_ncm: L.length };
}
const daUF = (uf) => { const b = carregar(); return b && uf ? b.ufs[String(uf).toUpperCase()] || null : null; };

function resumo() {
    const b = carregar();
    if (!b) return { importada: false, origem_revenda: ORIGEM_REVENDA };
    const L = Object.values(b.skus);
    return { importada: true, arquivo: b.arquivo, importado_em: b.importado_em, info: b.info, origem_revenda: ORIGEM_REVENDA,
        skus: L.length, monofasicos: L.filter(x => x.monofasico).length, com_st: L.filter(x => x.st).length, importados: L.filter(x => x.importado).length,
        por_origem: L.reduce((a, x) => (a[x.origem] = (a[x.origem] || 0) + 1, a), {}), ufs: Object.keys(b.ufs).length };
}

module.exports = { importar, carregar, doSku, porNcm, daUF, resumo, converterOrigem, ORIGEM_REVENDA };
