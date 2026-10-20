// Pausar / reativar anuncios no Mercado Livre (20/10/2026), a partir dos selecionados no Painel.
//   PUT /items/{id} { status: 'paused' | 'active' }. So mexe em anuncio que esta ativo ou pausado (em revisao,
//   encerrado ou inativo pelo ML ficam de fora). Cada mudanca fica em STORAGE/anuncios_status_historico.jsonl
//   (quem pausou pode reativar pelo mesmo botao: tudo reversivel e registrado).
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const STORAGE = () => process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const HIST = () => path.join(STORAGE(), 'anuncios_status_historico.jsonl');
const ML = 'https://api.mercadolibre.com';
const dormir = (ms) => new Promise(r => setTimeout(r, ms));

async function chamar(fn) {
    for (let t = 1; ; t++) {
        try { return await fn(); }
        catch (e) { const s = e.response?.status; if ((s === 429 || s >= 500 || !e.response) && t < 4) { await dormir(1500 * t); continue; } throw e; }
    }
}

let rodando = false;
async function alterar(itens, status, origem = 'painel') {
    if (!['paused', 'active'].includes(status)) throw new Error('Status inválido.');
    const ids = [...new Set((itens || []).map(String).filter(x => /^MLB\d+$/.test(x)))];
    if (!ids.length) throw new Error('Nenhum anúncio válido selecionado.');
    if (ids.length > 200) throw new Error('No máximo 200 anúncios por vez.');
    if (rodando) throw new Error('Já existe uma alteração em andamento. Espere terminar.');
    rodando = true;
    const { access_token } = await require('./tokenManager').getToken();
    const headers = { Authorization: `Bearer ${access_token}` };
    const resultado = [];
    try {
        for (const id of ids) {
            const r = { item_id: id, para: status };
            try {
                const it = (await chamar(() => axios.get(`${ML}/items/${id}`, { headers, params: { attributes: 'id,title,status,sub_status' }, timeout: 20000 }))).data;
                Object.assign(r, { titulo: it.title, de: it.status });
                if (it.status === status) r.ok = true, r.aviso = status === 'paused' ? 'já estava pausado' : 'já estava ativo';
                else if (!['active', 'paused'].includes(it.status)) r.ok = false, r.erro = `anúncio ${it.status}${(it.sub_status || []).length ? ' (' + it.sub_status.join(', ') + ')' : ''}: não dá para mudar por aqui`;
                else {
                    await chamar(() => axios.put(`${ML}/items/${id}`, { status }, { headers: { ...headers, 'Content-Type': 'application/json' }, timeout: 30000 }));
                    r.ok = true;
                }
            } catch (e) { r.ok = false; r.erro = String(e.response?.data?.message || e.response?.data?.error || e.message).slice(0, 160); }
            if (r.ok && !r.aviso) try { fs.appendFileSync(HIST(), JSON.stringify({ quando: new Date().toISOString(), item_id: id, titulo: r.titulo, de: r.de, para: status, origem }) + '\n'); } catch {}
            resultado.push(r);
            await dormir(250);
        }
    } finally { rodando = false; }
    return { ok: true, status, alterados: resultado.filter(r => r.ok && !r.aviso).length, sem_mudanca: resultado.filter(r => r.aviso).length, falhas: resultado.filter(r => !r.ok).length, itens: resultado };
}

function historico(n = 100) {
    try { return fs.readFileSync(HIST(), 'utf8').trim().split('\n').filter(Boolean).slice(-n).reverse().map(l => JSON.parse(l)); } catch { return []; }
}

module.exports = { alterar, historico };
