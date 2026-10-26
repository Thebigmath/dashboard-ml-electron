// Notas de fornecedores -> Contas a pagar do Olist (26/10/2026): o dono sobe o PDF da nota (DANFE), a IA le a FATURA / DUPLICATA
// (o Gemini do Finance, agente "Contas a pagar e receber", le o proprio PDF, texto ou imagem), o motor CONFERE com uma SEGUNDA LEITURA
// independente (o texto do PDF) e a PONTE manda cada parcela para o Contas a pagar do Olist da empresa.
//
// Exatidao (a prioridade): nada e enviado sem passar por TODAS estas travas.
//   1. chave de acesso: 44 digitos, digito verificador; dela saem o CNPJ do fornecedor, o numero e o mes da nota (a chave vence a IA)
//   2. cada numero que a IA devolveu (chave, total, valor e data de cada parcela, CNPJ) precisa existir no texto do PDF
//   3. a soma das parcelas tem de bater com o total da nota; vencimentos em ordem e depois da emissao
//   4. a nota tem de ser DESTA empresa (CNPJ do destinatario); nota de outra empresa fica bloqueada
//   5. nota ja enviada nao entra de novo; parcela que ja existe no Olist (mesmo vencimento e valor) nao e criada
//   6. "ok" segue direto; "conferir" so com a confirmacao da pessoa na tela; "bloqueada" nunca
//   7. depois de enviar, le o Olist de volta e confirma que a conta existe com o mesmo valor e vencimento
//   8. o lote so abre depois de uma nota de TESTE enviada e confirmada
// Ponte: conta.pagar.incluir.php (API v2), uma conta por parcela (ocorrencia unica), documento "NF-parcela/total" (limite de 9 caracteres
// do Olist), historico com a NF, a parcela, o fornecedor e a chave. 60 chamadas por minuto: espaca ~1,02 s. Cada empresa usa o Olist
// dela (olist.json = Flavia, olist_cordeiro.json = Cordeiro). Registro: STORAGE/notas_contas.json e notas_contas_log.jsonl.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const STORAGE = () => process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ARQ = () => path.join(STORAGE(), 'notas_contas.json');
const LOG = () => path.join(STORAGE(), 'notas_contas_log.jsonl');
const PASTA_PDF = () => path.join(STORAGE(), 'notas_pdf');
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
const gravar = (arq, o) => { fs.mkdirSync(path.dirname(arq), { recursive: true }); fs.writeFileSync(arq, JSON.stringify(o)); };
const registrar = (o) => { try { fs.mkdirSync(path.dirname(LOG()), { recursive: true }); fs.appendFileSync(LOG(), JSON.stringify({ em: new Date().toISOString(), ...o }) + '\n'); } catch {} };
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const dormir = (ms) => new Promise(r => setTimeout(r, ms));
const soDigitos = (s) => String(s == null ? '' : s).replace(/\D/g, '');
const brFmt = (v) => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cnpjFmt = (c) => c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
const dataBR = (d) => d ? d.split('-').reverse().join('/') : '';
const EH_CORDEIRO = () => path.basename(path.dirname(STORAGE())) === 'dashboard-cordeiro';
// CNPJ da Flavia (Base tributaria / notas de compra). A Cordeiro ainda nao tem o CNPJ configurado: a tela pede a confirmacao uma vez.
const CNPJ_PADRAO = { flavia: '21916776000126', cordeiro: '62222059000181' };   // conferidos no info.php do Olist de cada empresa em 26/10/2026

const ARQ_EMP = () => path.join(STORAGE(), 'olist_empresa.json');
// A empresa e a do Olist CONECTADO (info.php do token): assim a nota so segue se o destinatario for a conta onde as contas vao cair.
// Sem leitura do Olist, vale o CNPJ configurado ou o padrao.
function empresa() {
    const cfg = lerJson(path.join(STORAGE(), 'config.json'), {}), cordeiro = EH_CORDEIRO(), o = lerJson(ARQ_EMP(), null);
    return { nome: cordeiro ? 'Cordeiro' : 'Flavia', cnpj: (o && o.cnpj) || soDigitos(cfg.empresa_cnpj) || CNPJ_PADRAO[cordeiro ? 'cordeiro' : 'flavia'] || null,
        razao_social: o ? o.razao_social : null, fantasia: o ? o.fantasia : null, origem_cnpj: o ? 'olist' : cfg.empresa_cnpj ? 'config' : 'padrao', olist: cordeiro ? 'olist_cordeiro.json' : 'olist.json' };
}
async function empresaDoOlist(forcar = false) {
    const atual = lerJson(ARQ_EMP(), null);
    if (atual && !forcar && Date.now() - Date.parse(atual.em) < 7 * 86400000) return atual;
    const j = await olist('info.php', {});
    if (j.status !== 'OK' || !j.conta) throw new Error('Não consegui ler a conta do Olist (' + erroDo(j) + ').');
    const e = { cnpj: soDigitos(j.conta.cnpj_cpf), razao_social: j.conta.razao_social || null, fantasia: j.conta.fantasia || null, em: new Date().toISOString() };
    if (!cnpjValido(e.cnpj)) throw new Error('O Olist devolveu um CNPJ inválido.');
    gravar(ARQ_EMP(), e); reconferirTodas(); return e;
}
function reconferirTodas() { const D = lerDados(); for (const n of Object.values(D.notas)) if (!n.parcelas.some(p => ['enviada', 'confirmada', 'duplicada'].includes(p.status))) reconferirEmpresa(n); gravar(ARQ(), D); }
function definirCnpj(cnpj) {
    const d = soDigitos(cnpj); if (!cnpjValido(d)) throw new Error('CNPJ inválido.');
    const arq = path.join(STORAGE(), 'config.json'), cfg = lerJson(arq, {}); cfg.empresa_cnpj = d; gravar(arq, cfg);
    // as notas que estavam bloqueadas por "outra empresa" sao conferidas de novo contra o CNPJ certo
    reconferirTodas(); return empresa();
}

// ---------------------------------------------------------------- validacoes (sem IA)
function cnpjValido(c) {
    c = soDigitos(c); if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
    const dv = (n) => { let s = 0, p = n - 7; for (let i = 0; i < n; i++) { s += Number(c[i]) * p--; if (p < 2) p = 9; } const r = s % 11; return r < 2 ? 0 : 11 - r; };
    return dv(12) === Number(c[12]) && dv(13) === Number(c[13]);
}
function chaveValida(k) {
    k = soDigitos(k); if (k.length !== 44) return false;
    let s = 0, p = 2; for (let i = 42; i >= 0; i--) { s += Number(k[i]) * p; p = p === 9 ? 2 : p + 1; }
    const r = s % 11, dv = r < 2 ? 0 : 11 - r; return dv === Number(k[43]);
}
// numero com virgula decimal brasileira ("6.462,83") ou numero puro
function numero(v) {
    if (typeof v === 'number') return r2(v);
    let s = String(v == null ? '' : v).replace(/[^\d,.\-]/g, ''); if (!s) return null;
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, '');
    const n = Number(s); return isFinite(n) ? r2(n) : null;
}
// data "dd/mm/aaaa", "dd/mm/aa" ou "aaaa-mm-dd" -> "aaaa-mm-dd"
function data(v) {
    const s = String(v || '').trim(); let m;
    if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
    if ((m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/))) { let a = Number(m[3]); if (a < 100) a += 2000; return `${a}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`; }
    return null;
}
const dataOk = (d) => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d + 'T12:00:00Z'));

// ---------------------------------------------------------------- 1a leitura: IA (le o PDF, texto ou imagem)
const SISTEMA = 'Você lê notas fiscais eletrônicas (DANFE) em PDF de fornecedores de uma loja de autopeças e extrai os dados para o Contas a pagar. Copie EXATAMENTE o que está impresso na nota; nunca calcule, estime nem complete. Se um campo não existir, use null. Datas no formato dd/mm/aaaa como impressas. Valores como impressos (ex.: 6.462,83).';
const PROMPT = `Leia esta nota fiscal (DANFE) e responda SOMENTE com este JSON:
{
 "emitente": {"nome": "razão social de quem EMITIU a nota (o fornecedor)", "cnpj": "CNPJ do emitente"},
 "destinatario": {"nome": "razão social do destinatário", "cnpj": "CNPJ ou CPF do destinatário"},
 "nota": {"numero": "número da NF-e", "serie": "série", "chave": "chave de acesso de 44 dígitos (só números)", "emissao": "data de emissão", "valor_total": "VALOR TOTAL DA NOTA", "valor_produtos": "VALOR TOTAL DOS PRODUTOS"},
 "parcelas": [{"numero": "número da duplicata como impresso (ex.: 001 ou 40095-1/3)", "vencimento": "data de vencimento", "valor": "valor da parcela"}],
 "pagamento": "forma de pagamento se estiver impressa (ex.: boleto, à vista), senão null",
 "observacao": "qualquer aviso de cobrança que mude o que será pago (ex.: 'pagamento antecipado'), senão null"
}
Regras: "parcelas" vem do quadro FATURA / DUPLICATA (cada duplicata é uma parcela, na ordem em que aparecem). Se o quadro estiver vazio ou não existir, devolva "parcelas": []. Não invente parcelas a partir do total. O emitente é o fornecedor que vende (quem aparece no topo, junto da chave de acesso), nunca o transportador.`;

async function lerComIA(buffer, nomeArquivo) {
    const ia = require('./ia');
    const contents = [{ role: 'user', parts: [{ inline_data: { mime_type: 'application/pdf', data: buffer.toString('base64') } }, { text: PROMPT }] }];
    const chamar = (area, agente) => Promise.race([ia.gerarGemini(SISTEMA, null, 3000, 'gemini-3.1-flash-lite', { json: true, contents, area, agente, tarefa: 'Notas de fornecedores: ler fatura/duplicata · ' + String(nomeArquivo || '').slice(0, 50) }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('a IA demorou mais de 90 s')), 90000))]);
    // o agente "Contas a pagar e receber" do Finance; se o Finance ainda nao tem chave neste PC, o agente de Atendimento do ADS Health le (a tela mostra quem leu)
    let g; try { g = await chamar('finance', 'fin_contas'); } catch (e) { if (!/não cadastrada/i.test(e.message)) throw e; g = await chamar('ads_health', 'ads_atendimento'); }
    let j; try { j = JSON.parse(String(g.texto).replace(/^```(json)?|```$/g, '').trim()); } catch { throw new Error('A IA não devolveu um JSON legível.'); }
    return { dados: j, agente: g.agente || null, modelo: g.modelo || null };
}

// ---------------------------------------------------------------- 2a leitura: o texto do PDF (pdf-parse ja e dependencia do app)
async function lerTexto(buffer) { try { return String((await require('pdf-parse')(buffer)).text || ''); } catch { return ''; } }
// chave de acesso impressa no DANFE: 11 grupos de 4 digitos; so vale a que passa no digito verificador (modelo 55)
function chaveDoTexto(texto) {
    for (const g of String(texto || '').match(/(?:\d{4}[  ]?){11}/g) || []) { const k = soDigitos(g); if (k.length === 44 && chaveValida(k) && k.slice(20, 22) === '55') return k; }
    return null;
}
// cada numero da IA precisa existir no texto do PDF; o quadro FATURA/DUPLICATA lido do texto tem de dar as mesmas parcelas
function verificarNoTexto(texto, c) {
    const v = { texto: false, falhas: [], graves: [], quadro: null };
    const sem = String(texto || '').replace(/\s+/g, ''); v.texto = sem.length > 300;
    if (!v.texto) { v.falhas.push('O PDF não tem texto embutido (é imagem): só a IA leu. Confira cada valor, cada data e a chave de acesso na tela.'); return v; }
    const tem = (s) => sem.includes(String(s).replace(/\s+/g, ''));
    if (c.nota.chave && !tem(c.nota.chave)) v.graves.push('A chave de acesso lida pela IA não existe no texto do PDF.');
    if (c.emitente.cnpj && !tem(cnpjFmt(c.emitente.cnpj)) && !tem(c.emitente.cnpj)) v.falhas.push('O CNPJ do fornecedor não aparece no texto do PDF.');
    if (c.nota.valor_total && !tem(brFmt(c.nota.valor_total))) v.falhas.push(`O valor total da nota (R$ ${brFmt(c.nota.valor_total)}) não aparece no texto do PDF.`);
    for (const p of c.parcelas) {
        if (p.valor && c.parcelas_da_ia && !tem(brFmt(p.valor))) v.falhas.push(`O valor da parcela ${p.n} (R$ ${brFmt(p.valor)}) não aparece no texto do PDF.`);
        if (p.vencimento && c.parcelas_da_ia) { const [y, m, d] = p.vencimento.split('-'); if (!tem(`${d}/${m}/${y}`) && !tem(`${d}/${m}/${y.slice(2)}`)) v.falhas.push(`O vencimento da parcela ${p.n} (${dataBR(p.vencimento)}) não aparece no texto do PDF.`); }
    }
    // quadro lido do texto: pares data -> valor entre "FATURA" e "CALCULO DO IMPOSTO"
    const T = String(texto), U = T.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, ''), i = U.indexOf('FATURA'); let j = i >= 0 ? U.indexOf('CALCULO DO IMPOSTO', i) : -1;
    if (i >= 0 && j > i && c.parcelas_da_ia) {
        const seg = T.slice(i, j), pares = [];
        for (const m of seg.matchAll(/(\d{2}\/\d{2}\/\d{2,4})[^\d]{0,40}?(?:\d+\s*-\s*\d+\s*\/\s*\d+)?[^\d]{0,12}?(?:R\$\s*)?(\d{1,3}(?:\.\d{3})*,\d{2})/g)) pares.push([data(m[1]), numero(m[2])]);
        if (pares.length) {
            v.quadro = pares.map(([d, x]) => ({ vencimento: d, valor: x }));
            const mesmo = pares.length === c.parcelas.length && pares.every(([d, x], k) => d === c.parcelas[k].vencimento && Math.abs(x - c.parcelas[k].valor) < 0.005);
            if (!mesmo) v.falhas.push('O quadro de duplicatas lido do texto do PDF é diferente do que a IA leu (' + pares.map(([d, x]) => `${dataBR(d)} R$ ${brFmt(x)}`).join(' · ') + '). Confira na tela.');
        }
    }
    return v;
}

// ---------------------------------------------------------------- conferencia
// Nota cujo destinatario NAO e a empresa deste Olist: AVISO que pede a confirmacao da pessoa (nao e mais bloqueio, 26/10/2026).
const outraEmpresaMsg = (dest, emp) => {
    const dela = dest.cnpj === CNPJ_PADRAO.flavia ? 'Flavia' : dest.cnpj === CNPJ_PADRAO.cordeiro ? 'Cordeiro' : null;
    return `Atenção: esta nota é de outro destinatário (${dest.nome || '—'} · ${dest.cnpj || 'sem CNPJ'}), mas este app lança no Olist da ${emp.nome}.${dela && dela !== emp.nome ? ` O normal é subir no app da ${dela}.` : ''} Confirme se é isso mesmo.`;
};
function conferir(bruto, emp = empresa(), texto = null) {
    const avisos = [], graves = [];
    const e = bruto.emitente || {}, d = bruto.destinatario || {}, n = bruto.nota || {};
    let chave = soDigitos(n.chave);
    const nota = { numero: String(n.numero || '').replace(/\D/g, '').replace(/^0+/, '') || null, serie: String(n.serie || '').trim() || null, chave: null,
        emissao: data(n.emissao), valor_total: numero(n.valor_total), valor_produtos: numero(n.valor_produtos) };
    const emitente = { nome: String(e.nome || '').trim(), cnpj: soDigitos(e.cnpj) }, dest = { nome: String(d.nome || '').trim(), cnpj: soDigitos(d.cnpj) };
    // chave: a da IA se valida; senao a que esta impressa no texto do PDF
    if (chave.length === 44 && chaveValida(chave)) nota.chave = chave;
    else { const doTexto = chaveDoTexto(texto); if (doTexto) { nota.chave = doTexto; avisos.push('A chave de acesso foi tirada do texto do PDF (a IA não a leu corretamente).'); } else if (chave.length) graves.push('A chave de acesso lida não passa na conferência do dígito verificador: algum número foi lido errado.'); }
    if (!nota.chave && !graves.length) graves.push('Chave de acesso não encontrada: sem ela não dá para evitar nota repetida.');
    if (nota.chave) {
        // da chave: CNPJ do emitente (pos. 6-19), numero (25-33) e AAMM da emissao (2-5)
        const cnpjChave = nota.chave.slice(6, 20), numChave = String(Number(nota.chave.slice(25, 34))), aamm = nota.chave.slice(2, 6);
        if (emitente.cnpj !== cnpjChave) { avisos.push(`CNPJ do fornecedor corrigido pela chave de acesso (${emitente.cnpj || 'vazio'} → ${cnpjChave}).`); emitente.cnpj = cnpjChave; }
        if (nota.numero !== numChave) { avisos.push(`Número da nota corrigido pela chave de acesso (${nota.numero || 'vazio'} → ${numChave}).`); nota.numero = numChave; }
        if (nota.emissao && nota.emissao.slice(2, 4) + nota.emissao.slice(5, 7) !== aamm) avisos.push('A data de emissão lida não bate com o mês da chave de acesso.');
    }
    if (!cnpjValido(emitente.cnpj)) graves.push('CNPJ do fornecedor inválido.');
    if (!emitente.nome) graves.push('Nome do fornecedor não encontrado.');
    if (!dataOk(nota.emissao)) graves.push('Data de emissão não encontrada.');
    if (!(nota.valor_total > 0)) graves.push('Valor total da nota não encontrado.');
    // empresa: a nota tem de ser desta empresa
    let empresaOk = null;
    if (emp.cnpj) { empresaOk = dest.cnpj === emp.cnpj; if (!empresaOk) avisos.push(outraEmpresaMsg(dest, emp)); }
    else avisos.push(`O CNPJ da empresa (${emp.nome}) ainda não está configurado: confirme que o destinatário ${dest.nome} (${dest.cnpj}) é a empresa certa.`);
    // parcelas
    const daIA = Array.isArray(bruto.parcelas) && bruto.parcelas.length > 0;
    let parcelas = (Array.isArray(bruto.parcelas) ? bruto.parcelas : []).map((p, i) => ({ n: i + 1, doc: String(p.numero || '').trim() || null, vencimento: data(p.vencimento), valor: numero(p.valor) }));
    const ruins = parcelas.filter(p => !dataOk(p.vencimento) || !(p.valor > 0));
    if (ruins.length) avisos.push(`${ruins.length} parcela(s) com vencimento ou valor ilegível: corrija na tela.`);
    if (!parcelas.length) { avisos.push('A nota não tem FATURA / DUPLICATA (ou a IA não achou): se for pagamento à vista, informe o vencimento na tela.'); parcelas = [{ n: 1, doc: null, vencimento: null, valor: nota.valor_total }]; }
    for (const p of parcelas) p.total = parcelas.length;
    const soma = r2(parcelas.reduce((s, p) => s + (p.valor || 0), 0));
    if (nota.valor_total && Math.abs(soma - nota.valor_total) > 0.05) avisos.push(`A soma das parcelas (R$ ${brFmt(soma)}) é diferente do valor total da nota (R$ ${brFmt(nota.valor_total)}).`);
    if (dataOk(nota.emissao)) for (const p of parcelas) if (dataOk(p.vencimento) && p.vencimento < nota.emissao) avisos.push(`A parcela ${p.n} vence antes da emissão da nota.`);
    for (let i = 1; i < parcelas.length; i++) if (dataOk(parcelas[i].vencimento) && dataOk(parcelas[i - 1].vencimento) && parcelas[i].vencimento < parcelas[i - 1].vencimento) { avisos.push('Os vencimentos não estão em ordem crescente.'); break; }
    const c = { emitente, destinatario: dest, nota, parcelas, parcelas_da_ia: daIA, soma_parcelas: soma, pagamento: bruto.pagamento || null, observacao_nota: bruto.observacao || null, empresa_ok: empresaOk, avisos, graves };
    // 2a leitura (texto do PDF)
    if (texto !== null) { const v = verificarNoTexto(texto, c); c.verificacao = { texto: v.texto, quadro_do_texto: v.quadro }; graves.push(...v.graves); avisos.push(...v.falhas); }
    c.situacao = graves.length ? 'bloqueada' : avisos.length ? 'conferir' : 'ok';
    return c;
}
// depois de editar na tela ou de configurar o CNPJ: refaz so o que depende disso
function recalcular(n) {
    n.soma_parcelas = r2(n.parcelas.reduce((s, p) => s + (Number(p.valor) || 0), 0));
    n.avisos = (n.avisos || []).filter(a => !/^A soma das parcelas|^\d+ parcela\(s\) com vencimento/.test(a));
    const ruins = n.parcelas.filter(p => !dataOk(p.vencimento) || !(Number(p.valor) > 0));
    if (ruins.length) n.avisos.push(`${ruins.length} parcela(s) com vencimento ou valor ilegível: corrija na tela.`);
    if (n.nota.valor_total && Math.abs(n.soma_parcelas - n.nota.valor_total) > 0.05) n.avisos.push(`A soma das parcelas (R$ ${brFmt(n.soma_parcelas)}) é diferente do valor total da nota (R$ ${brFmt(n.nota.valor_total)}).`);
    n.situacao = n.graves.length ? 'bloqueada' : n.avisos.length ? 'conferir' : 'ok';
}
function reconferirEmpresa(n) {
    const emp = empresa(); n.graves = (n.graves || []).filter(g => !/^Nota de outra empresa/.test(g)); n.avisos = (n.avisos || []).filter(a => !/^O CNPJ da empresa|^Atenção: esta nota é de outro destinatário/.test(a));
    if (emp.cnpj) { n.empresa_ok = n.destinatario.cnpj === emp.cnpj; if (!n.empresa_ok) n.avisos.push(outraEmpresaMsg(n.destinatario, emp)); }
    recalcular(n);
}

// ---------------------------------------------------------------- registro das notas
const lerDados = () => lerJson(ARQ(), { notas: {}, teste_confirmado_em: null });
const idDa = (c, buffer) => c.nota.chave ? c.nota.chave : 'h' + crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 20);
const est = { rodando: false, enviando: false, etapa: '', feito: 0, total: 0, erro: null, em: null, resultados: [] };

// arquivos: [{ nome, caminho }]  (o arquivo temporario e apagado depois de lido)
function ler(arquivos) {
    if (est.rodando || est.enviando) return { ok: false, erro: 'Já está trabalhando. Espere terminar.' };
    Object.assign(est, { rodando: true, etapa: 'Lendo as notas…', feito: 0, total: arquivos.length, erro: null, resultados: [] });
    (async () => {
        try {
            try { await empresaDoOlist(); } catch {}   // o CNPJ da empresa vem do Olist conectado (se nao der, vale o configurado)
            for (const a of arquivos) {
                const res = { arquivo: a.nome };
                try {
                    const buffer = fs.readFileSync(a.caminho);
                    if (buffer.slice(0, 4).toString() !== '%PDF') throw new Error('Não é um PDF.');
                    est.etapa = `Lendo ${a.nome}…`;
                    const [{ dados, agente, modelo }, texto] = [await lerComIA(buffer, a.nome), await lerTexto(buffer)];
                    const c = conferir(dados, empresa(), texto), id = idDa(c, buffer), D = lerDados(), antiga = D.notas[id];
                    res.id = id;
                    if (antiga && antiga.parcelas.some(p => ['enviada', 'confirmada'].includes(p.status))) { res.ja = true; res.aviso = 'Esta nota já foi enviada ao Olist.'; }
                    else {
                        fs.mkdirSync(PASTA_PDF(), { recursive: true }); fs.writeFileSync(path.join(PASTA_PDF(), id + '.pdf'), buffer);
                        D.notas[id] = { id, arquivo: a.nome, lido_em: new Date().toISOString(), agente, modelo, ...c, parcelas: c.parcelas.map(p => ({ ...p, status: 'pendente', categoria: null })), repetida: !!antiga, confirmo: false };
                        gravar(ARQ(), D); registrar({ evento: 'lida', id, arquivo: a.nome, situacao: c.situacao, parcelas: c.parcelas.length, total: c.nota.valor_total });
                        res.situacao = c.situacao;
                    }
                } catch (e) { res.erro = e.message; registrar({ evento: 'erro_leitura', arquivo: a.nome, erro: e.message }); }
                try { fs.unlinkSync(a.caminho); } catch {}
                est.resultados.push(res); est.feito++;
            }
        } catch (e) { est.erro = e.message; }
        finally { Object.assign(est, { rodando: false, etapa: '', em: new Date().toISOString() }); }
    })();
    return { ok: true };
}

function atualizar(id, patch = {}) {
    if (est.rodando || est.enviando) throw new Error('Espere a leitura ou o envio terminar para editar.');
    const D = lerDados(), n = D.notas[id]; if (!n) throw new Error('Nota não encontrada.');
    if (n.parcelas.every(p => ['enviada', 'confirmada'].includes(p.status))) throw new Error('Esta nota já foi enviada ao Olist: não dá para editar.');
    if (patch.confirmo !== undefined) n.confirmo = !!patch.confirmo;
    if (patch.forcar !== undefined) n.forcar = !!patch.forcar;
    for (const e of patch.parcelas || []) {
        const p = n.parcelas.find(x => x.n === Number(e.n)); if (!p) continue;
        if (['enviada', 'confirmada'].includes(p.status)) throw new Error(`A parcela ${p.n} já foi enviada ao Olist: não dá para editar.`);
        if (e.vencimento !== undefined) { const d = data(e.vencimento); if (e.vencimento && !d) throw new Error('Data inválida.'); p.vencimento = d; p.editada = true; p.status = 'pendente'; p.erro = null; }
        if (e.valor !== undefined) { const v = numero(e.valor); if (e.valor !== '' && e.valor !== null && !(v > 0)) throw new Error('Valor inválido.'); p.valor = v; p.editada = true; p.status = 'pendente'; p.erro = null; }
        if (e.categoria !== undefined) p.categoria = String(e.categoria || '').trim().slice(0, 60) || null;
    }
    if (patch.categoria_geral !== undefined) for (const p of n.parcelas) p.categoria = String(patch.categoria_geral || '').trim().slice(0, 60) || null;
    if ((patch.parcelas || []).some(e => e.vencimento !== undefined || e.valor !== undefined)) { n.confirmo = false; n.editada = true; }   // mexeu no valor ou na data: confirma de novo
    recalcular(n); gravar(ARQ(), D); registrar({ evento: 'editada', id, patch });
    return n;
}
function remover(id) {
    if (est.rodando || est.enviando) throw new Error('Espere a leitura ou o envio terminar.');
    const D = lerDados(), n = D.notas[id]; if (!n) return { ok: true };
    if (n.parcelas.some(p => ['enviada', 'confirmada'].includes(p.status))) throw new Error('Esta nota já foi enviada ao Olist: não dá para tirar da lista.');
    delete D.notas[id]; gravar(ARQ(), D); try { fs.unlinkSync(path.join(PASTA_PDF(), id + '.pdf')); } catch {}
    registrar({ evento: 'removida', id }); return { ok: true };
}

// uma nota pode seguir para o Olist?
function podeEnviar(n) {
    if (n.graves && n.graves.length) return { ok: false, motivo: n.graves[0] };
    if (n.situacao === 'conferir' && !n.confirmo) return { ok: false, motivo: 'Precisa da sua confirmação (há avisos na conferência).' };
    for (const p of n.parcelas) if (!dataOk(p.vencimento) || !(Number(p.valor) > 0)) return { ok: false, motivo: `A parcela ${p.n} está sem vencimento ou valor.` };
    return { ok: true };
}

// ---------------------------------------------------------------- ponte: Olist (API v2)
const tokenOlist = () => lerJson(path.join(os.homedir(), '.seven', empresa().olist), {}).token || null;
let proxima = 0;
async function vez() { const agora = Date.now(), v = Math.max(agora, proxima); proxima = v + 1020; if (v > agora) await dormir(v - agora); }   // 60 chamadas/min
async function olist(rota, params) {
    const tk = tokenOlist(); if (!tk) throw new Error(`Token do Olist da ${empresa().nome} não cadastrado.`);
    for (let t = 0; t < 6; t++) {
        await vez();
        let j;
        try { j = (await (await fetch('https://api.tiny.com.br/api2/' + rota, { method: 'POST', body: new URLSearchParams({ token: tk, formato: 'json', ...params }), signal: AbortSignal.timeout(30000) })).json()).retorno; }
        catch { await dormir(3000 * (t + 1)); continue; }
        const cod = String(j.codigo_erro || ''), msg = JSON.stringify(j.erros || j.registros || '').toLowerCase();
        if (j.status !== 'OK' && (cod === '6' || /bloquead|excedido|muitas/.test(msg))) { await dormir(60000); continue; }
        return j;
    }
    throw new Error('O Olist não respondeu.');
}
const idDoRetorno = (j) => (j.registros && (j.registros[0] ? (j.registros[0].registro || {}).id : (j.registros.registro || {}).id)) || j.id || null;
const erroDo = (j) => JSON.stringify((j.registros && (j.registros[0] ? (j.registros[0].registro || {}).erros : (j.registros.registro || {}).erros)) || j.erros || j).slice(0, 300);

// o numero do documento no Olist tem no maximo 9 caracteres: "40095-1/3"; numero maior perde o inicio (o texto inteiro fica no historico)
function documentoDe(nota, p) {
    const nf = String(nota.nota ? nota.nota.numero : nota.numero), sufixo = `-${p.n}/${p.total}`;   // aceita a nota inteira ou so o bloco "nota"
    return (nf.length + sufixo.length <= 9 ? nf : nf.slice(-(9 - sufixo.length))) + sufixo;
}
function montarConta(nota, p) {
    const hist = [`NF ${nota.nota.numero}${nota.nota.serie ? '/' + nota.nota.serie : ''}`, `parcela ${p.n}/${p.total}`, nota.emitente.nome, p.categoria ? 'Cat. ' + p.categoria : '', `chave ${nota.nota.chave}`].filter(Boolean).join(' · ').slice(0, 300);
    return { data: dataBR(nota.nota.emissao), vencimento: dataBR(p.vencimento), valor: r2(p.valor), nro_documento: documentoDe(nota, p), historico: hist,
        competencia: nota.nota.emissao.slice(5, 7) + '/' + nota.nota.emissao.slice(0, 4), ocorrencia: 'U',
        cliente: { nome: nota.emitente.nome.slice(0, 50), cpf_cnpj: nota.emitente.cnpj, tipo_pessoa: 'J', atualizar_cliente: 'N' } };
}
// contas que o Olist ja tem nesse vencimento
async function contasNoVencimento(venc) {
    const achadas = [];
    for (let pg = 1; pg <= 20; pg++) {
        const j = await olist('contas.pagar.pesquisa.php', { data_ini_vencimento: dataBR(venc), data_fim_vencimento: dataBR(venc), pagina: String(pg) });
        if (j.status !== 'OK') break;
        for (const x of j.contas || []) achadas.push(x.conta || x);
        if (pg >= Number(j.numero_paginas || 1)) break;
    }
    return achadas;
}
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// a parcela ja esta no Olist? mesma chave/NF no historico, ou mesmo valor + fornecedor parecido no mesmo vencimento
// duro: a chave da nota (+ a parcela) esta no historico de uma conta do Olist: e esta nota; NADA libera (vale mesmo em outro PC ou sem o registro local)
// forte: mesmo documento, valor e vencimento; parecida: mesmo valor e vencimento (outro fornecedor, ou nome diferente no Olist). So "forte" e "parecida" liberam com "enviar mesmo assim".
function jaExiste(lista, nota, p, conta) {
    let melhor = null;
    for (const c of lista) {
        const mesmoValor = Math.abs(Number(c.valor) - p.valor) < 0.005;
        const hist = String(c.historico || ''), doc = String(c.numero_doc || c.nro_documento || '');
        // a chave sozinha nao basta (as parcelas da mesma nota tem a mesma chave): precisa ser a mesma parcela
        if (nota.nota.chave && hist.includes(nota.nota.chave) && (hist.includes(`parcela ${p.n}/${p.total}`) || mesmoValor)) return { nivel: 'duro', id: c.id, motivo: 'esta nota (a chave de acesso) já está lançada no Olist', conta: c };
        if (!mesmoValor) continue;
        if (doc && doc === conta.nro_documento) { melhor = melhor && melhor.nivel === 'forte' ? melhor : { nivel: 'forte', id: c.id, motivo: 'já existe uma conta com o mesmo documento, valor e vencimento', conta: c }; continue; }
        const nomeC = norm(c.nome_cliente || c.cliente), nomeN = norm(nota.emitente.nome);
        const parecido = nomeC && nomeN && (nomeC.includes(nomeN.slice(0, 12)) || nomeN.includes(nomeC.slice(0, 12)));
        if (!melhor) melhor = parecido ? { nivel: 'forte', id: c.id, motivo: 'já existe uma conta do mesmo fornecedor, com o mesmo valor e vencimento (talvez lançada antes, pelo Bling)', conta: c }
            : { nivel: 'parecida', id: c.id, motivo: `já existe uma conta de ${c.nome_cliente || 'outro fornecedor'} com o mesmo valor e vencimento: confirme se não é a mesma`, conta: c };
        else if (melhor.nivel === 'parecida' && parecido) melhor = { nivel: 'forte', id: c.id, motivo: 'já existe uma conta do mesmo fornecedor, com o mesmo valor e vencimento (talvez lançada antes, pelo Bling)', conta: c };
    }
    return melhor;
}

// Envia as parcelas das notas ao Olist.  opc: { ids, teste (so a 1a nota), simular (nao envia: mostra o que enviaria), lote }
async function enviarNotas(opc = {}) {
    try { await empresaDoOlist(); } catch (e) { if (!empresa().cnpj) throw new Error('Não consegui confirmar qual empresa é este Olist: ' + e.message); }
    reconferirTodas();   // com o CNPJ do Olist conectado: nota de outra empresa nao passa
    const D = lerDados(), emp = empresa();
    let notas = (opc.ids && opc.ids.length ? opc.ids.map(i => D.notas[i]).filter(Boolean) : Object.values(D.notas)).filter(n => n.parcelas.some(p => ['pendente', 'erro', 'duplicada'].includes(p.status)));
    const pulados = [];
    notas = notas.filter(n => { const r = podeEnviar(n); if (!r.ok) pulados.push({ id: n.id, nota: n.nota.numero, fornecedor: n.emitente.nome, motivo: r.motivo }); return r.ok; });
    // teste: a nota mais simples (so as prontas, menos parcelas, menor valor): se algo der errado, o estrago e pequeno
    if (opc.teste) notas = [...notas].sort((x, y) => (x.situacao === 'ok' ? 0 : 1) - (y.situacao === 'ok' ? 0 : 1) || x.parcelas.length - y.parcelas.length || x.nota.valor_total - y.nota.valor_total).slice(0, 1);
    if (!opc.simular && !opc.teste && notas.length > 1 && !D.teste_confirmado_em && !opc.pular_teste) throw new Error('Envie primeiro UMA nota de teste e confira no Olist: o lote só abre depois que o teste for confirmado.');
    const resultados = [], total = notas.reduce((s, n) => s + n.parcelas.filter(p => ['pendente', 'erro', 'duplicada'].includes(p.status)).length, 0);
    Object.assign(est, { enviando: true, etapa: opc.simular ? 'Conferindo o que seria enviado…' : 'Enviando ao Olist…', feito: 0, total, erro: null, resultados, pulados });
    try {
        for (const n of notas) {
            let todasOk = true;
            for (const p of n.parcelas.filter(x => ['pendente', 'erro', 'duplicada'].includes(x.status))) {
                const r = { id: n.id, nota: n.nota.numero, fornecedor: n.emitente.nome, parcela: `${p.n}/${p.total}`, vencimento: p.vencimento, valor: p.valor };
                try {
                    const conta = montarConta(n, p); r.conta = conta;
                    est.etapa = `${opc.simular ? 'Conferindo' : 'Enviando'} NF ${n.nota.numero} · parcela ${p.n}/${p.total}…`;
                    // 5. ja existe no Olist?
                    const achada = jaExiste(await contasNoVencimento(p.vencimento), n, p, conta), dup = achada && (achada.nivel === 'duro' || !n.forcar) ? achada : null;
                    if (dup) { r.status = 'duplicada'; r.motivo = `Não enviada: ${dup.motivo} (conta #${dup.id}, R$ ${brFmt(dup.conta.valor)}, ${dup.conta.nome_cliente || dup.conta.cliente || ''}).`; if (!opc.simular) { p.status = 'duplicada'; p.olist_id = String(dup.id); p.erro = r.motivo; } todasOk = false; }
                    else if (opc.simular) { r.status = 'simulada'; }
                    else {
                        let j = await olist('conta.pagar.incluir.php', { conta: JSON.stringify({ conta }) }), id = j.status === 'OK' ? idDoRetorno(j) : null;
                        // o Olist recusa o mesmo numero de documento duas vezes: a duplicidade real ja foi descartada acima, entao reenvia sem o numero e deixa o documento no historico
                        if (!id && /já cadastrado/i.test(erroDo(j))) { const c2 = { ...conta }; delete c2.nro_documento; c2.historico = ('Doc. ' + conta.nro_documento + ' · ' + conta.historico).slice(0, 300); j = await olist('conta.pagar.incluir.php', { conta: JSON.stringify({ conta: c2 }) }); id = j.status === 'OK' ? idDoRetorno(j) : null; }
                        if (!id) throw new Error('O Olist recusou: ' + erroDo(j));
                        p.status = 'enviada'; p.olist_id = String(id); p.enviado_em = new Date().toISOString(); p.erro = null; r.status = 'enviada'; r.olist_id = String(id);
                        registrar({ evento: 'enviada', id: n.id, nota: n.nota.numero, parcela: `${p.n}/${p.total}`, valor: p.valor, vencimento: p.vencimento, olist_id: String(id) });
                        // 7. le o Olist de volta e confirma
                        let volta = (await contasNoVencimento(p.vencimento)).find(c => String(c.id) === String(id));
                        if (!volta) { await dormir(3000); volta = (await contasNoVencimento(p.vencimento)).find(c => String(c.id) === String(id)); }   // o Olist pode demorar a indexar a conta nova
                        if (volta && Math.abs(Number(volta.valor) - p.valor) < 0.005) { p.status = 'confirmada'; p.confirmada_em = new Date().toISOString(); r.status = 'confirmada'; registrar({ evento: 'confirmada', id: n.id, olist_id: String(id) }); }
                        else { r.status = 'enviada_sem_confirmacao'; r.motivo = 'Enviada, mas não consegui conferir no Olist: abra o Contas a pagar do Olist e confira esta conta.'; todasOk = false; registrar({ evento: 'sem_confirmacao', id: n.id, olist_id: String(id) }); }
                    }
                } catch (e) { r.status = 'erro'; r.motivo = e.message; todasOk = false; if (!opc.simular) { p.status = 'erro'; p.erro = e.message; } registrar({ evento: 'erro_envio', id: n.id, parcela: `${p.n}/${p.total}`, erro: e.message }); }
                resultados.push(r); est.feito++;
                if (!opc.simular) gravar(ARQ(), D);
            }
            if (!opc.simular && opc.teste && todasOk && n.parcelas.every(p => p.status === 'confirmada')) { D.teste_confirmado_em = new Date().toISOString(); gravar(ARQ(), D); }
        }
    } finally { Object.assign(est, { enviando: false, etapa: '', em: new Date().toISOString() }); }
    return { ok: true, resultados, pulados };
}
function enviar(opc) {
    if (est.rodando || est.enviando) return { ok: false, erro: 'Já está trabalhando. Espere terminar.' };
    if (!tokenOlist()) return { ok: false, erro: `Token do Olist da ${empresa().nome} não cadastrado.` };
    if (!opc.simular && !opc.teste && !lerDados().teste_confirmado_em && !opc.pular_teste) return { ok: false, erro: 'Envie primeiro UMA nota de teste e confira no Olist: o lote só abre depois que o teste for confirmado.' };
    est.resultados = []; est.pulados = []; est.erro = null; est.enviando = true;
    enviarNotas(opc).then(r => { est.resultados = r.resultados; est.pulados = r.pulados; }).catch(e => { est.erro = e.message; est.enviando = false; });
    return { ok: true };
}

// ---------------------------------------------------------------- uso pela tela
function listar() {
    { const D0 = lerDados(); if (Object.values(D0.notas).some(n => (n.graves || []).some(g => /^Nota de outra empresa/.test(g)))) reconferirTodas(); }   // notas lidas antes desta mudanca
    if (tokenOlist() && !lerJson(ARQ_EMP(), null)) empresaDoOlist().catch(() => {});
    const D = lerDados(), emp = empresa();
    const notas = Object.values(D.notas).sort((a, b) => String(b.lido_em).localeCompare(String(a.lido_em))).map(n => ({ ...n, pode_enviar: podeEnviar(n) }));
    const pend = notas.filter(n => n.parcelas.some(p => ['pendente', 'erro'].includes(p.status)));
    return { empresa: emp, olist_token: !!tokenOlist(), teste_confirmado_em: D.teste_confirmado_em || null, estado: { ...est }, notas,
        resumo: { notas: notas.length, ok: pend.filter(n => n.situacao === 'ok').length, conferir: pend.filter(n => n.situacao === 'conferir').length, bloqueadas: pend.filter(n => n.situacao === 'bloqueada').length,
            enviadas: notas.filter(n => n.parcelas.every(p => ['enviada', 'confirmada', 'duplicada'].includes(p.status)) && n.parcelas.some(p => ['enviada', 'confirmada'].includes(p.status))).length,
            parcelas_a_enviar: pend.reduce((s, n) => s + (n.pode_enviar.ok ? n.parcelas.filter(p => ['pendente', 'erro'].includes(p.status)).length : 0), 0),
            valor_a_enviar: r2(pend.reduce((s, n) => s + (n.pode_enviar.ok ? n.parcelas.filter(p => ['pendente', 'erro'].includes(p.status)).reduce((t, p) => t + p.valor, 0) : 0), 0)) } };
}

const caminhoPdf = (id) => { if (!/^[0-9a-z]{6,44}$/.test(String(id))) return null; const p = path.join(PASTA_PDF(), id + '.pdf'); return fs.existsSync(p) ? p : null; };

module.exports = { empresaDoOlist, caminhoPdf, ler, atualizar, remover, enviar, listar, conferir, lerComIA, lerTexto, chaveDoTexto, verificarNoTexto, montarConta, documentoDe, cnpjValido, chaveValida, numero, data, empresa, definirCnpj, podeEnviar, estado: () => ({ ...est }), lerDados };
