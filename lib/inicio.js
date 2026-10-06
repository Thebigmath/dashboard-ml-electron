// Pagina inicial: os tres numeros do feed (mes ate agora, faturado ontem, ano ate agora).
//
// Faturamento = soma de preco x quantidade dos pedidos NAO cancelados, pela data do
// pedido no horario de Brasilia. Mes fechado nao muda: e buscado uma vez e guardado;
// so o mes corrente (e ontem) voltam a ser lidos, no maximo a cada 15 minutos.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const TokenManager = require('./tokenManager');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const CACHE = path.join(STORAGE, 'inicio_faturamento.json');
const VALIDADE_MS = 15 * 60 * 1000;

function lerCache() {
    try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return { meses: {} }; }
}
function salvarCache(c) {
    fs.mkdirSync(STORAGE, { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(c, null, 2), 'utf8');
}

// "Agora" no horario de Brasilia, em campos UTC (getUTC* = data local de Brasilia)
function agoraBR() { return new Date(Date.now() - 3 * 3600 * 1000); }
const iso = (d) => d.toISOString().slice(0, 10);

async function pagina(headers, params) {
    for (let tentativa = 0; ; tentativa++) {
        try {
            const { data } = await axios.get('https://api.mercadolibre.com/orders/search', { headers, params, timeout: 20000 });
            return data;
        } catch (e) {
            if (e.response?.status === 429 && tentativa < 5) { await new Promise(r => setTimeout(r, 1500 * (tentativa + 1))); continue; }
            throw e;
        }
    }
}

// Faturamento e pedidos entre dois dias (inclusive), 'YYYY-MM-DD' em Brasilia
async function faturamento(de, ate) {
    const { access_token, user_id } = await TokenManager.getToken();
    const headers = { Authorization: `Bearer ${access_token}` };
    const base = {
        seller: user_id, limit: 50,
        'order.date_created.from': `${de}T00:00:00.000-03:00`,
        'order.date_created.to': `${ate}T23:59:59.999-03:00`,
    };
    const primeira = await pagina(headers, { ...base, offset: 0 });
    const total = primeira.paging?.total || 0;
    const paginas = [primeira];
    const offsets = [];
    for (let o = 50; o < total; o += 50) offsets.push(o);
    for (let k = 0; k < offsets.length; k += 5) {
        paginas.push(...await Promise.all(offsets.slice(k, k + 5).map(offset => pagina(headers, { ...base, offset }))));
    }
    let valor = 0, pedidos = 0;
    for (const pg of paginas) {
        for (const o of pg.results || []) {
            if (o.status === 'cancelled') continue;
            pedidos++;
            for (const it of o.order_items || []) valor += Number(it.unit_price || 0) * Number(it.quantity || 0);
        }
    }
    return { valor: +valor.toFixed(2), pedidos };
}

let emAndamento = null;

async function resumo(forcar = false) {
    if (emAndamento) return emAndamento;
    emAndamento = (async () => {
        const cache = lerCache();
        const hoje = agoraBR();
        const ano = hoje.getUTCFullYear();
        const mesAtual = hoje.getUTCMonth(); // 0-11
        const ontem = new Date(hoje); ontem.setUTCDate(ontem.getUTCDate() - 1);
        const chaveMes = (m) => `${ano}-${String(m + 1).padStart(2, '0')}`;

        const fresco = !forcar && cache.atualizado_em && (Date.now() - new Date(cache.atualizado_em).getTime() < VALIDADE_MS)
            && cache.hoje === iso(hoje);

        if (!fresco) {
            // meses fechados do ano: so os que ainda nao estao guardados
            for (let m = 0; m < mesAtual; m++) {
                const k = chaveMes(m);
                if (cache.meses[k]) continue;
                const de = `${k}-01`;
                const ate = iso(new Date(Date.UTC(ano, m + 1, 0)));
                cache.meses[k] = await faturamento(de, ate);
            }
            cache.mes_atual = await faturamento(`${chaveMes(mesAtual)}-01`, iso(hoje));
            cache.ontem = { dia: iso(ontem), ...await faturamento(iso(ontem), iso(ontem)) };
            cache.hoje = iso(hoje);
            cache.atualizado_em = new Date().toISOString();
            salvarCache(cache);
        }

        let anoValor = cache.mes_atual.valor, anoPedidos = cache.mes_atual.pedidos;
        for (let m = 0; m < mesAtual; m++) {
            const v = cache.meses[chaveMes(m)];
            if (v) { anoValor += v.valor; anoPedidos += v.pedidos; }
        }
        return {
            mes: { valor: cache.mes_atual.valor, pedidos: cache.mes_atual.pedidos, nome: hoje.toLocaleString('pt-BR', { month: 'long', timeZone: 'UTC' }), ate_dia: hoje.getUTCDate() },
            ontem: cache.ontem,
            ano: { valor: +anoValor.toFixed(2), pedidos: anoPedidos, ano },
            atualizado_em: cache.atualizado_em,
        };
    })();
    try { return await emAndamento; } finally { emAndamento = null; }
}

module.exports = { resumo };
