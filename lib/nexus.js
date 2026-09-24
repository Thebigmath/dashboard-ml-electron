// Nexus Engine: integração com Bling ERP no dashboard
//
// Motor inteligente que coleta dados do Bling sem excesso de informação.
// Similar ao Horizon: cache, log estruturado, parâmetros otimizados.
// Foco: o que importa para decisão, nada mais.
//
// Credenciais: carregadas de nexus-config.json (lado servidor seguro)
// Rate limiting: respeta API Bling (conforme parâmetros)
// Agregação: dados brutos → resumos decisivos

const fs = require('fs');
const path = require('path');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');

// ── operacoes do nexus ──────────────────────────────────────────────
// 4 operacoes principais: nsp01 a nsp04
// Cada uma puxar dados limpos sem excesso.

const OPERACOES = {
  nsp01: {
    nome: 'Puxar estoque',
    descricao: 'Estoque do produto por locação',
    fonte: 'bling',
    filtro: 'status=ativo&comEstoque=true',
    campos: ['sku', 'produto', 'estoque', 'locacao', 'ultimaAtualizacao'],
    agregacao: 'por_locacao',
    cacheTtl: 1800, // 30min
  },

  nsp02: {
    nome: 'Puxar categoria e descrição',
    descricao: 'Dados dos anúncios para o ML',
    fonte: 'bling',
    filtro: 'status=ativo&categoria!=vazia',
    campos: ['sku', 'produto', 'categoria', 'descricao', 'preco', 'estoque'],
    agregacao: 'nenhuma',
    cacheTtl: 3600, // 1h
  },

  nsp03: {
    nome: 'Subir anúncios',
    descricao: 'Sincronizar anúncios com ML (categoria, descrição, título)',
    fonte: 'bling-para-ml',
    filtro: 'status=pronto&categoria!=vazia',
    campos: ['sku', 'titulo_gerado', 'categoria', 'descricao', 'preco'],
    agregacao: 'nenhuma',
    cacheTtl: 300, // 5min — pode mudar rápido
  },

  nsp04: {
    nome: 'Sincronização automatizada',
    descricao: 'Bot que sincroniza estoque continuamente',
    fonte: 'bling-estoque-bot',
    filtro: 'status=ativo&sincronizar=true',
    campos: ['sku', 'produto', 'estoque_bling', 'estoque_ml', 'divergencia'],
    agregacao: 'por_divergencia',
    cacheTtl: 900, // 15min — bot rodando
  },
};

function lerJson(arquivo, padrao) {
    try { return JSON.parse(fs.readFileSync(path.join(STORAGE, arquivo), 'utf8')); } catch { return padrao; }
}

function salvarJson(arquivo, dados) {
    try { fs.writeFileSync(path.join(STORAGE, arquivo), JSON.stringify(dados, null, 2), 'utf8'); } catch (e) { console.error('Erro ao salvar', arquivo, e); }
}

function coletadoEm() {
    return new Date().toISOString();
}

// ── Cache com validade ──────────────────────────────────────────────
// Não remede o que acabou de ser medido. Economiza quota Bling.

function lerCache(chave) {
    const cache = lerJson('nexus-cache.json', {});
    const item = cache[chave];
    if (!item) return null;
    if (Date.now() > item.expira) { delete cache[chave]; salvarJson('nexus-cache.json', cache); return null; }
    return item.dados;
}

function salvarCache(chave, dados, ttlSeg) {
    const cache = lerJson('nexus-cache.json', {});
    cache[chave] = { dados, expira: Date.now() + ttlSeg * 1000 };
    salvarJson('nexus-cache.json', cache);
}

// ── Agregação: dados brutos → resumos ───────────────────────────────
// "Agregação" = contar, somar, agrupar. Não é complexidade; é clareza.

function agregaProdutos(brutos, tipo) {
    if (tipo === 'por_categoria') {
        const acc = {};
        for (const p of brutos) {
            const cat = p.categoria || 'sem-categoria';
            acc[cat] = (acc[cat] || 0) + (p.estoque || 0);
        }
        return acc;
    }
    return brutos;
}

function agregaPedidos(brutos, tipo) {
    if (tipo === 'por_dia_status') {
        const acc = {};
        for (const pd of brutos) {
            const dia = pd.dataEmissao?.slice(0, 10) || 'sem-data';
            const status = pd.status || 'desconhecido';
            const chave = `${dia}/${status}`;
            acc[chave] = (acc[chave] || 0) + 1;
        }
        return acc;
    }
    return brutos;
}

function agregaEstoque(brutos, tipo) {
    if (tipo === 'por_locacao') {
        const acc = {};
        for (const e of brutos) {
            const loc = e.locacao || 'galpão-principal';
            if (!acc[loc]) acc[loc] = { qtd: 0, valor: 0 };
            acc[loc].qtd += e.quantidade || 0;
            acc[loc].valor += (e.quantidade || 0) * (e.preco || 0);
        }
        return acc;
    }
    return brutos;
}

// ── Credenciais do Bling ────────────────────────────────────────────
// Carregadas de arquivo seguro no servidor; nunca expõe ao cliente.

function carregarCredencialsBling() {
    const configPath = path.join(process.env.HOME || process.env.USERPROFILE, 'Documents', 'MCP_Nubimetrics', '.claude', 'bling_api.json');
    try {
        const conteudo = fs.readFileSync(configPath, 'utf8');
        // Parseia formato: "cliente ID: xxx" com quebra de linha
        const linhas = conteudo.split('\n');
        const credenciais = {};
        for (const linha of linhas) {
            if (linha.includes('cliente ID:')) credenciais.clienteId = linha.split(':')[1].trim();
            if (linha.includes('cliente secret:')) credenciais.clienteSecret = linha.split(':')[1].trim();
        }
        return credenciais.clienteId && credenciais.clienteSecret ? credenciais : null;
    } catch (e) {
        console.error('[Nexus] Credenciais Bling não encontradas:', e.message);
        return null;
    }
}

const BLING_CREDS = carregarCredencialsBling();

// ── Busca na API do Bling ───────────────────────────────────────────
// Cache first, depois API. Rate limiting automático via TTL.

async function buscarDoBling(operacao) {
    if (!BLING_CREDS) {
        console.error('[Nexus] Credenciais do Bling não configuradas');
        return null;
    }

    const op = OPERACOES[operacao];
    if (!op) return null;

    console.log(`[Nexus] ${op.nome}: ${op.filtro}`);

    try {
        // Aqui seria a chamada real à API do Bling
        // Exemplo: GET /api/v3/produtos?filtro=...&campos=...
        // Por enquanto retorna estrutura vazia que será agregada
        const resposta = {
            operacao,
            timestamp: coletadoEm(),
            quantidade: 0,
            dados: []
        };
        return resposta;
    } catch (e) {
        console.error(`[Nexus] Erro ao buscar ${operacao}:`, e.message);
        return null;
    }
}

// ── Motor principal: busca + cache + agregação ──────────────────────

async function buscar(operacao) {
    const op = OPERACOES[operacao];
    if (!op) return null;

    // Tenta cache primeiro
    const chave = `nexus-${operacao}`;
    const emCache = lerCache(chave);
    if (emCache) {
        console.log(`[Nexus] ${operacao} retornado do cache`);
        return { origem: 'cache', ...emCache };
    }

    // Se não, busca da API
    const brutos = await buscarDoBling(operacao);
    if (!brutos) return null;

    // Agregação conforme estratégia
    let agregado = brutos.dados;
    if (op.agregacao === 'por_locacao') {
        agregado = agregaEstoque(brutos.dados, 'por_locacao');
    } else if (op.agregacao === 'por_divergencia') {
        // Bot de sincronização
        agregado = brutos.dados.filter(d => d.divergencia > 0);
    } else if (op.agregacao === 'nenhuma') {
        // Vem já agregado da API
        agregado = brutos.dados;
    }

    const resultado = {
        coletadoEm: brutos.timestamp,
        operacao,
        quantidade: agregado.length || Object.keys(agregado).length,
        dados: agregado
    };

    salvarCache(chave, resultado, op.cacheTtl);
    console.log(`[Nexus] ${operacao} salvo em cache (TTL ${op.cacheTtl}s)`);

    return { origem: 'bling-api', ...resultado };
}

// ── Assinatura: chave que muda quando houver dado novo ──────────────
// Pxing a cada 30s: "muda algo?" → só recarrega se sim.

function assinatura() {
    const cache = lerJson('nexus-cache.json', {});
    const chaves = Object.keys(cache).sort();
    return JSON.stringify({ chaves, agora: Date.now() });
}

// ── Exporta ──────────────────────────────────────────────────────────

module.exports = {
    PARAMETROS,
    buscar,
    assinatura,
    lerCache,
    salvarCache,
};
