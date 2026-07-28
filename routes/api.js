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
    const transito  = lerJson('transito_local.json', {});
    const ultima    = fs.existsSync(path.join(STORAGE, 'ultima_atualizacao.txt'))
        ? fs.readFileSync(path.join(STORAGE, 'ultima_atualizacao.txt'), 'utf8') : null;

    res.json({ produtos: reposicao, transito, ultima_atualizacao: ultima });
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
        const diasAlvo = 44;

        // 1. Pedidos últimos 30 dias
        const dataInicio = new Date(Date.now() - 30 * 86400000).toISOString().replace('Z', '-03:00');
        const dataFim = new Date().toISOString().replace('Z', '-03:00');

        escrever('Carregando pedidos...');
        let pedidos = [], offset = 0, total = null;
        do {
            const { data } = await axios.get(`https://api.mercadolibre.com/orders/search`, {
                headers,
                params: { seller: user_id, 'order.date_created.from': dataInicio, 'order.date_created.to': dataFim, limit: LIMIT, offset }
            });
            if (total === null) total = data.paging?.total || 0;
            pedidos = pedidos.concat(data.results || []);
            offset += LIMIT;
        } while (offset < total);
        escrever(`Pedidos: ${pedidos.length}`);

        // 2. Vendas por SKU
        const vendasPorSku = {};
        for (const pedido of pedidos) {
            for (const item of pedido.order_items || []) {
                const sku = (item.item?.seller_sku || '').trim().toLowerCase();
                if (sku) vendasPorSku[sku] = (vendasPorSku[sku] || 0) + item.quantity;
            }
        }

        // 3. Anúncios ativos
        escrever('Carregando anúncios...');
        let anunciosIds = [];
        for (const status of ['', 'closed']) {
            offset = 0; total = null;
            do {
                const params = { limit: LIMIT, offset };
                if (status) params.status = status;
                const { data } = await axios.get(`https://api.mercadolibre.com/users/${user_id}/items/search`, { headers, params });
                if (total === null) total = data.paging?.total || 0;
                anunciosIds = anunciosIds.concat(data.results || []);
                offset += LIMIT;
            } while (offset < total);
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

        // 5. Montar reposição
        const porSku = {};
        for (const itemId of anunciosIds) {
            const p = produtos[itemId];
            if (!p || p.error) continue;

            let sku = '';
            for (const attr of p.attributes || []) {
                if (attr.id === 'SELLER_SKU') { sku = (attr.value_name || '').trim().toLowerCase(); break; }
            }
            if (!sku) sku = itemId.toLowerCase();

            const estoque = p.available_quantity || 0;
            const status = p.status || '';

            if (!porSku[sku]) {
                porSku[sku] = { item_id: itemId, sku, titulo: p.title || '', estoque, status };
            } else {
                const jaAtivo = porSku[sku].status === 'active';
                const novoAtivo = status === 'active';
                if ((!jaAtivo && novoAtivo) || (novoAtivo && estoque > porSku[sku].estoque)) {
                    porSku[sku] = { ...porSku[sku], estoque, item_id: itemId, status };
                }
            }
        }

        const reposicao = Object.values(porSku).map(d => {
            const vendas30 = vendasPorSku[d.sku] || 0;
            const mediaDia = +(vendas30 / 30).toFixed(2);
            const cobertura = d.estoque === 0 ? 0 : (mediaDia > 0 ? +(d.estoque / mediaDia).toFixed(1) : 999);
            const rep = Math.max(0, Math.ceil(diasAlvo * mediaDia - d.estoque));
            return { ...d, vendas30, mediaDia, cobertura, reposicao: rep };
        }).sort((a, b) => b.reposicao - a.reposicao);

        salvarJson('reposicao.json', reposicao);
        fs.writeFileSync(path.join(STORAGE, 'ultima_atualizacao.txt'), new Date().toLocaleString('pt-BR'));

        escrever(`CONCLUÍDO. ${reposicao.length} SKUs processados.`);
        res.end();

    } catch (err) {
        escrever(`ERRO: ${err.response?.data?.message || err.message}`);
        res.end();
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

        // SKUs em ordem — "SKU:" no fim da linha, valor SKU na próxima linha não-vazia
        const skusOrdem = [];
        for (let i = 0; i < linhas.length; i++) {
            if (/SKU:\s*$/i.test(linhas[i])) {
                // SKU na próxima linha não-vazia
                for (let j = i + 1; j < linhas.length; j++) {
                    if (linhas[j]) { skusOrdem.push(linhas[j].toLowerCase()); break; }
                }
            } else {
                // SKU inline: "... SKU: 31178E"
                const m = linhas[i].match(/SKU:\s+(\S+)\s*$/i);
                if (m) skusOrdem.push(m[1].toLowerCase());
            }
        }

        // Quantidades — após cabeçalho da tabela (pode ser "PRODUTOUNIDADES" sem espaços)
        // Cada linha pode ser "20" (pura) ou "20•Texto..." (colada no bullet do ML)
        const tabelaIdx = linhas.findIndex(l => /PRODUTO.{0,5}UNIDADES/i.test(l));
        const qtds = [];
        if (tabelaIdx >= 0) {
            for (let i = tabelaIdx + 1; i < linhas.length; i++) {
                const m = linhas[i].match(/^(\d+)(\s|•|$)/);
                if (m) qtds.push(parseInt(m[1]));
                if (qtds.length >= skusOrdem.length) break;
            }
        }

        // Monta mapa SKU -> quantidade
        const skus = {};
        skusOrdem.forEach((sku, i) => { if (qtds[i] !== undefined) skus[sku] = qtds[i]; });

        res.json({
            numero,
            unidades: totalUnidades,
            recebido: 0,
            skus: Object.keys(skus).length ? skus : null,
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
        if (!filePath) return res.status(400).json({ erro: 'planilha_custos não configurada em config.json' });
        if (!fs.existsSync(filePath)) return res.status(404).json({ erro: `Arquivo não encontrado: ${filePath}` });

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
router.post('/gerar_planilha', auth, (req, res) => {
    try {
        const XLSX = require('xlsx');
        const itens = req.body; // [{ item_id, sku, qtdFull }]
        if (!Array.isArray(itens) || !itens.length) return res.status(400).json({ erro: 'Sem itens' });
        const reposicao = lerJson('reposicao.json', []);
        const rows = itens.map(({ item_id, sku, qtdFull }) => {
            const p = reposicao.find(x => x.item_id === item_id) || {};
            return {
                'Item ID': item_id,
                'SKU': sku || p.sku || '',
                'Título': p.titulo || '',
                'Estoque Atual': p.estoque || 0,
                'Vendas 30d': p.vendas30 || 0,
                'Média/Dia': p.mediaDia || 0,
                'Qtd Full': qtdFull,
            };
        });
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Reposição Full');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', 'attachment; filename="reposicao_full.xlsx"');
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
        nome:      config.app_nome  || pkg.productName || pkg.name,
        porta:     config.app_porta || 3001,
        versao:    pkg.version,
        outro_app: config.outro_app || null,
    });
});

// ── Trocar de conta (lança outro app se offline) ─────────────────────────────
router.post('/switch', auth, (req, res) => {
    const { porta, exe, nome } = req.body;
    if (!porta) return res.status(400).json({ erro: 'porta obrigatória' });

    const http   = require('http');
    const { spawn } = require('child_process');

    // Resolve caminho do exe: tenta o configurado, depois o caminho padrão de instalação NSIS
    const exePath = (() => {
        if (exe && fs.existsSync(exe)) return exe;
        const appNome = (nome || '').trim() || 'Dashboard';
        const localPrograms = path.join(process.env.LOCALAPPDATA || '', 'Programs', appNome, `${appNome}.exe`);
        if (fs.existsSync(localPrograms)) return localPrograms;
        // Fallback: busca em Program Files
        const pf = path.join(process.env.PROGRAMFILES || 'C:\\Program Files', appNome, `${appNome}.exe`);
        if (fs.existsSync(pf)) return pf;
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
