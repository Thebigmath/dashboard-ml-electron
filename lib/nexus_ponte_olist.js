// Nexus - ponte Bling -> Olist: converte a ficha do Bling (API v3) no layout do produto.incluir.php do Olist (API v2).
//   So MONTA e PLANEJA. Nao envia nada ao Olist (o envio real roda por outro processo; aqui nao existe incluir).
//   Regras (decididas com o usuario):
//   - medidas do Bling vem em dimensoes.unidadeMedida 0=m, 1=cm, 2=mm; o Olist quer cm
//   - descricao = descricaoCurta + descricaoComplementar; imagens do Bling viram anexos
//   - formato 'E' (kit) => classe K com kit[{ item: { id_produto, quantidade } }]; o resto => classe S
//   - variacoes do Bling (formato 'V') entram no Olist como produtos SIMPLES separados por SKU (opcao A)
//   - SKU com mais de 30 caracteres nao cabe no Olist: fica de fora
//   - na fila, simples (e filhos de variacao) vem antes dos kits, porque o kit precisa dos componentes ja no Olist
const LIMITE_SKU = 30;
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const cm = (v, u) => { v = Number(v) || 0; return u === 0 ? v * 100 : u === 2 ? v / 10 : v; };
const norm = (s) => String(s || '').trim().toLowerCase();

// d = ficha do Bling; idOlist(codigo) devolve o id do produto no Olist (para os componentes do kit);
// fichas = { idBling: ficha } para achar o SKU de cada componente
function montar(d, { idOlist, fichas = {}, classe } = {}) {
    const codigo = String(d.codigo || '').trim();
    if (!codigo) throw new Error(`produto ${d.id} sem SKU`);
    if (codigo.length > LIMITE_SKU) throw new Error(`SKU ${codigo} tem mais de ${LIMITE_SKU} caracteres (limite do Olist)`);
    const dim = d.dimensoes || {}, u = dim.unidadeMedida, tr = d.tributacao || {};
    const desc = [d.descricaoCurta, d.descricaoComplementar].filter(x => String(x || '').trim()).join('<br /><br />');
    const imgs = [...(d.midia?.imagens?.internas || []), ...(d.midia?.imagens?.externas || [])].map(i => i.link).filter(Boolean);
    const p = {
        sequencia: 1, nome: String(d.nome).slice(0, 120), codigo, unidade: String(d.unidade || 'UN').slice(0, 3) || 'UN',
        preco: r2(d.preco), preco_custo: r2(d.fornecedor?.precoCusto) || undefined,
        ncm: tr.ncm || undefined, cest: tr.cest || undefined, origem: String(tr.origem ?? 0),
        gtin: d.gtin || undefined, gtin_embalagem: d.gtinEmbalagem || undefined, marca: d.marca || undefined,
        situacao: d.situacao === 'I' ? 'I' : 'A', tipo: 'P', classe_produto: classe || (d.formato === 'E' ? 'K' : 'S'),
        peso_liquido: Number(d.pesoLiquido) || undefined, peso_bruto: Number(d.pesoBruto) || undefined,
        tipo_embalagem: (dim.altura || dim.largura || dim.profundidade) ? 2 : undefined,
        altura_embalagem: cm(dim.altura, u) || undefined, largura_embalagem: cm(dim.largura, u) || undefined, comprimento_embalagem: cm(dim.profundidade, u) || undefined,
        descricao_complementar: desc || undefined, obs: d.observacoes || undefined,
        anexos: imgs.length ? imgs.map(anexo => ({ anexo })) : undefined,
    };
    if (p.classe_produto === 'K') {
        if (typeof idOlist !== 'function') throw new Error('kit precisa de idOlist(codigo) para achar os componentes no Olist');
        p.kit = (d.estrutura?.componentes || []).map(k => {
            const f = fichas[k.produto?.id]; const id = f && idOlist(String(f.codigo || '').trim());
            if (!id) throw new Error(`componente ${f ? f.codigo : k.produto?.id} ainda não está no Olist`);
            return { item: { id_produto: Number(id), quantidade: k.quantidade } };
        });
    }
    for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];
    return p;
}

// Monta a fila de transferencia SEM ENVIAR.
//   candidatos .. produtos do Bling que faltam no Olist (ex.: cruzamento.faltando; basta ter .id)
//   fichas ...... { idBling: ficha completa } (GET /produtos/{id}); e completado com o que obterFicha trouxer
//   noOlist ..... SKUs que ja existem no Olist (array ou Set)
//   obterFicha .. opcional, async (id) => ficha (ex.: nexus_bling.obterProduto) para filhos de variacao sem ficha
// Devolve { fila: [{ tipo: 'S'|'VS'|'K', id, codigo, pai?, bloqueado? }], pulados, semFicha, resumo }
async function planejar({ candidatos = [], fichas = {}, noOlist = [], obterFicha } = {}) {
    const jaTem = new Set([...noOlist].map(norm));
    const simples = [], filhos = [], kits = [], pulados = [], semFicha = [];
    const ficha = async (id) => {
        if (fichas[id]) return fichas[id];
        if (!obterFicha) return null;
        const f = await obterFicha(id); if (f) fichas[id] = f; return f;
    };
    for (const x of candidatos) {
        const d = await ficha(x.id);
        if (!d) { semFicha.push(x.id); continue; }
        if (d.formato === 'V') {
            for (const v of d.variacoes || []) {
                if (jaTem.has(norm(v.codigo))) continue;
                const f = await ficha(v.id);
                if (!f) { semFicha.push(v.id); continue; }
                filhos.push({ pai: d.codigo, d: f });
            }
        } else if (d.formato === 'E') kits.push(d); else simples.push(d);
    }
    // tira duplicados (filho que tambem veio como simples) e o que ja esta no Olist
    const vistos = new Set(jaTem), fila = [];
    const ordem = [...simples.map(d => ['S', d]), ...filhos.map(f => ['VS', f.d, f.pai]), ...kits.map(d => ['K', d])];
    for (const [tipo, d, pai] of ordem) {
        const c = norm(d.codigo);
        if (!c) { pulados.push({ id: d.id, codigo: d.codigo, motivo: 'sem SKU', nome: d.nome }); continue; }
        if (vistos.has(c)) continue; vistos.add(c);
        if (String(d.codigo).trim().length > LIMITE_SKU) { pulados.push({ id: d.id, codigo: d.codigo, motivo: `SKU com mais de ${LIMITE_SKU} caracteres (limite do Olist)`, nome: d.nome }); continue; }
        fila.push({ tipo, id: d.id, codigo: String(d.codigo).trim(), ...(pai ? { pai } : {}) });
    }
    // kit: cada componente precisa ja existir no Olist ou entrar antes na fila
    const vaiEntrar = new Set(fila.filter(f => f.tipo !== 'K').map(f => norm(f.codigo)));
    for (const f of fila.filter(f => f.tipo === 'K')) {
        const falta = (fichas[f.id].estrutura?.componentes || []).map(k => ({ id: k.produto?.id, c: fichas[k.produto?.id] }))
            .filter(({ c }) => !c || !(jaTem.has(norm(c.codigo)) || vaiEntrar.has(norm(c.codigo))));
        if (falta.length) f.bloqueado = falta.map(({ id, c }) => c ? c.codigo : '?' + id).join(', ');
    }
    const resumo = fila.reduce((m, f) => (m[f.tipo] = (m[f.tipo] || 0) + 1, m), { total: fila.length });
    resumo.kits_bloqueados = fila.filter(f => f.bloqueado).length;
    resumo.pulados = pulados.length;
    resumo.sem_ficha = semFicha.length;
    return { fila, pulados, semFicha, resumo };
}

module.exports = { montar, planejar, LIMITE_SKU };
