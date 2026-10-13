// Mudanca de preco em PONTOS DE MARGEM (regra do usuario, 13/10/2026): subir "1" e subir 1 ponto na margem,
// nao 1% no preco. Margem de 1,22% -> 2,22%. Vale para a regra dos tapetes, os botoes -1/+1 do Precificar e para
// levar a mesma mudanca ao outro lado / aos outros anuncios do mesmo SKU (cada um sobre a propria margem).
const fs = require('fs');
const path = require('path');
const P = require('./precificador');
const motor = require('./motor_preco');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const imposto = () => { try { return Number(JSON.parse(fs.readFileSync(path.join(STORAGE, 'config.json'), 'utf8')).imposto_pct ?? 3); } catch { return 3; } };

async function margemEm(headers, c, preco, impostoPct) {
    const tar = await P.tarifa(headers, preco, c.tipo, c.categoria);
    return P.margem(preco, c.frete, c.custo, impostoPct, tar && tar.valor);
}

// preco para a margem (do preco "base", ou do preco atual) mudar "pontos" pontos
async function maisPontos(itemId, pontos = 1, base) {
    const { headers, userId } = await P.auth();
    const impostoPct = imposto();
    const c = await motor.calcular(headers, userId, itemId, impostoPct);
    if (c.custo == null || c.frete == null) throw new Error('Sem custo na planilha ou sem frete: não dá para calcular a margem.');
    const precoBase = base ? Number(base) : c.preco;
    const m0 = base ? (await margemEm(headers, c, precoBase, impostoPct)).margem_pct : c.margem_pct;
    const alvo = r2(m0 + Number(pontos));
    const s = await motor.precoParaMargem(headers, { ...c }, alvo, impostoPct);
    return { item_id: itemId, preco_atual: c.preco, preco_base: precoBase, margem_base: m0, alvo, preco: s.preco, margem_pct: s.margem_pct };
}

// quantos pontos de margem uma mudanca de preco representou (para levar a mesma mudanca a outros anuncios)
async function pontosDaMudanca(itemId, antes, depois) {
    const { headers, userId } = await P.auth();
    const impostoPct = imposto();
    const c = await motor.calcular(headers, userId, itemId, impostoPct);
    if (c.custo == null || c.frete == null) return { pontos: null };
    const [a, d] = await Promise.all([margemEm(headers, c, Number(antes), impostoPct), margemEm(headers, c, Number(depois), impostoPct)]);
    return { pontos: r2(d.margem_pct - a.margem_pct), antes: a.margem_pct, depois: d.margem_pct };
}

module.exports = { maisPontos, pontosDaMudanca };
