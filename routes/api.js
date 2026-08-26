const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const multer = require('multer');
const TokenManager = require('../lib/tokenManager');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const upload = multer({ dest: path.join(STORAGE, 'uploads/') });

function auth(req, res, next) { next(); }

function lerJson(file, def = {}) {
    const p = path.join(STORAGE, file);
    if (!fs.existsSync(p)) return def;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; }
}

function salvarJson(file, data) {
    fs.writeFileSync(path.join(STORAGE, file), JSON.stringify(data, null, 2), 'utf8');
}

// ── Dados do dashboard ──────────────────────────────────────────────────────
router.get('/dados', auth, (req, res) => {
    const reposicao = lerJson('reposicao.json', []);
    const transitoRaw = lerJson('transito_local.json', {});
    const transito = {};
    for (const [k, v] of Object.entries(transitoRaw)) {
        transito[k.toLowerCase()] = typeof v === 'object' ? (v.quantidade ?? 0) : (Number(v) || 0);
    }
    const ultima    = fs.existsSync(path.join(STORAGE, 'ultima_atualizacao.txt'))
        ? fs.readFileSync(path.join(STORAGE, 'ultima_atualizacao.txt'), 'utf8') : null;

    // Soma dos envios Full ativos que ainda não foram totalmente recebidos.
    // Mesma regra do motor: quando o envio traz o "Código ML" (inventory_id), só ele
    // conta — é único por produto. Sem código, cai no seller_sku, que não distingue
    // produtos que o compartilham.
    // Três mapas, porque o produto pode ou não ter o Código ML gravado ainda:
    //   porInv      — envios novos, que trazem o código (único por produto)
    //   skuLegado   — envios antigos, só com SKU, + o transito_local.json
    //   skuTotal    — todos, usado quando o produto ainda não tem inventory_id na base
    // Sem o skuTotal, um envio novo sumia da tela até o motor rodar e gravar o código.
    const transitoPorInv = {};
    const skuLegado = { ...transito };
    const skuTotal  = { ...transito };
    const envios = lerJson('envios_full.json', []);
    for (const e of envios) {
        if (e.inativo) continue;
        if ((e.recebido || 0) >= (e.unidades || 0) && (e.unidades || 0) > 0) continue;
        const temCodigos = e.codigos && Object.keys(e.codigos).length > 0;
        if (temCodigos) {
            for (const [cod, qty] of Object.entries(e.codigos)) {
                const k = String(cod).toUpperCase();
                transitoPorInv[k] = (transitoPorInv[k] || 0) + qty;
            }
        }
        for (const [sku, qty] of Object.entries(e.skus || {})) {
            const k = sku.toLowerCase();
            skuTotal[k] = (skuTotal[k] || 0) + qty;
            if (!temCodigos) skuLegado[k] = (skuLegado[k] || 0) + qty;
        }
    }
    Object.assign(transito, skuTotal);   // mapa por SKU exposto continua sendo o total

    // Trânsito resolvido POR PRODUTO, com a mesma conta do motor. A tela não conseguia
    // refazer isso: o rótulo que ela exibe ("010tb-polo") não é a chave do mapa por SKU
    // ("010tb"), então todo produto que divide SKU aparecia com trânsito 0.
    // O desconto da transferência entra aqui, uma vez só, por produto — antes ele era
    // aplicado sobre o mapa por SKU, onde produtos distintos se atrapalhavam.
    const transitoPorChave = {};
    for (const p of reposicao) {
        const chave = p.chave || p.sku;
        const base  = String(chave).split('~')[0].toLowerCase();
        const bruto = p.inventory_id
            ? (transitoPorInv[String(p.inventory_id).toUpperCase()] || 0) + (skuLegado[base] || 0)
            : (skuTotal[base] || 0);
        transitoPorChave[chave] = Math.max(0, bruto - (p.transferenciaMl || 0));
    }

    // Mapa por SKU mantido para compatibilidade (/api/transito e telas antigas); o
    // desconto da transferência é aplicado aqui do mesmo jeito que era antes.
    const transferenciaPorSku = {};
    for (const p of reposicao) {
        if (!p.transferenciaMl) continue;
        const k = (p.sku || '').toLowerCase();
        transferenciaPorSku[k] = Math.max(transferenciaPorSku[k] || 0, p.transferenciaMl);
    }
    for (const k of Object.keys(transito)) {
        if (transferenciaPorSku[k]) transito[k] = Math.max(0, transito[k] - transferenciaPorSku[k]);
    }

    res.json({ produtos: reposicao, transito, transito_por_chave: transitoPorChave, ultima_atualizacao: ultima });
});

// ── Motor de reposição ──────────────────────────────────────────────────────
router.post('/atualizar', auth, async (req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');

    const escrever = (msg) => res.write(msg + '\n');

    try {
        const { access_token, user_id } = await TokenManager.getToken();
        escrever(`User ID: ${user_id}`);

        const headers = { Authorization: `Bearer ${access_token}` };
        const LIMIT = 50;
        const config   = lerJson('config.json', {});
        const diasAlvo  = config.dias_alvo   || 35;
        const diasColeta = config.dias_coleta || 17;

        // 0. Auto-verificar envios Full já recebidos pelo ML
        const enviosList = lerJson('envios_full.json', []);
        let enviosAlterados = false;
        for (const envio of enviosList) {
            if (envio.inativo === true || envio.ativo === false) continue;
            if (!envio.numero) continue;
            if ((envio.recebido || 0) >= (envio.unidades || 0) && (envio.unidades || 0) > 0) continue;
            try {
                const { data: ship } = await axios.get(
                    `https://api.mercadolibre.com/shipments/${envio.numero}`,
                    { headers }
                );
                if (['delivered', 'closed'].includes(ship.status)) {
                    const qtd = ship.received_quantity ?? envio.unidades;
                    escrever(`[ENVIO] #${envio.numero} recebido pelo ML (status=${ship.status}, ${qtd} un) → fechado automaticamente`);
                    envio.recebido = qtd;
                    envio.status   = ship.status;
                    enviosAlterados = true;
                } else {
                    escrever(`[ENVIO] #${envio.numero} ainda em trânsito (status=${ship.status})`);
                }
            } catch (e) {
                escrever(`[ENVIO] #${envio.numero} não verificável via API (${(e.message || '').substring(0, 60)})`);
            }
        }
        if (enviosAlterados) salvarJson('envios_full.json', enviosList);

        // 1. Pedidos últimos 30 dias (excluindo apenas cancelados)
        const dataInicio = new Date(Date.now() - 30 * 86400000).toISOString();
        const dataFim    = new Date().toISOString();

        escrever('Carregando pedidos...');
        let pedidos = [], offset = 0, total = null;
        do {
            const { data } = await axios.get(`https://api.mercadolibre.com/orders/search`, {
                headers,
                params: {
                    seller: user_id,
                    'order.date_created.from': dataInicio,
                    'order.date_created.to':   dataFim,
                    limit: LIMIT,
                    offset
                }
            });
            if (total === null) total = data.paging?.total || 0;
            pedidos = pedidos.concat((data.results || []).filter(p => p.status !== 'cancelled'));
            offset += LIMIT;
        } while (offset < total);
        escrever(`Pedidos: ${pedidos.length}`);

        // 2. Vendas e faturamento por SKU / item_id / variação
        const vendasPorSku      = {};
        const faturamentoPorSku = {};
        const vendasPorItemId   = {};   // chave: itemid (lowercase) — para listagens com SKU duplicado entre produtos diferentes
        const faturPorItemId    = {};
        const vendasPorVariacao = {};   // chave: "itemid:variationId"
        const faturPorVariacao  = {};
        for (const pedido of pedidos) {
            for (const item of pedido.order_items || []) {
                const sku    = (item.item?.seller_sku || '').trim().toLowerCase();
                const itemId = (item.item?.id || '').toLowerCase();
                const varId  = item.item?.variation_id;
                const qty    = item.quantity || 0;
                const preco  = (item.unit_price || 0) * qty;

                if (sku) {
                    vendasPorSku[sku]      = (vendasPorSku[sku]      || 0) + qty;
                    faturamentoPorSku[sku] = (faturamentoPorSku[sku] || 0) + preco;
                } else if (itemId) {
                    vendasPorSku[itemId]      = (vendasPorSku[itemId]      || 0) + qty;
                    faturamentoPorSku[itemId] = (faturamentoPorSku[itemId] || 0) + preco;
                }
                // Sempre registrar por item_id (permite cruzar vendas quando SKU é compartilhado)
                if (itemId) {
                    vendasPorItemId[itemId] = (vendasPorItemId[itemId] || 0) + qty;
                    faturPorItemId[itemId]  = (faturPorItemId[itemId]  || 0) + preco;
                }
                // Registrar por variação quando disponível
                if (itemId && varId) {
                    const vk = itemId + ':' + varId;
                    vendasPorVariacao[vk] = (vendasPorVariacao[vk] || 0) + qty;
                    faturPorVariacao[vk]  = (faturPorVariacao[vk]  || 0) + preco;
                }
            }
        }

        // 3. Anúncios ativos
        escrever('Carregando anúncios...');
        let anunciosIds = [];
        for (const status of ['', 'closed']) {
            // search_type=scan pagina por cursor (scroll_id) em vez de offset. O offset é
            // rejeitado acima de 1000 ("Invalid limit and offset values", 400), o que
            // travaria o motor por completo assim que o catálogo passasse de ~1050
            // anúncios. O scan não tem esse teto.
            let scrollId = null;
            do {
                const params = { search_type: 'scan', limit: 100 };
                if (status)   params.status    = status;
                if (scrollId) params.scroll_id = scrollId;
                const { data } = await axios.get(`https://api.mercadolibre.com/users/${user_id}/items/search`, { headers, params });
                const res = data.results || [];
                if (!res.length) break;
                anunciosIds = anunciosIds.concat(res);
                scrollId = data.scroll_id;
            } while (scrollId);
        }
        anunciosIds = [...new Set(anunciosIds)];
        escrever(`Anúncios: ${anunciosIds.length}`);

        // 4. Detalhes em lote (paralelo)
        escrever('Buscando detalhes em paralelo...');
        const lotes = [];
        for (let i = 0; i < anunciosIds.length; i += 20) lotes.push(anunciosIds.slice(i, i + 20));

        const produtos = {};
        await Promise.all(lotes.map(async (lote) => {
            const { data } = await axios.get(`https://api.mercadolibre.com/items`, {
                headers,
                params: { ids: lote.join(','), include_attributes: 'all' }
            });
            for (const entry of data || []) {
                if (entry.body?.id) produtos[entry.body.id] = entry.body;
            }
        }));
        escrever(`Detalhes: ${Object.keys(produtos).length}`);

        // 4b. Estoque físico total no FULL via /inventories (inclui unidades em transferência,
        // que "available_quantity" do /items não conta — é a mesma base que o Magico usa)
        escrever('Buscando estoque físico FULL (inventories)...');
        const inventoryIdsSet = new Set();
        for (const p of Object.values(produtos)) {
            if (p.inventory_id) inventoryIdsSet.add(p.inventory_id);
            for (const v of p.variations || []) {
                if (v.inventory_id) inventoryIdsSet.add(v.inventory_id);
            }
        }
        const inventoryIds = [...inventoryIdsSet];
        const estoqueFullPorInventory = {};
        // Quanto do estoque acima é unidade que o ML já recebeu e está movendo entre
        // galpões. Guardado à parte porque o envio local que originou essas unidades
        // pode ainda constar como "em trânsito" em envios_full.json — sem descontar,
        // a mesma unidade entraria duas vezes na conta da reposição.
        const transferenciaPorInventory = {};
        await Promise.all(inventoryIds.map(async (invId) => {
            try {
                const { data } = await axios.get(`https://api.mercadolibre.com/inventories/${invId}/stock/fulfillment`, { headers });
                // Não usar "total": ele soma unidades perdidas ("lost"), em processamento
                // interno ("internalProcess") e em retirada, que não voltam a vender. Só o
                // que está em transferência entre galpões volta a ficar disponível.
                if (typeof data.available_quantity === 'number') {
                    const emTransferencia = (data.not_available_detail || [])
                        .filter(x => x.status === 'transfer')
                        .reduce((soma, x) => soma + (x.quantity || 0), 0);
                    estoqueFullPorInventory[invId] = data.available_quantity + emTransferencia;
                    transferenciaPorInventory[invId] = emTransferencia;
                }
            } catch { /* item sem estoque FULL detalhado, mantém fallback */ }
        }));
        escrever(`Estoque FULL obtido para ${Object.keys(estoqueFullPorInventory).length} de ${inventoryIds.length} inventories.`);

        // 5. Montar reposição
        function ePar(titulo, sku) {
            const t = (titulo || '').toLowerCase();
            const s = (sku   || '').toLowerCase();
            return s.includes('-par') || /\bpar\b/.test(t) || t.startsWith('par ');
        }

        // Retorna o primeiro atributo descritivo da variação (ex: "Direito", "Preto", "G")
        function labelVariacao(v) {
            for (const a of v.attributes || []) {
                if (a.id !== 'SELLER_SKU' && a.value_name) return a.value_name;
            }
            return '';
        }

        // Compara títulos pelos primeiros 40 chars normalizados
        function titulosSimilares(t1, t2) {
            const n = t => (t || '').toLowerCase().replace(/\s+/g, ' ').trim().substring(0, 40);
            return n(t1) === n(t2);
        }

        // Procura entrada existente em porSku com mesmo sku (principal ou alternativa ~) e título similar
        function encontrarEntradaSimilar(porSku, sku, titulo) {
            if (porSku[sku] && titulosSimilares(porSku[sku].titulo, titulo)) return sku;
            const prefixo = sku + '~';
            for (const key of Object.keys(porSku)) {
                if (key.startsWith(prefixo) && titulosSimilares(porSku[key].titulo, titulo)) return key;
            }
            return null;
        }

        const porSku = {};
        for (const itemId of anunciosIds) {
            const p = produtos[itemId];
            if (!p || p.error) continue;

            const status     = p.status || '';
            const tituloBase = p.title  || '';
            const variacoes  = p.variations || [];

            if (variacoes.length > 0) {
                // Caminho 2: listagem com variações → uma entrada por variação
                for (const v of variacoes) {
                    let vSku = '';
                    for (const a of v.attributes || []) {
                        if (a.id === 'SELLER_SKU') { vSku = (a.value_name || '').trim().toLowerCase(); break; }
                    }

                    const label  = labelVariacao(v);
                    const vTitulo = tituloBase + (label ? ' - ' + label : '');
                    // Se não tem SELLER_SKU na variação, usa "itemid:variationId" como chave
                    const vKey   = vSku || (itemId.toLowerCase() + ':' + v.id);
                    // Estoque físico FULL (inclui unidades em transferência); cai para available_quantity se não achar
                    const vEst   = (v.inventory_id && estoqueFullPorInventory[v.inventory_id] !== undefined)
                        ? estoqueFullPorInventory[v.inventory_id]
                        : (v.available_quantity || 0);
                    // parcela de vEst que o ML já contabiliza como transferência entre galpões
                    const vTransf = (v.inventory_id && transferenciaPorInventory[v.inventory_id]) || 0;
                    // variation_id só armazenado quando não tem sku próprio (para cruzar com vendasPorVariacao)
                    const vVarId = vSku ? undefined : v.id;
                    // Só é FULL quem tem inventory_id. Sem ele, "estoque" é a quantidade
                    // declarada no anúncio, que é outra coisa e não pode virar envio.
                    const vEFull = !!v.inventory_id;

                    if (!porSku[vKey]) {
                        porSku[vKey] = { item_id: itemId, variation_id: vVarId, inventory_id: v.inventory_id || null, sku: vKey, titulo: vTitulo, estoque: vEst, transferenciaMl: vTransf, status, eFull: vEFull };
                    } else {
                        const jaAtivo   = porSku[vKey].status === 'active';
                        const novoAtivo = status === 'active';
                        // Listagem FULL sempre ganha da não-FULL, mesmo pausada ou com menos
                        // estoque: é ela que define o que existe no galpão.
                        const substituir = (vEFull !== !!porSku[vKey].eFull)
                            ? vEFull
                            : ((!jaAtivo && novoAtivo) || (novoAtivo && vEst > porSku[vKey].estoque));
                        if (substituir) {
                            porSku[vKey] = { ...porSku[vKey], estoque: vEst, transferenciaMl: vTransf, item_id: itemId, inventory_id: v.inventory_id || null, status, eFull: vEFull };
                        }
                    }
                }
            } else {
                // Caminho 1: sem variações — lógica atual
                let sku = '';
                for (const attr of p.attributes || []) {
                    if (attr.id === 'SELLER_SKU') { sku = (attr.value_name || '').trim().toLowerCase(); break; }
                }
                if (!sku) sku = itemId.toLowerCase();

                // Estoque físico FULL (inclui unidades em transferência); cai para available_quantity se não achar
                const estoque = (p.inventory_id && estoqueFullPorInventory[p.inventory_id] !== undefined)
                    ? estoqueFullPorInventory[p.inventory_id]
                    : (p.available_quantity || 0);
                // parcela de "estoque" que o ML já contabiliza como transferência entre galpões
                const transferenciaMl = (p.inventory_id && transferenciaPorInventory[p.inventory_id]) || 0;
                // Só é FULL quem tem inventory_id. Sem ele, "estoque" é a quantidade
                // declarada no anúncio, que é outra coisa e não pode virar envio.
                const eFull = !!p.inventory_id;

                // inventory_id é o "Código ML" do galpão: único por produto, mesmo quando
                // vários produtos dividem o seller_sku. É por ele que o trânsito consegue
                // saber a qual produto pertence um envio.
                const invId = p.inventory_id || null;

                if (!porSku[sku]) {
                    porSku[sku] = { item_id: itemId, inventory_id: invId, sku, titulo: tituloBase, estoque, transferenciaMl, status, eFull };
                } else {
                    const novoEPar      = ePar(tituloBase, sku);
                    const existenteEPar = ePar(porSku[sku].titulo, porSku[sku].sku);

                    if (novoEPar !== existenteEPar) {
                        // Par colidindo com individual → separa
                        const skuPar = novoEPar ? sku + '#par' : porSku[sku].sku + '#par';
                        if (novoEPar) {
                            porSku[skuPar] = { item_id: itemId, inventory_id: invId, sku: skuPar, titulo: tituloBase, estoque, transferenciaMl, status, eFull };
                        } else {
                            porSku[skuPar] = { ...porSku[sku], sku: skuPar };
                            porSku[sku]    = { item_id: itemId, inventory_id: invId, sku, titulo: tituloBase, estoque, transferenciaMl, status, eFull };
                        }
                        escrever(`[AVISO] SKU "${sku}" colide entre PAR e INDIVIDUAL — separados automaticamente`);
                    } else {
                        const entradaExistente = encontrarEntradaSimilar(porSku, sku, tituloBase);
                        if (entradaExistente) {
                            // Mesmo produto, listagem duplicada → mescla e rastreia item_ids extras
                            const e = porSku[entradaExistente];
                            if (!e._itemIds) e._itemIds = [e.item_id.toLowerCase()];
                            e._itemIds.push(itemId.toLowerCase());
                            const jaAtivo   = e.status === 'active';
                            const novoAtivo = status === 'active';
                            // Listagem FULL sempre ganha da não-FULL, mesmo pausada ou com
                            // menos estoque: é ela que define o que existe no galpão.
                            const substituir = (eFull !== !!e.eFull)
                                ? eFull
                                : ((!jaAtivo && novoAtivo) || (novoAtivo && estoque > e.estoque));
                            if (substituir) {
                                porSku[entradaExistente] = { ...e, estoque, transferenciaMl, item_id: itemId, inventory_id: invId, status, eFull };
                            }
                        } else {
                            // Produto diferente com mesmo SKU → entrada alternativa com chave sku~itemId
                            const skuAlt = sku + '~' + itemId.toLowerCase();
                            porSku[skuAlt] = { item_id: itemId, inventory_id: invId, sku: skuAlt, titulo: tituloBase, estoque, transferenciaMl, status, eFull };
                            if (!porSku[sku]._itemIds) porSku[sku]._itemIds = [porSku[sku].item_id.toLowerCase()];
                            escrever(`[AVISO] SKU "${sku}" usado em produtos diferentes: "${tituloBase.substring(0, 40)}"`);
                        }
                    }
                }
            }
        }

        // Unidades já enviadas ao FULL e ainda não recebidas — mesma regra do /dados.
        // Contam como estoque a caminho e abatem a reposição.
        const transitoRaw2 = lerJson('transito_local.json', {});
        const transitoPorSku = {};
        for (const [k, v] of Object.entries(transitoRaw2)) {
            transitoPorSku[k.toLowerCase()] = typeof v === 'object' ? (v.quantidade ?? 0) : (Number(v) || 0);
        }
        // Trânsito por "Código ML" (inventory_id). O envio indexado por seller_sku não
        // consegue dizer a qual produto pertence quando vários dividem o mesmo SKU: as
        // mesmas unidades acabavam creditadas a todos eles. O código do galpão é único
        // por produto, então quando o envio o traz, ele manda.
        const transitoPorInv = {};
        const transitoSkuTotal = { ...transitoPorSku };
        for (const e of lerJson('envios_full.json', [])) {
            if (e.inativo) continue;
            if ((e.recebido || 0) >= (e.unidades || 0) && (e.unidades || 0) > 0) continue;
            const temCodigos = e.codigos && Object.keys(e.codigos).length > 0;
            if (temCodigos) {
                for (const [cod, qty] of Object.entries(e.codigos)) {
                    const k = String(cod).toUpperCase();
                    transitoPorInv[k] = (transitoPorInv[k] || 0) + qty;
                }
            }
            for (const [s, qty] of Object.entries(e.skus || {})) {
                const k = s.toLowerCase();
                transitoSkuTotal[k] = (transitoSkuTotal[k] || 0) + qty;
                // transitoPorSku fica só com o legado: envio sem código. Somar os dois
                // contaria as mesmas unidades duas vezes em quem tem inventory_id.
                if (!temCodigos) transitoPorSku[k] = (transitoPorSku[k] || 0) + qty;
            }
        }

        // Relatório de SKUs em risco — gerado ANTES do filtro FULL de propósito: os
        // casos mais perigosos são produtos que ainda não entraram no FULL e por isso
        // sumiriam daqui (ex: dois tapetes diferentes dividindo tap-050). O motor já
        // separava esses produtos, mas o aviso só saía no log, que ninguém lê.
        {
            // Agrupa pelo seller_sku base: "tap-004" e "tap-004~mlb739..." são o mesmo SKU
            const porBase = {};
            for (const [k, d] of Object.entries(porSku)) {
                const base = k.split('~')[0].replace(/#par$/, '');
                (porBase[base] = porBase[base] || []).push(d);
            }
            const skuCompartilhado = [];
            for (const [base, lista] of Object.entries(porBase)) {
                if (lista.length < 2) continue;
                skuCompartilhado.push({
                    sku: base,
                    produtos: lista.map(d => ({
                        titulo:    d.titulo,
                        item_ids:  (d._itemIds || [d.item_id]).map(x => String(x).toUpperCase()),
                        status:    d.status,
                        estoque:   d.estoque,
                        eFull:     !!d.eFull,
                    })),
                });
            }

            // SKUs que só diferem por zero à esquerda ou pontuação (tap-50 vs tap-050).
            // Para o sistema são distintos; para quem cadastrou, quase sempre é digitação.
            const normSku = s => String(s || '').toLowerCase()
                .replace(/[^a-z0-9]+/g, '')
                .replace(/\d+/g, n => String(parseInt(n, 10)));
            const porNorm = {};
            for (const k of Object.keys(porSku)) {
                const bruto = k.split('~')[0].replace(/#par$/, '');
                const n = normSku(bruto);
                if (!n) continue;
                (porNorm[n] = porNorm[n] || new Set()).add(bruto);
            }
            const skusParecidos = Object.values(porNorm)
                .map(s => [...s])
                .filter(a => a.length > 1)
                .map(skus => ({ skus }));

            salvarJson('avisos_sku.json', {
                gerado_em: new Date().toISOString(),
                sku_compartilhado: skuCompartilhado,
                skus_parecidos: skusParecidos,
            });
            if (skuCompartilhado.length || skusParecidos.length) {
                escrever(`[AVISO] ${skuCompartilhado.length} SKU(s) usados por produtos diferentes, ${skusParecidos.length} grupo(s) de SKU parecido`);
            }
        }
        // Fora do FULL o produto continua na base, mas sem reposição: não há galpão do
        // ML para repor. O "estoque" dele é a quantidade declarada no anúncio, que é
        // outra coisa. A tela só os mostra na categoria "Fora do Full", para não poluir
        // o uso diário — são ~500 anúncios na Flavia e ~300 na Cordeiro.
        const totalAntesFiltro = Object.keys(porSku).length;
        const qtdForaDoFull = Object.values(porSku).filter(d => !d.eFull).length;
        escrever(`FULL: ${totalAntesFiltro - qtdForaDoFull} produtos | fora do FULL: ${qtdForaDoFull} (na base, sem reposição)`);

        // Titulos por SKU base, para o rotulo escolher uma palavra que DISTINGA os
        // irmaos. Pegar a primeira palavra fora da stoplist dava "36036d-pisca" quatro
        // vezes seguidas, porque "pisca" esta no titulo dos quatro produtos.
        const titulosPorBase = {};
        for (const [k, d] of Object.entries(porSku)) {
            const b = k.split('~')[0].replace(/#par$/, '');
            (titulosPorBase[b] = titulosPorBase[b] || []).push((d.titulo || '').toLowerCase());
        }

        const duplicidadesEvitadas = [];
        const reposicao = Object.values(porSku).map(d => {
            let vendas30      = 0;
            let faturamento30 = 0;

            // Inclui a entrada "base" (sem ~) quando há irmãos com ~ — sem isso ela
            // soma as vendas de todos os produtos que compartilham o mesmo seller_sku.
            const ehColisao = d.sku.includes('~') || d._itemIds ||
                Object.keys(porSku).some(k => k !== d.sku && k.startsWith(d.sku + '~'));
            if (ehColisao) {
                // Entrada alternativa (produto diferente com mesmo SKU) ou com duplicatas
                // → atribuir por item_id para cada listagem
                const ids = d._itemIds || [d.item_id.toLowerCase()];
                for (const id of ids) {
                    vendas30      += vendasPorItemId[id] || 0;
                    faturamento30 += faturPorItemId[id]  || 0;
                }
            } else {
                // Entrada normal → usa seller_sku
                vendas30      = vendasPorSku[d.sku]      || 0;
                faturamento30 = faturamentoPorSku[d.sku] || 0;
            }

            // Fallback para variações sem SELLER_SKU
            if (!vendas30 && d.variation_id) {
                const vk = d.item_id.toLowerCase() + ':' + d.variation_id;
                vendas30      = vendasPorVariacao[vk] || 0;
                faturamento30 = faturPorVariacao[vk]  || 0;
            }

            faturamento30 = +faturamento30.toFixed(2);
            // vdm em precisão total no cálculo; arredondar antes de multiplicar
            // introduzia erro de até 1 unidade na reposição.
            const vdm = vendas30 / 30;
            const mediaDia = +vdm.toFixed(2);   // só para exibição
            // Dias de venda até a mercadoria chegar. Só vale para anúncio ativo: pausado
            // não vende durante a espera, então não consome estoque nesse período.
            const diasAteChegar = d.status === 'active' ? diasColeta : 0;
            // estoque alvo − estoque projetado no fim da coleta (já descontado o que
            // vende nesse período), com o que está a caminho contando como disponível
            // o trânsito é indexado pelo SKU do envio, sem o sufixo interno da chave
            const skuBase = d.sku.includes('~') ? d.sku.split('~')[0] : d.sku;
            // Código ML primeiro: é único por produto. Só cai no SKU quando o envio não
            // tem código — aí produtos que dividem o SKU voltam a receber o mesmo valor,
            // que é o comportamento antigo e o motivo de existir o painel de avisos.
            const transitoPorCodigo = d.inventory_id ? (transitoPorInv[String(d.inventory_id).toUpperCase()] || 0) : 0;
            // Unidades que o ML já recebeu e move entre galpões já estão dentro de
            // d.estoque. Se o envio que as originou ainda consta aberto em
            // envios_full.json, elas apareceriam de novo no trânsito local e a
            // reposição sairia menor do que o necessário. Só conta o trânsito que o
            // ML ainda não enxerga.
            const transitoLocal = d.inventory_id
                ? transitoPorCodigo + (transitoPorSku[skuBase] || 0)
                : (transitoSkuTotal[skuBase] || 0);
            const jaContadoNoEstoque = d.transferenciaMl || 0;
            const emTransito = Math.max(0, transitoLocal - jaContadoNoEstoque);
            // Cobertura conta o que já está a caminho — a reposição trata o trânsito como
            // disponível, e sem isso as duas colunas se contradiziam: o tb01001 aparecia
            // com cobertura 0 (alarme de ruptura) tendo 45 unidades a caminho.
            // Usa vdm em precisão total, não mediaDia: o arredondamento em 2 casas errava
            // a cobertura em até 11% em quem vende pouco (1 venda/mês → 0,03 vs 0,0333).
            const estoqueCoberto = d.estoque + emTransito;
            const cobertura = estoqueCoberto === 0 ? 0 : (vdm > 0 ? +(estoqueCoberto / vdm).toFixed(1) : 999);
            if (transitoLocal > 0 && jaContadoNoEstoque > 0) {
                duplicidadesEvitadas.push({ sku: skuBase, transitoLocal, jaContadoNoEstoque, usado: emTransito });
            }
            // Só sobra do estoque atual o que não for vendido durante a espera — e ele não
            // pode ficar negativo. A conta antiga (vdm × (alvo+coleta) − estoque) creditava
            // consumo de estoque que não existe, e inflava a compra em quem está com pouco
            // estoque: 4412, com estoque 0, pedia 98 em vez de 66.
            const estoqueNaChegada = Math.max(0, d.estoque - vdm * diasAteChegar);
            // Fora do FULL não há reposição a calcular: sem galpão, não há o que repor lá.
            const rep = d.eFull
                ? Math.max(0, Math.ceil(vdm * diasAlvo - estoqueNaChegada - emTransito))
                : 0;
            const { _itemIds, ...rest } = d;   // não persistir metadata interna
            // "sku" é só rótulo e pode repetir entre produtos diferentes (ex: 010TB em
            // Nivus, Polo e Tera). "chave" é o identificador único — sem ela o frontend
            // reagrupa esses produtos e volta a somar vendas de itens distintos.
            const chave = rest.sku;
            let skuLimpo = chave.includes('~') ? chave.split('~')[0] : chave;
            // Colisão de SKU (ex: 010TB em Polo/Nivus/Tera): extrai palavra do título
            // para gerar um rótulo legível ("010tb-polo", "010tb-nivus", "010tb-tera").
            // Também desambigua o primeiro registro (sem ~) quando há irmãos com ~.
            const temColisao = chave.includes('~') ||
                Object.keys(porSku).some(k => k !== chave && k.startsWith(skuLimpo + '~'));
            if (temColisao) {
                const titulo = (rest.titulo || '').toLowerCase();
                const base   = skuLimpo.toLowerCase();
                const stop   = new Set(['kit','tapete','bandeja','vw','volkswagen','fiat','gm','chevrolet',
                                        'ford','jeep','ram','toyota','honda','hyundai','nissan','renault',
                                        'para','com','pcs','pçs','premium','original','novo','nova','de',
                                        'do','da','pça','peça','jogo','carro','veículo','veiculos',
                                        'anos','ano','modelo','versao','versão','line','set']);
                const candidatas = titulo.split(/[\s\-\/\()+]+/)
                    .filter(w => w.length >= 3 && !/^\d/.test(w) && !stop.has(w) && !base.includes(w));
                const irmaos = (titulosPorBase[base] || []).filter(t => t !== titulo);
                // primeira palavra que nenhum irmão tenha ("onix", "montana"); se todas
                // forem comuns cai na primeira, e o desempate por item_id resolve depois
                let extra = irmaos.length
                    ? candidatas.find(w => !irmaos.some(t => t.includes(w)))
                    : null;
                if (!extra) extra = candidatas[0];
                if (extra) skuLimpo = skuLimpo + '-' + extra;
            }
            return { ...rest, sku: skuLimpo, chave, vendas30, faturamento30, mediaDia, cobertura, reposicao: rep };
        }).sort((a, b) => b.reposicao - a.reposicao);

        if (duplicidadesEvitadas.length) {
            escrever(`[TRÂNSITO] ${duplicidadesEvitadas.length} SKU(s) já tinham unidades contadas pelo ML como transferência — desconto aplicado para não somar duas vezes:`);
            for (const d of duplicidadesEvitadas.slice(0, 15)) {
                escrever(`   ${d.sku}: envio local ${d.transitoLocal} un, ML já conta ${d.jaContadoNoEstoque} un → usado ${d.usado} un`);
            }
        }

        // Curva ABC por faturamento30 (critério: receita acumulada)
        // Garantia final: se dois produtos do mesmo SKU ficaram com o mesmo rotulo, na
        // tela viram linhas identicas e nao da para saber qual e qual. Desempata com o
        // fim do item_id. "sku" aqui e so rotulo — a chave e o transito nao dependem dele.
        const porRotulo = {};
        for (const p of reposicao) (porRotulo[p.sku] = porRotulo[p.sku] || []).push(p);
        for (const [rot, lst] of Object.entries(porRotulo)) {
            if (lst.length < 2) continue;
            for (const p of lst) p.sku = rot + '-' + String(p.item_id).slice(-4).toLowerCase();
        }

        // Só os do FULL entram na curva: incluir os de fora deslocaria os limites A/B/C
        // e reclassificaria produtos que não mudaram em nada.
        const paraAbc = reposicao.filter(p => p.eFull);
        const totalFat = paraAbc.reduce((s, p) => s + p.faturamento30, 0);
        if (totalFat > 0) {
            const ordenados = [...paraAbc].sort((a, b) => b.faturamento30 - a.faturamento30);
            let acum = 0;
            for (const p of ordenados) {
                acum += p.faturamento30;
                const pct = acum / totalFat * 100;
                p.curvaAbc = pct <= 82.5 ? 'A' : pct <= 96.5 ? 'B' : 'C';
            }
        }

        salvarJson('reposicao.json', reposicao);
        fs.writeFileSync(path.join(STORAGE, 'ultima_atualizacao.txt'), new Date().toLocaleString('pt-BR'));

        escrever(`CONCLUÍDO. ${reposicao.length} SKUs processados.`);
        res.end();

    } catch (err) {
        escrever(`ERRO: ${err.response?.data?.message || err.message}`);
        res.end();
    }
});

// ── Faturamento mensal ───────────────────────────────────────────────────────
router.get('/faturamento_mensal', auth, async (req, res) => {
    const cacheFile = 'faturamento_mensal.json';
    const cached = lerJson(cacheFile, null);
    if (cached && cached._atualizado) {
        const idade = Date.now() - new Date(cached._atualizado).getTime();
        if (idade < 6 * 3600 * 1000) return res.json(cached.dados);
    }
    try {
        const { access_token, user_id } = await TokenManager.getToken();
        const headers = { Authorization: `Bearer ${access_token}` };
        const LIMIT = 50;
        const hoje = new Date();
        const dados = [];
        for (let m = 5; m >= 0; m--) {
            const inicio = new Date(hoje.getFullYear(), hoje.getMonth() - m, 1);
            const fim    = new Date(hoje.getFullYear(), hoje.getMonth() - m + 1, 0, 23, 59, 59);
            const label  = inicio.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '');
            let total = 0, offset = 0, paging = null;
            do {
                const { data } = await axios.get('https://api.mercadolibre.com/orders/search', {
                    headers,
                    params: {
                        seller: user_id,
                        'order.date_created.from': inicio.toISOString(),
                        'order.date_created.to':   fim.toISOString(),
                        limit: LIMIT, offset,
                    },
                });
                if (paging === null) paging = data.paging?.total || 0;
                for (const pedido of data.results || [])
                    for (const item of pedido.order_items || [])
                        total += (item.unit_price || 0) * item.quantity;
                offset += LIMIT;
            } while (offset < paging);
            dados.push({ mes: label, valor: +total.toFixed(2) });
        }
        salvarJson(cacheFile, { _atualizado: new Date().toISOString(), dados });
        res.json(dados);
    } catch (err) {
        res.status(500).json({ erro: err.message });
    }
});

// ── Trânsito ────────────────────────────────────────────────────────────────
router.get('/transito', auth, (req, res) => {
    const t = lerJson('transito_local.json', {});
    const out = {};
    for (const [sku, v] of Object.entries(t)) out[sku.toLowerCase()] = v.quantidade ?? v;
    res.json(out);
});

// ── Upload PDF Full ─────────────────────────────────────────────────────────
router.post('/upload_pdf', auth, upload.single('pdf'), async (req, res) => {
    if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado' });

    try {
        const pdf = require('pdf-parse');
        const buffer = fs.readFileSync(req.file.path);
        const { text } = await pdf(buffer);
        fs.unlinkSync(req.file.path);

        const linhas = text.split('\n').map(l => l.trim());

        // Número do frete — "Frete #70594904"
        const mNumero = text.match(/Frete\s*#(\d+)/i);
        if (!mNumero) return res.status(400).json({ erro: 'Número do frete não encontrado no PDF' });
        const numero = mNumero[1];

        // Total de unidades
        const mTotal = text.match(/Total de unidades[:\s]+(\d+)/i);
        const totalUnidades = mTotal ? parseInt(mTotal[1]) : 0;

        // SKUs em ordem — "SKU:" no fim da linha, valor SKU na próxima linha não-vazia.
        // A mesma linha traz o "Código ML" (inventory_id), que é ÚNICO por produto:
        //   "Código ML: ZPDN46840 Código universal: N/A SKU:"
        // O SKU sozinho não identifica quando vários produtos o compartilham, então
        // guardamos os dois em paralelo e o código manda no cálculo do trânsito.
        const skusOrdem = [];
        const codigosOrdem = [];
        const codigoDaLinha = l => {
            const m = String(l).match(/C[oó]digo\s*ML\s*:\s*([A-Za-z0-9]+)/i);
            return m ? m[1].toUpperCase() : null;
        };
        for (let i = 0; i < linhas.length; i++) {
            if (/SKU:\s*$/i.test(linhas[i])) {
                // SKU na próxima linha não-vazia
                for (let j = i + 1; j < linhas.length; j++) {
                    if (linhas[j]) {
                        skusOrdem.push(linhas[j].toLowerCase());
                        codigosOrdem.push(codigoDaLinha(linhas[i]));
                        break;
                    }
                }
            } else {
                // SKU inline: "... SKU: 31178E"
                const m = linhas[i].match(/SKU:\s+(\S+)\s*$/i);
                if (m) {
                    skusOrdem.push(m[1].toLowerCase());
                    codigosOrdem.push(codigoDaLinha(linhas[i]));
                }
            }
        }

        // Quantidades — após cabeçalho da tabela (pode ser "PRODUTOUNIDADES" sem espaços)
        // Cada linha pode ser "20" (pura) ou "20•Texto..." (colada no bullet do ML)
        const tabelaIdx = linhas.findIndex(l => /PRODUTO.{0,5}UNIDADES/i.test(l));
        const qtds = [];
        if (tabelaIdx >= 0) {
            for (let i = tabelaIdx + 1; i < linhas.length; i++) {
                const m = linhas[i].match(/^(\d+)(•|$)/);
                if (m) {
                    const n = parseInt(m[1]);
                    // anos do nome do produto (ex: "2008 2009 2010") não são quantidades
                    if (n >= 1990 && n <= 2040) continue;
                    qtds.push(n);
                }
                if (qtds.length >= skusOrdem.length) break;
            }
        }

        // Monta mapa SKU -> quantidade e, em paralelo, Código ML -> quantidade
        const skus = {};
        const codigos = {};
        skusOrdem.forEach((sku, i) => {
            if (qtds[i] === undefined) return;
            skus[sku] = (skus[sku] || 0) + qtds[i];
            const cod = codigosOrdem[i];
            if (cod) codigos[cod] = (codigos[cod] || 0) + qtds[i];
        });
        // Só entrega "codigos" se TODOS os itens tiverem código. Parcial seria pior que
        // nada: o cálculo usa código quando existe e ignoraria os itens sem ele.
        const todosComCodigo = skusOrdem.length > 0 &&
            codigosOrdem.slice(0, skusOrdem.length).every(Boolean);

        // Confere contra o proprio PDF antes de entregar. Sem isso um erro de leitura
        // entra calado no envio: o #74910211 registrou 844 unidades num PDF de 98,
        // porque a instrucao "260 cm." virou quantidade.
        const somaLida = Object.values(skus).reduce((a, b) => a + b, 0);
        if (totalUnidades > 0 && somaLida !== totalUnidades) {
            return res.status(400).json({
                erro: `Leitura inconsistente: o PDF declara ${totalUnidades} unidades, mas os itens ` +
                      `somam ${somaLida}. Envio nao cadastrado — confira o PDF ou cadastre a mao.`,
                declarado: totalUnidades, somado: somaLida, skus,
            });
        }

        res.json({
            numero,
            unidades: totalUnidades,
            recebido: 0,
            skus: Object.keys(skus).length ? skus : null,
            codigos: todosComCodigo && Object.keys(codigos).length ? codigos : null,
        });

    } catch (err) {
        res.status(500).json({ erro: err.message });
    }
});

// ── Envios Full ─────────────────────────────────────────────────────────────
router.get('/envios', auth, (req, res) => res.json(lerJson('envios_full.json', [])));

router.post('/salvar_envio', auth, (req, res) => {
    const body = req.body;
    let envios = lerJson('envios_full.json', []);

    if (body._excluir) {
        envios = envios.filter(e => e.numero !== body.numero);
    } else {
        const idx = envios.findIndex(e => e.numero === body.numero);
        const entry = { ...body };
        delete entry._excluir;
        if (idx >= 0) envios[idx] = entry;
        else envios.push(entry);
    }

    salvarJson('envios_full.json', envios);
    res.json({ ok: true });
});

// ── Custos ──────────────────────────────────────────────────────────────────
router.get('/custos', auth, (req, res) => res.json(lerJson('custos.json', {})));
router.post('/custos', auth, (req, res) => {
    salvarJson('custos.json', req.body);
    res.json({ ok: true });
});

// ── Importar custos do caminho configurado (GET) ────────────────────────────
router.get('/importar_custos', auth, (req, res) => {
    try {
        const config = JSON.parse(fs.readFileSync(path.join(STORAGE, 'config.json'), 'utf8'));
        const filePath = config.planilha_custos;
        const dica = 'Use o botão de enviar planilha para importar o arquivo .xlsx.';
        if (!filePath) return res.status(400).json({ erro: `Nenhuma planilha fixa configurada. ${dica}` });
        if (!fs.existsSync(filePath)) return res.status(404).json({ erro: `A planilha configurada não existe mais neste computador. ${dica}` });

        const XLSX = require('xlsx');
        const wb = XLSX.readFile(filePath);
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

        const custos = {};
        let importados = 0;
        for (const row of rows) {
            const keys = Object.keys(row);
            const skuKey   = keys.find(k => k.trim().toUpperCase() === 'SKU');
            const custoKey = keys.find(k => k.trim().toUpperCase() === 'CUSTO');
            if (!skuKey || !custoKey) continue;
            const sku   = String(row[skuKey] || '').trim().toLowerCase();
            const custo = parseFloat(String(row[custoKey]).replace(',', '.'));
            if (sku && !isNaN(custo) && custo > 0) { custos[sku] = custo; importados++; }
        }

        const existentes = lerJson('custos.json', {});
        const merged = { ...existentes, ...custos };
        salvarJson('custos.json', merged);

        res.json({ ok: true, importados, total: Object.keys(merged).length, arquivo: path.basename(filePath) });
    } catch (e) {
        res.status(500).json({ erro: e.message });
    }
});

// ── Importar custos de planilha Excel (upload) ───────────────────────────────
router.post('/importar_custos', auth, upload.single('planilha'), (req, res) => {
    if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado' });
    try {
        const XLSX = require('xlsx');
        const wb = XLSX.readFile(req.file.path);
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
        fs.unlinkSync(req.file.path);

        // Detecta colunas independente de maiúsculas/minúsculas
        const custos = {};
        let importados = 0;
        for (const row of rows) {
            const keys = Object.keys(row);
            const skuKey  = keys.find(k => k.trim().toUpperCase() === 'SKU');
            const custoKey = keys.find(k => k.trim().toUpperCase() === 'CUSTO');
            if (!skuKey || !custoKey) continue;
            const sku   = String(row[skuKey] || '').trim().toLowerCase();
            const custo = parseFloat(String(row[custoKey]).replace(',', '.').trim());
            if (sku && !isNaN(custo) && custo > 0) {
                custos[sku] = custo;
                importados++;
            }
        }

        // Mescla com custos existentes (planilha tem prioridade)
        const existentes = lerJson('custos.json', {});
        const merged = { ...existentes, ...custos };
        salvarJson('custos.json', merged);

        res.json({ ok: true, importados, total: Object.keys(merged).length });
    } catch (e) {
        res.status(500).json({ erro: e.message });
    }
});

// ── Gerar planilha Full ─────────────────────────────────────────────────────
// Formato exigido pelo ML: sheet "Dados Mercado Livre", coluna D = item_id,
// coluna F = quantidade, dados começando na linha 6 (linhas 1-5 vazias).
router.post('/gerar_planilha', auth, (req, res) => {
    try {
        const XLSX = require('xlsx');
        const itens = req.body; // [{ item_id, sku, variation_id, qtdFull, chave }]
        if (!Array.isArray(itens) || !itens.length) return res.status(400).json({ erro: 'Sem itens' });

        const wb = XLSX.utils.book_new();
        const ws = {};
        const totalRows = 5 + itens.length;
        // Colunas do template do ML: A=SKU, B=cod. universal, C=código ML,
        // D=nº do anúncio, E=nº da variação, F=quantidade.
        // Só D e F eram preenchidas. Em anúncio com variações as duas linhas saíam com
        // o mesmo nº de anúncio, e o ML rejeitava com "Adicione mais um código para que
        // possamos identificar o produto" — não dava para saber qual variação era qual.
        itens.forEach(({ item_id, sku, inventory_id, variation_id, qtdFull }, i) => {
            const row = 6 + i;
            // SKU no ML é maiúsculo (31173D, TAP-004); o motor guarda tudo minúsculo
            if (sku) ws[`A${row}`] = { v: String(sku).toUpperCase(), t: 's' };
            // C = "Codigo ML" (inventory_id): unico por produto. E ele que separa
            // 010tb-polo de 010tb-tera, que dividem o mesmo seller_sku e por isso
            // ficariam indistinguiveis so com as colunas A e D.
            if (inventory_id) ws[`C${row}`] = { v: String(inventory_id).toUpperCase(), t: 's' };
            ws[`D${row}`] = { v: item_id, t: 's' };
            if (variation_id) ws[`E${row}`] = { v: String(variation_id), t: 's' };
            ws[`F${row}`] = { v: Number(qtdFull) || 0, t: 'n' };
        });
        ws['!ref'] = `A1:F${totalRows}`;
        // Altura de linha comprimida igual ao template do ML (~12.75pt)
        ws['!rows'] = Array.from({ length: totalRows }, () => ({ hpt: 12.75, hpx: 17 }));
        // Template do ML tem duas sheets: "Planilha 1" (vazia) e "Dados Mercado Livre"
        const wsVazia = { '!ref': 'A1:A1' };
        XLSX.utils.book_append_sheet(wb, wsVazia, 'Planilha 1');
        XLSX.utils.book_append_sheet(wb, ws, 'Dados Mercado Livre');

        const config = lerJson('config.json', {});
        const nomeApp = (config.app_nome || 'FULL').toUpperCase().replace(/\s+/g, '_');
        const ts = new Date().toLocaleString('pt-BR', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit' })
            .replace(/[\/\s,:]/g, '').replace(/(\d{2})(\d{2})(\d{4})(\d{6})/, '$3$2$1$4');
        const filename = `${nomeApp}-${ts}-full-preenchido.xlsx`;

        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buf);
    } catch (e) {
        res.status(500).json({ erro: e.message });
    }
});

// ── Info do app (nome, porta, versão) ───────────────────────────────────────
router.get('/app_info', auth, (req, res) => {
    const pkg    = require('../package.json');
    const config = lerJson('config.json', {});
    res.json({
        nome:        config.app_nome    || pkg.productName || pkg.name,
        porta:       config.app_porta   || 3001,
        versao:      pkg.version,
        outro_app:   config.outro_app   || null,
        dias_coleta: config.dias_coleta || 17,
        dias_alvo:   config.dias_alvo   || 35,
    });
});

// ── Avisos de SKU (colisões detectadas na última coleta) ────────────────────
router.get('/avisos_sku', auth, (req, res) => {
    res.json(lerJson('avisos_sku.json', { sku_compartilhado: [], skus_parecidos: [] }));
});

// ── Dias do motor (persistidos para a próxima coleta) ───────────────────────
// Sem isso o valor digitado na tela valia só até o reload: /app_info devolvia o
// config antigo e o motor calculava com ele, ignorando o que estava na tela.
router.post('/config_motor', auth, (req, res) => {
    const config = lerJson('config.json', {});
    const dc = parseInt(req.body.dias_coleta);
    const da = parseInt(req.body.dias_alvo);
    // limites sãos — fora disso é erro de digitação, não estratégia
    if (Number.isFinite(dc) && dc >= 0   && dc <= 120) config.dias_coleta = dc;
    if (Number.isFinite(da) && da >= 1   && da <= 365) config.dias_alvo   = da;
    salvarJson('config.json', config);
    res.json({ ok: true, dias_coleta: config.dias_coleta, dias_alvo: config.dias_alvo });
});

// ── Trocar de conta (lança outro app se offline) ─────────────────────────────
router.post('/switch', auth, (req, res) => {
    const { porta, exe, nome } = req.body;
    if (!porta) return res.status(400).json({ erro: 'porta obrigatória' });

    const http   = require('http');
    const { spawn } = require('child_process');

    // Resolve o caminho do exe. O nome exibido ("Cordeiro Car") nem sempre é o
    // productName da instalação ("Dashboard Cordeiro"), então além dos caminhos
    // exatos procuramos uma pasta instalada que compartilhe uma palavra do nome.
    const exePath = (() => {
        if (exe && fs.existsSync(exe)) return exe;

        const bases = [
            process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
            process.env.PROGRAMFILES,
            process.env['PROGRAMFILES(X86)'],
        ].filter(Boolean);

        const nomes = [req.body.exe_nome, nome].map(n => (n || '').trim()).filter(Boolean);

        // 1) caminho exato <base>/<nome>/<nome>.exe
        for (const base of bases) {
            for (const n of nomes) {
                const p = path.join(base, n, `${n}.exe`);
                if (fs.existsSync(p)) return p;
            }
        }

        // 2) pasta instalada que compartilhe uma palavra significativa do nome
        const palavras = nomes.flatMap(n => n.split(/\s+/)).filter(p => p.length >= 4).map(p => p.toLowerCase());
        if (!palavras.length) return null;

        for (const base of bases) {
            let dirs = [];
            try {
                dirs = fs.readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
            } catch { continue; }
            for (const d of dirs) {
                const dl = d.toLowerCase();
                if (!palavras.some(p => dl.includes(p))) continue;
                const p = path.join(base, d, `${d}.exe`);
                if (fs.existsSync(p)) return p;
            }
        }
        return null;
    })();

    const checar = () => new Promise(ok => {
        const r = http.get(`http://127.0.0.1:${porta}/api/app_info`, (resp) => {
            ok(resp.statusCode === 200);
            resp.resume();
        }).on('error', () => ok(false));
        r.setTimeout(1500, () => { r.destroy(); ok(false); });
    });

    checar().then(async (online) => {
        if (!online && exePath) {
            spawn(exePath, [], { detached: true, stdio: 'ignore' }).unref();
            for (let i = 0; i < 8; i++) {
                await new Promise(r => setTimeout(r, 1000));
                if (await checar()) break;
            }
        }
        const ainda = await checar();
        if (!ainda) return res.json({ ok: false, erro: 'Outro app não está aberto. Abra-o primeiro.' });
        res.json({ ok: true, porta });
    });
});

// ── Status token ────────────────────────────────────────────────────────────
router.get('/token_status', auth, (req, res) => {
    try {
        const t = TokenManager.carregar();
        const restante = (t.created_at + t.expires_in) - Math.floor(Date.now() / 1000);
        res.json({ user_id: t.user_id, restante_segundos: restante, expira_em: new Date((t.created_at + t.expires_in) * 1000).toLocaleString('pt-BR') });
    } catch (e) {
        res.json({ erro: e.message });
    }
});

module.exports = router;
