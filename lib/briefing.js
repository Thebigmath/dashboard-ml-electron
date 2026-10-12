// Balanco do dia (card Rankeamento > Analise da IA). Escalada de Prata:
//   bronze (aqui, sem IA): todos os numeros do dia anterior e do mes, de cada motor do AD HEALTH
//   prata (Gemini): le os numeros e devolve blocos fixos em JSON (leitura, previsao, riscos,
//                   oportunidades, acoes). Nao calcula nada: se faltar dado, diz "sem dado".
// Guardado ate o fim do dia (ou ate pedir "Gerar de novo"): os numeros de ontem nao mudam.
const fs = require('fs');
const path = require('path');
const ia = require('./ia');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const CACHE = path.join(STORAGE, 'briefing_dia.json');
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const hojeBR = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
const pct = (a, b) => b ? r2((a / b - 1) * 100) : null;

// ---- bronze: os numeros ------------------------------------------------------------------
async function numeros() {
    const n = { avisos: [] };
    const tenta = async (nome, fn) => { try { return await fn(); } catch (e) { n.avisos.push(`${nome}: ${e.message}`); return null; } };

    const f = await tenta('faturamento', () => ia.faturamento());
    if (f) n.vendas = {
        ontem_dia: f.ontem.dia, ontem_valor: f.ontem.valor, ontem_pedidos: f.ontem.pedidos,
        media_dia_mes_anterior: f.mes_anterior.media_dia, ontem_vs_normal_pct: pct(f.ontem.valor, f.mes_anterior.media_dia),
        mes_ate_agora: f.mes.valor, mes_pedidos: f.mes.pedidos, media_dia_mes: f.mes.media_dia, projecao_mes: f.mes.projecao,
        mes_anterior_nome: f.mes_anterior.nome, mes_anterior_total: f.mes_anterior.valor, ritmo_vs_mes_anterior_pct: f.ritmo != null ? r2(f.ritmo * 100) : null,
    };

    const s = await tenta('saude', () => ia.saude());
    if (s) {
        const ativos = s.itens.filter(i => i.status === 'active');
        const destaque = (i) => ({ sku: i.sku, titulo: String(i.titulo || '').slice(0, 50), ontem: i.ontem, media_dia: i.media_dia, curva: i.curva });
        n.anuncios = {
            ativos: ativos.length,
            venderam_ontem: ativos.filter(i => i.ontem > 0).length,
            acima_da_media: ativos.filter(i => i.ontem > (i.media_dia || 0) * 1.5 && i.ontem >= 2).map(destaque).sort((a, b) => b.ontem - a.ontem).slice(0, 5),
            curva_a_parados_ontem: ativos.filter(i => i.curva === 'A' && i.ontem === 0 && (i.media_dia || 0) >= 1).map(destaque).slice(0, 5),
            com_sinal_de_problema: s.ordem ? s.ordem.filter(i => i.sinais.length).length : null,
        };
    }

    const mp = await tenta('regras de preço', () => require('./motor_preco').avaliar());
    if (mp) n.precos = {
        subir_1_ponto: mp.subir.map(l => ({ sku: l.sku, ontem: l.ontem, margem_pct: l.margem_pct, preco: l.preco, sugerido: l.sugerido && l.sugerido.preco })),
        tracionados_1o_nubimetrics: mp.tracionados.map(l => ({ sku: l.sku, margem_pct: l.margem_pct, vendas_mes: l.vendas_mes })),
        tracionados_fora_do_1o: mp.tracionados_outros.length,
    };

    const ads = await tenta('ADS', () => require('./ads').resumo({ dias: 7 }));
    if (ads) {
        const ult = ads.serie[ads.serie.length - 1] || null;
        n.ads = {
            ontem: ult ? { dia: ult.dia, gasto: ult.gasto, receita: ult.receita, roas: ult.gasto ? r2(ult.receita / ult.gasto) : null } : null,
            semana: { gasto: ads.gasto, receita: ads.receita, acos_pct: ads.acos, roas: ads.roas, vendas: ads.conversoes },
            campanhas_acima_do_acos_alvo: ads.campanhas.filter(c => c.status === 'active' && c.acos != null && c.acos_alvo && c.acos > c.acos_alvo)
                .map(c => ({ nome: c.nome, acos_pct: c.acos, alvo_pct: c.acos_alvo, gasto: c.gasto })),
        };
    }

    const pr = lerJson(path.join(STORAGE, 'promocoes_central.json'), null);   // so o que ja foi lido (a leitura completa leva 1 min)
    if (pr) n.promocoes = {
        lido_em: pr.atualizado_em, subsidiadas_que_valem: pr.frentes.subsidiadas, anuncios_sem_promocao: pr.frentes.sem_promocao,
        em_campanha_com_margem_negativa: pr.frentes.margem_negativa,
        campanhas_fechando_em_7_dias: pr.campanhas.filter(c => c.prazo_adesao && (new Date(c.prazo_adesao) - Date.now()) / 86400000 <= 7 && (new Date(c.prazo_adesao) - Date.now()) > 0)
            .map(c => ({ nome: c.nome, adesao_ate: c.prazo_adesao.slice(0, 10), valem_entrar: c.entrar })),
    };
    else n.avisos.push('promoções: ainda não lidas hoje (abra a aba Promoções do card Defesa)');

    const par = await tenta('estoque parado', () => require('./parado_controle').controle({ minDias: 60 }));
    if (par) n.estoque_parado = { anuncios_full: par.produtos, unidades: par.unidades, dinheiro_parado: par.potencial, sem_venda_30_dias: par.sem_venda };

    return n;
}

// ---- prata: o Gemini le e organiza -----------------------------------------------------------
const SISTEMA = [
    'Voce e o analista de operacao da Seven (autopecas no Mercado Livre). Escreve em portugues do Brasil, direto, sem enrolacao.',
    'Voce recebe NUMEROS JA CALCULADOS do dia anterior e do mes. Nunca invente, nunca recalcule, nunca estime numero que nao esteja nos dados.',
    'Cite os numeros exatamente como vieram (pode arredondar centavos). Se algo nao estiver nos dados, nao fale sobre isso.',
    'Regras de preco da empresa: vendeu 2+ ontem com margem < 15% -> subir +1 ponto; margem >= 15% = tracionado (nao precisa subir).',
].join(' ');
const FORMATO = `Responda SO com um JSON neste formato:
{
 "manchete": "uma frase com o mais importante de ontem",
 "leituras": [ {"area": "Vendas|Preços|ADS|Promoções|Estoque|Anúncios", "status": "bom|atencao|ruim", "texto": "1-2 frases com numeros"} ],
 "previsao": { "texto": "2-3 frases sobre o fechamento do mes e a proxima semana, usando projecao_mes e ritmo", "fechamento_estimado": numero_ou_null },
 "riscos": [ "frase curta com numero" ],
 "oportunidades": [ "frase curta com numero" ],
 "acoes": [ {"prioridade": 1, "area": "...", "acao": "verbo no imperativo, especifico (SKU, campanha)", "porque": "numero que justifica"} ]
}
No maximo 6 leituras, 4 riscos, 4 oportunidades e 5 acoes, ordenadas por impacto em dinheiro.`;

async function gerar({ forcar = false } = {}) {
    const c = lerJson(CACHE, null);
    if (!forcar && c && c.dia === hojeBR()) return c;
    const n = await numeros();
    const t0 = Date.now();
    const r = await ia.gerarGemini(SISTEMA, `NUMEROS (JSON)\n${JSON.stringify(n)}\n\n${FORMATO}`, 2048, null, { json: true });
    let analise;
    try { analise = JSON.parse(r.texto.replace(/^```json\s*|\s*```$/g, '')); }
    catch { analise = { manchete: 'A IA respondeu fora do formato.', leituras: [], riscos: [], oportunidades: [], acoes: [], bruto: r.texto.slice(0, 2000) }; }
    const out = { dia: hojeBR(), gerado_em: new Date().toISOString(), ms: Date.now() - t0, modelo: r.modelo, numeros: n, analise };
    fs.mkdirSync(STORAGE, { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(out), 'utf8');
    return out;
}

module.exports = { gerar, numeros };
