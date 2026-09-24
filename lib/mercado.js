// "O mercado também parou, ou só a gente?" — contexto de mercado para um produto
// parado, vindo do Nubimetrics.
//
// O Nubimetrics não deixa consultar um anúncio nosso pelo MLB: o detalhe exige
// hashes de um grupo de concorrência montado lá dentro. O que dá para fazer com
// qualquer produto é buscar o MERCADO pelo título (meli_publication_explorer) e
// comparar: se o mercado do mesmo item vende bem e nós não, o problema é nosso
// (preço, foto, posição); se ninguém vende, é demanda.
//
// Cada consulta custa 1 chamada da cota, então ela só acontece quando o usuário
// abre a gaveta daquele produto — e fica 24 h em cache (lib/nubimetrics.js).
const nubi = require('./nubimetrics');

// O título do anúncio é comprido demais para busca ("Tapete Bandeja Song Pro
// 3.0mm 2025 2026 2027 Premium"). Aqui sobra o miolo: marca/modelo/tipo.
const RUIDO = new Set(['de', 'da', 'do', 'para', 'p', 'com', 'sem', 'e', 'a', 'o', 'em', 'à', 'á',
    'premium', 'original', 'novo', 'nova', 'kit', 'jogo', 'par', 'un', 'unidade', 'pç', 'pçs',
    'promoção', 'frete', 'grátis', 'envio', 'top', 'linha', 'qualidade']);

function palavrasChave(titulo, maximo = 5) {
    const bruto = String(titulo || '').toLowerCase()
        .replace(/[^\wÀ-ÿ\s.]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        // fora anos (2015, 2026), medidas (3.0mm) e palavras de enfeite
        .filter(p => !/^\d{2,4}$/.test(p) && !/^\d+[.,]?\d*(mm|cm|m|kg|g|pç|pcs)$/.test(p))
        .filter(p => p.length > 1 && !RUIDO.has(p));
    return bruto.slice(0, maximo).join(' ');
}

const num = (v) => (typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^\d.,-]/g, '').replace(',', '.')) || 0);

/**
 * Resumo de mercado do produto. Nunca lança: devolve { erro } ou { bloqueado }.
 * `nosso` (preço e vendas 30 d nossos) entra só para o comparativo.
 */
async function doProduto({ titulo, preco, vendas30 = 0 }) {
    const busca = palavrasChave(titulo);
    if (!busca) return { erro: 'Não consegui extrair palavras-chave do título.' };

    const r = await nubi.comCache(`busca_${busca}`, 'meli_publication_explorer',
        { title: busca, page_size: 20, search_by_alias: true });
    if (!r.ok) return { busca, ...r };

    const lista = (r.dados && (r.dados.publications || r.dados.results || r.dados.data || r.dados.items)) || [];
    if (!Array.isArray(lista) || !lista.length) {
        return { busca, vazio: true, doCache: r.doCache, idade_min: r.idade_min, aviso: r.aviso };
    }

    const itens = lista.map(p => ({
        titulo: p.title || p.name || '',
        vendedor: p.seller_alias || p.seller_nickname || '',
        preco: num(p.price),
        vendas: num(p.units),
        faturamento: num(p.gmv),
        full: p.shipping_method === 'full' || p.is_full === true,
        catalogo: !!p.catalog_listing,
    })).filter(x => x.preco > 0);

    const comVenda = itens.filter(i => i.vendas > 0);
    const precos = itens.map(i => i.preco).sort((a, b) => a - b);
    const mediana = precos.length ? precos[Math.floor(precos.length / 2)] : null;
    const totalVendas = itens.reduce((s, i) => s + i.vendas, 0);
    const maisBaratos = preco ? itens.filter(i => i.preco < preco).length : null;

    // O veredito é o ponto da tela: dizer se o problema é nosso ou do mercado.
    let veredito, cor;
    if (!comVenda.length) { veredito = 'O mercado também está parado neste item — é demanda, não o anúncio.'; cor = 'neutro'; }
    else if (vendas30 > 0) { veredito = 'O mercado vende e nós também, em ritmo menor.'; cor = 'neutro'; }
    else if (preco && mediana && preco > mediana * 1.15) { veredito = `O mercado vende ${totalVendas} un e nós zero — e nosso preço está ${Math.round((preco / mediana - 1) * 100)}% acima da mediana.`; cor = 'ruim'; }
    else { veredito = `O mercado vende ${totalVendas} un e nós zero, com preço alinhado — olhar foto, título e posição.`; cor = 'ruim'; }

    return {
        busca,
        doCache: !!r.doCache, vencido: !!r.vencido, idade_min: r.idade_min || 0, aviso: r.aviso,
        anuncios: itens.length,
        vendendo: comVenda.length,
        vendas_mercado: totalVendas,
        preco_min: precos[0] ?? null,
        preco_mediana: mediana,
        preco_max: precos[precos.length - 1] ?? null,
        nosso_preco: preco ?? null,
        mais_baratos_que_nos: maisBaratos,
        no_full: itens.filter(i => i.full).length,
        veredito, cor,
        // os que mais vendem: é com eles que vale comparar anúncio a anúncio
        lideres: [...itens].sort((a, b) => b.vendas - a.vendas).slice(0, 5),
    };
}

module.exports = { doProduto, palavrasChave };
