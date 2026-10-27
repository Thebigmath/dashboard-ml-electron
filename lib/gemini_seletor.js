// Seletor de modelos do Gemini (27/10/2026). Substitui o "Complexo de IA" (uma chave por agente): a cota do Gemini e por PROJETO e por MODELO, entao
// 20 chaves do mesmo projeto davam a mesma cota de uma, e 14 dos 20 agentes nunca eram chamados. Agora:
//   - uma lista de chaves por PC (~/.seven/gemini.json), coladas na tela; as chaves antigas do complexo_ia.json sao trazidas uma vez (o arquivo antigo nao e apagado)
//   - cada tarefa pede um PERFIL: "preciso" (leitura de notas: modelo bom primeiro) ou "rapido" (cards e resumos: modelo leve primeiro)
//   - quando um modelo estoura a cota (429) o Google diz ate quando: o seletor LEMBRA (~/.seven/ia_estado.json) e vai direto ao proximo, sem gastar uma
//     chamada para tomar o erro de novo; 503 (alta demanda) fica de molho por 45 s; chave recusada (400/401/403) e pulada por 10 min
//   - sem modelo disponivel, o erro diz a hora em que volta
// A ordem dos perfis vem do banco de testes com 15 notas escaneadas (gemini-3-flash-preview 12/15, gemini-3.5-flash-lite 11/15, gemini-3.1-flash-lite 10/15
// com as correcoes do leitor) e pode ser trocada em ~/.seven/gemini.json -> "perfis".
const fs = require('fs');
const os = require('os');
const path = require('path');

const PASTA = () => process.env.SEVEN_PASTA || path.join(os.homedir(), '.seven');
const ARQ_CHAVES = () => path.join(PASTA(), 'gemini.json');
const ARQ_ESTADO = () => path.join(PASTA(), 'ia_estado.json');
const ARQ_USO = () => path.join(PASTA(), 'ia_uso.json');
const ARQ_COMPLEXO = () => path.join(PASTA(), 'complexo_ia.json');
const URL_GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
const PERFIS_PADRAO = {
    preciso: ['gemini-3-flash-preview', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
    rapido: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3-flash-preview'],
};
const PADRAO_CHAVE = /^[A-Za-z0-9_.-]{30,}$/;
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
const gravar = (arq, o) => { fs.mkdirSync(path.dirname(arq), { recursive: true }); const t = arq + '.tmp'; fs.writeFileSync(t, JSON.stringify(o, null, 2), 'utf8'); fs.renameSync(t, arq); };
const fim = (k) => String(k).slice(-4);
const diaBR = (ms) => new Date(ms - 3 * 3600e3).toISOString().slice(0, 10);

// ---------------------------------------------------------------- chaves
function carregarChaves() {
    let d = lerJson(ARQ_CHAVES(), null);
    if (d && d.migrado) return d;
    d = d || { versao: 1, chaves: [] };
    // 1x: traz as chaves do Complexo de IA antigo (areas -> agentes -> chave); o arquivo antigo fica como esta
    const c = lerJson(ARQ_COMPLEXO(), null), vistas = new Set(d.chaves.map(x => x.chave));
    for (const a of Object.values((c && c.areas) || {})) for (const g of Object.values(a.agentes || {})) {
        const k = String(g.chave || '').trim();
        if (PADRAO_CHAVE.test(k) && !vistas.has(k)) { vistas.add(k); d.chaves.push({ chave: k, origem: 'complexo_ia.json', adicionada_em: new Date().toISOString() }); }
    }
    d.migrado = true; d.migrado_em = new Date().toISOString();
    try { gravar(ARQ_CHAVES(), d); } catch {}
    return d;
}
const chaves = () => carregarChaves().chaves.map(x => x.chave);
function adicionarChave(chave, origem = 'tela') {
    chave = String(chave || '').trim();
    if (!PADRAO_CHAVE.test(chave)) throw new Error('Isso não parece uma chave da API do Gemini (letras e números, sem espaços, geralmente começa com "AIza"). Copie a chave inteira.');
    const d = carregarChaves();
    if (d.chaves.some(x => x.chave === chave)) return { ok: true, ja_existia: true, final: fim(chave), total: d.chaves.length };
    d.chaves.push({ chave, origem, adicionada_em: new Date().toISOString() }); gravar(ARQ_CHAVES(), d);
    return { ok: true, final: fim(chave), total: d.chaves.length };
}
function removerChave(final) {
    const d = carregarChaves(), antes = d.chaves.length;
    d.chaves = d.chaves.filter(x => fim(x.chave) !== String(final)); if (d.chaves.length === antes) throw new Error('Não achei essa chave.');
    gravar(ARQ_CHAVES(), d); return { ok: true, total: d.chaves.length };
}
async function testarChave(chave, { fetch: f = globalThis.fetch } = {}) {
    const t0 = Date.now();
    try {
        const r = await f(`${URL_GEMINI}/models?pageSize=200`, { headers: { 'x-goog-api-key': chave }, signal: AbortSignal.timeout(20000) });
        const d = await r.json().catch(() => ({})), ms = Date.now() - t0;
        if (!r.ok) return { ok: false, status: r.status === 429 ? 'cota esgotada' : [400, 401, 403].includes(r.status) ? 'recusada' : 'erro', detalhe: `HTTP ${r.status} ${String((d.error || {}).message || '').slice(0, 140)}`.trim(), ms };
        const nomes = (d.models || []).map(m => String(m.name || '').split('/').pop()), uteis = [...new Set(Object.values(perfis()).flat())];
        return { ok: true, status: 'conectada', modelos_disponiveis: uteis.filter(m => nomes.includes(m)), modelos_ausentes: uteis.filter(m => !nomes.includes(m)), ms };
    } catch (e) { return { ok: false, status: 'sem conexao', detalhe: String(e.message).slice(0, 140) }; }
}
// testa na API e so entao guarda
async function salvarChave(chave, opc = {}) {
    chave = String(chave || '').trim();
    if (!PADRAO_CHAVE.test(chave)) throw new Error('Isso não parece uma chave da API do Gemini (letras e números, sem espaços, geralmente começa com "AIza"). Copie a chave inteira.');
    const t = await testarChave(chave, opc);
    if (!t.ok) throw new Error(`O Google não aceitou esta chave (${t.status}${t.detalhe ? ': ' + t.detalhe : ''}). Nada foi gravado.`);
    return { ...adicionarChave(chave), teste: t };
}

// ---------------------------------------------------------------- perfis de modelos
function perfis() { const p = carregarChaves().perfis || {}; return { preciso: (Array.isArray(p.preciso) && p.preciso.length ? p.preciso : PERFIS_PADRAO.preciso), rapido: (Array.isArray(p.rapido) && p.rapido.length ? p.rapido : PERFIS_PADRAO.rapido) }; }
const perfilModelos = (nome) => (perfis()[nome] || perfis().rapido).slice();

// ---------------------------------------------------------------- memoria de cota
let estadoMem = null;
const estadoLer = () => estadoMem || (estadoMem = lerJson(ARQ_ESTADO(), { itens: {} }));
const estadoGravar = () => { try { gravar(ARQ_ESTADO(), estadoMem); } catch {} };
const chaveEstado = (modelo, chave) => `${modelo}|${fim(chave)}`;
function bloqueio(modelo, chave, agora) {
    const e = estadoLer().itens[chaveEstado(modelo, chave)] || null; if (e && Date.parse(e.ate) > agora) return e;
    const k = estadoLer().itens['chave|' + fim(chave)]; return k && Date.parse(k.ate) > agora ? k : null;
}
function bloquear(modelo, chave, ms, agora, motivo, extra = {}) {
    const itens = estadoLer().itens; itens[modelo ? chaveEstado(modelo, chave) : 'chave|' + fim(chave)] = { ate: new Date(agora + ms).toISOString(), motivo, ...extra, em: new Date(agora).toISOString() };
    for (const [k, v] of Object.entries(itens)) if (Date.parse(v.ate) < agora - 86400e3) delete itens[k];
    estadoGravar();
}
function liberar(modelo, chave) { const itens = estadoLer().itens, k = chaveEstado(modelo, chave); if (itens[k]) { delete itens[k]; estadoGravar(); } }
// o Google diz quando a cota volta: RetryInfo.retryDelay ("20275s") ou "Please retry in 12.3s"; QuotaFailure diz se e por minuto ou por dia
function esperaDoErro(d) {
    const det = ((d && d.error) || {}).details || [], rt = det.find(x => /RetryInfo/.test(x['@type'] || '')), q = det.find(x => /QuotaFailure/.test(x['@type'] || ''));
    let s = rt && rt.retryDelay ? parseFloat(rt.retryDelay) : NaN; if (!isFinite(s)) { const m = String(((d && d.error) || {}).message || '').match(/retry in ([\d.]+)s/i); s = m ? parseFloat(m[1]) : NaN; }
    return { s: isFinite(s) ? s : null, dia: !!(q && (q.violations || []).some(v => /PerDay/i.test(v.quotaId || ''))) };
}

// ---------------------------------------------------------------- uso (para a tela)
let usoMem = null;
const usoLer = () => usoMem || (usoMem = lerJson(ARQ_USO(), { dias: {}, ultimas: [] }));
let usoTimer = null;
function usar(ev, agora) {
    const u = usoLer(), dia = diaBR(agora), m = ((u.dias[dia] ||= {})[ev.modelo] ||= { ok: 0, cota: 0, erro: 0 });
    if (ev.ok) m.ok++; else if (ev.status === 429) m.cota++; else m.erro++;
    u.ultimas.unshift({ quando: new Date(agora).toISOString(), ...ev }); u.ultimas.length = Math.min(u.ultimas.length, 60);
    for (const d of Object.keys(u.dias).sort().slice(0, -7)) delete u.dias[d];
    if (!usoTimer) usoTimer = setTimeout(() => { usoTimer = null; try { gravar(ARQ_USO(), usoMem); } catch {} }, 2000).unref();
}

// ---------------------------------------------------------------- chamada
let proxima = 0;   // revezamento entre chaves
const quando = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
// opc: { sistema, prompt, contents, numPredict, json, perfil, modelos (lista que manda), chaves (proprias, vao na frente), tarefa, temperature,
//        fetch/agora (testes) }
async function chamar(opc = {}) {
    const f = opc.fetch || globalThis.fetch, agora = opc.agora || Date.now;
    const pool = [...new Set([...(opc.chaves || []).map(k => String(k || '').trim()).filter(Boolean), ...revezar(chaves().concat(opc.legado || []).filter((k, i, a) => a.indexOf(k) === i))])];
    if (!pool.length) throw new Error('Chave do Gemini não cadastrada neste PC.');
    const lista = opc.modelos && opc.modelos.length ? opc.modelos : perfilModelos(opc.perfil || 'rapido');
    const tentativas = []; let ultimo = '', recusadas = new Set();
    for (const modelo of lista) {
        for (const chave of pool) {
            if (recusadas.has(chave)) continue;
            const bl = bloqueio(modelo, chave, agora());
            if (bl) { tentativas.push({ modelo, chave: fim(chave), pulado: true, ate: bl.ate, motivo: bl.motivo }); continue; }
            for (let t = 0; t < 2; t++) {
                const t0 = Date.now(); let r, d;
                try {
                    r = await f(`${URL_GEMINI}/models/${modelo}:generateContent`, { method: 'POST', signal: AbortSignal.timeout(opc.timeoutMs || 150000), headers: { 'Content-Type': 'application/json', 'x-goog-api-key': chave },
                        body: JSON.stringify({ ...(opc.sistema ? { systemInstruction: { parts: [{ text: opc.sistema }] } } : {}), contents: opc.contents || [{ role: 'user', parts: [{ text: opc.prompt }] }],
                            generationConfig: { temperature: opc.temperature ?? 0.2, topP: 0.9, maxOutputTokens: opc.numPredict || 1024, ...(opc.json ? { responseMimeType: 'application/json' } : {}) } }) });
                    d = await r.json().catch(() => ({}));
                } catch (e) { ultimo = `${modelo}: ${e.message}`; tentativas.push({ modelo, chave: fim(chave), status: 0 }); usar({ modelo, ok: false, status: 0, tarefa: opc.tarefa || '', ms: Date.now() - t0 }, agora()); if (t === 0) { await dormir(opc.espera ?? 1500); continue; } bloquear(modelo, chave, 45e3, agora(), 'sem conexão'); break; }
                const ms = Date.now() - t0;
                try { require('./cotas').registrar('gemini', { status: r.status, ms, chave: `${fim(chave)} · ${modelo}` }); } catch {}
                if (r.ok) {
                    const c = (d.candidates || [])[0] || {}, texto = ((c.content || {}).parts || []).map(x => x.text || '').join('');
                    if (texto) {
                        liberar(modelo, chave); usar({ modelo, ok: true, status: 200, tarefa: opc.tarefa || '', ms }, agora()); proxima = (pool.indexOf(chave) + 1) % pool.length;
                        const um = d.usageMetadata || {};
                        return { texto, modelo, chave: fim(chave), agente: null, tokens: um.candidatesTokenCount || 0, prompt_tokens: um.promptTokenCount || 0, cortada: c.finishReason === 'MAX_TOKENS', rebaixado: modelo !== lista[0], tentativas };
                    }
                    ultimo = `${modelo}: resposta vazia${c.finishReason ? ' (' + c.finishReason + ')' : ''}`; tentativas.push({ modelo, chave: fim(chave), status: 200, vazia: true }); usar({ modelo, ok: false, status: 200, tarefa: opc.tarefa || '', ms }, agora()); break;
                }
                const detalhe = JSON.stringify(d.error || d).slice(0, 160); ultimo = `chave ${fim(chave)} / ${modelo}: ${r.status} ${detalhe}`;
                tentativas.push({ modelo, chave: fim(chave), status: r.status }); usar({ modelo, ok: false, status: r.status, tarefa: opc.tarefa || '', ms }, agora());
                if (r.status === 429) { const e = esperaDoErro(d), espera = ((e.s != null ? e.s : (e.dia ? 6 * 3600 : 60)) + 5) * 1000; bloquear(modelo, chave, espera, agora(), e.dia ? 'cota do dia esgotada' : 'limite por minuto', { dia: e.dia }); tentativas[tentativas.length - 1].ate = new Date(agora() + espera).toISOString(); break; }
                if (r.status === 404) { bloquear(modelo, chave, 3600e3, agora(), 'modelo indisponível para esta chave'); break; }
                if ([400, 401, 403].includes(r.status)) { if (/API key|API_KEY|permission|denied/i.test(detalhe) || r.status !== 400) { bloquear(null, chave, 600e3, agora(), 'chave recusada'); recusadas.add(chave); } break; }
                if (t === 0) { await dormir(opc.espera ?? 1500); continue; }   // 500/503: mais uma vez
                bloquear(modelo, chave, 45e3, agora(), 'alta demanda'); break;
            }
        }
    }
    const ate = tentativas.filter(x => x.ate).map(x => x.ate).sort()[0];
    const e = new Error(tentativas.length && tentativas.every(x => x.pulado || x.status === 429) && ate ? `Cota do Gemini esgotada nos modelos (${lista.join(', ')}): volta por volta das ${quando(ate)}.` : 'Gemini indisponível: ' + (ultimo || 'nenhum modelo respondeu'));
    if (ate) { e.codigo = 'cota'; e.volta_em = ate; } e.tentativas = tentativas; throw e;
}
const dormir = (ms) => new Promise(r => setTimeout(r, ms));
function revezar(L) { if (!L.length) return L; const i = proxima % L.length; return [...L.slice(i), ...L.slice(0, i)]; }

// ---------------------------------------------------------------- para a tela
function resumo(agora = Date.now()) {
    const d = carregarChaves(), est = estadoLer().itens, u = usoLer(), dia = diaBR(agora), todos = [...new Set(Object.values(perfis()).flat())];
    const modelos = todos.map(m => {
        const por = d.chaves.map(c => est[chaveEstado(m, c.chave)]).filter(e => e && Date.parse(e.ate) > agora);
        const todasEsgotadas = d.chaves.length > 0 && por.length === d.chaves.length;
        return { modelo: m, perfis: Object.entries(perfis()).filter(([, l]) => l.includes(m)).map(([n, l]) => `${n} (${l.indexOf(m) + 1}º)`), hoje: ((u.dias[dia] || {})[m]) || { ok: 0, cota: 0, erro: 0 },
            esgotado_ate: todasEsgotadas ? por.map(e => e.ate).sort()[0] : null, motivo: por[0] ? por[0].motivo : null };
    });
    return { arquivo: ARQ_CHAVES(), dia, chaves: d.chaves.map(c => ({ final: fim(c.chave), origem: c.origem, adicionada_em: c.adicionada_em, recusada: !!(est['chave|' + fim(c.chave)] && Date.parse(est['chave|' + fim(c.chave)].ate) > agora) })), perfis: perfis(), modelos, ultimas: u.ultimas.slice(0, 25) };
}
function _reiniciar() { estadoMem = null; usoMem = null; proxima = 0; }

module.exports = { chamar, chaves, adicionarChave, removerChave, salvarChave, testarChave, perfis, perfilModelos, resumo, carregarChaves, PERFIS_PADRAO, _reiniciar };
