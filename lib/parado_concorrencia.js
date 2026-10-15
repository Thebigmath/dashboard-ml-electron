// Controle de estoque parado > "Concorrência e preço" (pedido do usuario em 15/10/2026, no lugar da queima-margem):
// compara o anuncio parado com os concorrentes do mesmo grupo do Nubimetrics e sugere o preco.
// Escalada de Prata: a REGRA calcula os precos possiveis; a IA (Gemini) so confirma ou segura e explica em 2 frases.
//   dados ...... grupo do Nubimetrics (arquivo do Astra): ranking com preco e vendas de cada concorrente e a data do dado
//   alvo ....... preco do LIDER do grupo (quem mais vende); sem lider, a mediana de quem vende
//   piso ....... preco que deixa MARGEM_MIN% de margem de contribuicao (nunca sugere abaixo disso)
//   decisao .... margem abaixo do piso -> SUBIR ate o piso (se ficar ate 5% acima do alvo); 1o em vendas do grupo -> nao baixa;
//                acima do alvo (+3%) -> BAIXAR ate o alvo (ou ate o piso, se o alvo estiver abaixo dele)
//                abaixo do alvo (-5%) e margem < 15% -> SUBIR ate o alvo (o preco nao e o que trava a venda)
//                no meio -> MANTER (o problema e visibilidade: ADS, titulo, fotos)
// Aplicar: o mesmo caminho do Precificar (P.aplicar), com confirmacao na tela.
const fs = require('fs');
const path = require('path');
const P = require('./precificador');
const motor = require('./motor_preco');
const ia = require('./ia');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const MARGEM_MIN = 5, TOLERA_ACIMA = 3, TOLERA_ABAIXO = 5, MARGEM_BOA = 15;
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
const mediana = (L) => { const s = [...L].sort((a, b) => a - b); if (!s.length) return null; const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : r2((s[m - 1] + s[m]) / 2); };

async function margemEm(headers, c, preco, impostoPct) {
    const tar = await P.tarifa(headers, preco, c.tipo, c.categoria);
    return P.margem(preco, c.frete, c.custo, impostoPct, tar && tar.valor);
}

async function analisar(itemId, { usarIA = true } = {}) {
    const { headers, userId } = await P.auth();
    const impostoPct = Number(lerJson(path.join(STORAGE, 'config.json'), {}).imposto_pct ?? 7);
    const c = await motor.calcular(headers, userId, itemId, impostoPct);
    const rep = lerJson(path.join(STORAGE, 'reposicao.json'), []).find(r => r.item_id === itemId) || {};
    const vendas30 = Number(rep.vendas30) || 0, estoque = rep.estoque ?? null;
    const dias = vendas30 > 0 && estoque != null ? Math.round(estoque / (vendas30 / 30)) : null;
    const g = require('./seven').concorrenciaDoAnuncio(itemId);

    // a linha "nos" da comparacao usa o MESMO periodo dos concorrentes (Nubimetrics); as vendas de 30 dias ficam a parte
    const minhaLinha = g ? (g.ranking.find(r => r.nosso && r.posicao === g.posicao) || g.ranking.find(r => r.nosso)) : null;
    const nos = { preco: c.preco, margem_pct: c.margem_pct ?? null, margem: c.margem ?? null, vendas30, estoque, dias, posicao: g ? g.posicao : null,
        vendas_periodo: minhaLinha ? minhaLinha.vendas : null };
    const out = { item_id: itemId, sku: rep.sku || '', titulo: rep.titulo || '', tipo: c.tipo === 'gold_pro' ? 'Premium' : 'Clássico', custo: c.custo, frete: c.frete,
        imposto_pct: impostoPct, nos, concorrencia: null, sugestao: null };
    if (g) {
        const outros = g.ranking.filter(r => !r.nosso && !r.outra_conta && r.preco > 0);
        const outraConta = g.ranking.find(r => r.outra_conta);
        const vendem = outros.filter(r => r.vendas > 0);
        const lider = g.lider && g.lider.preco ? g.lider : (vendem[0] || null);
        out.concorrencia = { grupo: g.grupo, dados_de: g.dados_de, anuncios: g.anuncios, periodo_dias: g.dias || 7,
            outra_conta: outraConta ? { vendedor: outraConta.vendedor, preco: outraConta.preco, vendas: outraConta.vendas, posicao: outraConta.posicao } : null, dias_dado: g.dados_de ? Math.round((Date.now() - new Date(g.dados_de + 'T12:00:00-03:00')) / 86400000) : null,
            lider: lider ? { vendedor: lider.vendedor, preco: lider.preco, vendas: lider.vendas, posicao: lider.posicao } : null,
            menor: vendem.length ? Math.min(...vendem.map(r => r.preco)) : null, mediana: mediana(vendem.map(r => r.preco)), concorrentes_vendendo: vendem.length,
            top: outros.slice(0, 5).map(r => ({ posicao: r.posicao, vendedor: r.vendedor, preco: r.preco, vendas: r.vendas })) };
        const alvo = out.concorrencia.lider ? out.concorrencia.lider.preco : out.concorrencia.mediana;
        out.concorrencia.alvo = alvo;
        out.concorrencia.dif_pct = alvo ? r2((c.preco / alvo - 1) * 100) : null;
    }

    // ---- regra (bronze) ----
    let s = { acao: 'manter', preco: c.preco, motivo: '' };
    const conc = out.concorrencia;
    if (c.custo == null || c.frete == null || c.margem_pct == null) s.motivo = c.custo == null ? 'Sem custo na planilha: dá para comparar, mas não para sugerir preço.' : 'Frete ou tarifa indisponível no Mercado Livre.';
    else if (!conc || !conc.alvo) s.motivo = 'Sem concorrente com venda no grupo do Nubimetrics: o preço não é a referência aqui.';
    else {
        const piso = await motor.precoParaMargem(headers, { ...c }, MARGEM_MIN, impostoPct);
        out.piso = { preco: piso.preco, margem_pct: piso.margem_pct };
        if (c.margem_pct < MARGEM_MIN && piso.preco <= conc.alvo * 1.05) {
            s = { acao: 'subir', preco: r2(piso.preco), motivo: `A margem está em ${c.margem_pct}%, abaixo do piso de ${MARGEM_MIN}%: subir até o piso ainda deixa o preço perto do líder.` };
        } else if (nos.posicao === 1 && c.preco > conc.alvo) {
            s.motivo = `Somos o 1º em vendas do grupo (${vendas30} em 30 dias): baixar até o concorrente só corta margem. O estoque está alto para o giro; o caminho é ADS ou reduzir a reposição.`;
        } else if (c.preco > conc.alvo * (1 + TOLERA_ACIMA / 100)) {
            const novo = r2(Math.max(conc.alvo, piso.preco));
            if (novo < c.preco - 0.009) s = { acao: 'baixar', preco: novo, motivo: novo > conc.alvo ? `Estamos ${conc.dif_pct}% acima do líder; dá para baixar até o piso de ${MARGEM_MIN}% de margem, que ainda fica acima dele.` : `Estamos ${conc.dif_pct}% acima do líder: empatar com ele.` };
            else s.motivo = `Estamos acima do líder, mas já no piso de ${MARGEM_MIN}% de margem: baixar mais dá prejuízo.`;
        } else if (c.preco < conc.alvo * (1 - TOLERA_ABAIXO / 100) && c.margem_pct < MARGEM_BOA) {
            s = { acao: 'subir', preco: r2(conc.alvo), motivo: `Estamos ${Math.abs(conc.dif_pct)}% abaixo do líder e mesmo assim parados: o preço não é o que trava a venda; dá para ganhar margem.` };
        } else s.motivo = `Preço alinhado com o líder (${conc.dif_pct > 0 ? '+' : ''}${conc.dif_pct}%): o que trava é visibilidade (ADS, título, fotos), não o preço.`;
        if (s.acao !== 'manter') { const m = await margemEm(headers, c, s.preco, impostoPct); s.margem_pct = m.margem_pct; s.margem = m.margem; }
    }
    out.sugestao = { fonte: 'regra', ...s, regra: { ...s } };

    // ---- IA (prata): confirma ou segura e explica; nunca escolhe outro preco ----
    if (usarIA && conc && c.margem_pct != null) {
        const sistema = `Você é o analista de preços de uma loja de autopeças no Mercado Livre. O anúncio está com ESTOQUE PARADO.
Recebe os números do anúncio, dos concorrentes do mesmo grupo (Nubimetrics) e a decisão da regra. Você NÃO inventa preço:
só confirma a decisão da regra ("confirmar") ou segura ("manter") se houver risco (dado velho, poucos concorrentes, margem muito baixa).
Responda SÓ em JSON: {"decisao":"confirmar"|"manter","motivo":"2 frases curtas em português, falando dos números","estrategia":"1 frase com o próximo passo além do preço (ADS, título, kit...) ou vazio"}.`;
        const prompt = JSON.stringify({ aviso: `vendas da concorrencia e nos.vendas_periodo sao dos ultimos ${conc ? conc.periodo_dias : 7} dias (Nubimetrics); nos.vendas30 sao 30 dias`, nos: out.nos, custo: c.custo, frete: c.frete, piso_margem_5: out.piso || null, concorrencia: conc, regra: s });
        try {
            const g2 = await Promise.race([ia.gerarGemini(sistema, prompt, 600, 'gemini-3.1-flash-lite', { json: true }),
                new Promise((_, rej) => setTimeout(() => rej(new Error('demorou mais de 40 s')), 40000))]);
            const j = JSON.parse(String(g2.texto).replace(/^```(json)?|```$/g, '').trim());
            const segura = j.decisao === 'manter' && s.acao !== 'manter';
            out.sugestao = { ...out.sugestao, fonte: 'ia', modelo: g2.modelo, acao: segura ? 'manter' : s.acao, preco: segura ? c.preco : s.preco,
                margem_pct: segura ? c.margem_pct : s.margem_pct, motivo: String(j.motivo || s.motivo), estrategia: String(j.estrategia || ''), ia_segurou: segura };
        } catch (e) { out.sugestao.aviso_ia = 'IA indisponível agora (' + String(e.message).slice(0, 80) + '): decisão da regra.'; }
    }
    return out;
}

async function aplicar(itemId, preco, motivo) {
    const r = await P.aplicar(itemId, Number(preco), { origem: 'parados-concorrencia', motivo: String(motivo || '').slice(0, 300), confirmarGrande: true });
    return r;
}

module.exports = { analisar, aplicar };
