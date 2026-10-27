// Saude do projeto (Area do desenvolvedor), no estilo do Harvey: cada parte do Dashboard diz se
// esta ok, em atencao ou falhou, com o detalhe. Leitura apenas; o teste do Gemini gasta 1 chamada
// por chave e so roda quando a pessoa pede.
const fs = require('fs');
const os = require('os');
const path = require('path');
const HOME = require('os').homedir().replace(/\\/g, '/');   // pasta do usuario deste PC (o nome do usuario do Windows muda de PC para PC)
const axios = require('axios');
const { execFile } = require('child_process');
const TokenManager = require('./tokenManager');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ML = 'https://api.mercadolibre.com';
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(path.isAbsolute(arq) ? arq : path.join(STORAGE, arq), 'utf8')); } catch { return d; } };
const idadeH = (arq) => { try { return (Date.now() - fs.statSync(path.join(STORAGE, arq)).mtimeMs) / 3600000; } catch { return null; } };
const quando = (h) => h == null ? 'nunca' : h < 1 ? `há ${Math.round(h * 60)} min` : h < 48 ? `há ${Math.round(h)} h` : `há ${Math.round(h / 24)} dias`;
const hojeBR = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const ontemBR = () => new Date(Date.now() - 27 * 3600 * 1000).toISOString().slice(0, 10);

function item(grupo, nome, status, detalhe, ms) { return { grupo, nome, status, detalhe, ms: ms ?? null }; }
async function cronometro(fn) { const t0 = Date.now(); try { return [await fn(), Date.now() - t0, null]; } catch (e) { return [null, Date.now() - t0, e]; } }
const erroML = (e) => `${e.response?.status || ''} ${e.response?.data?.message || e.message}`.trim();

async function verificar({ testarGemini = false } = {}) {
    const out = [];

    // ---- Mercado Livre
    let headers = null, userId = null;
    {
        const [t, ms, e] = await cronometro(() => TokenManager.getToken());
        if (e) out.push(item('Mercado Livre', 'Token de acesso', 'falha', 'Sem token: ' + e.message + '. Use Renovar Token.', ms));
        else {
            headers = { Authorization: `Bearer ${t.access_token}` }; userId = t.user_id;
            const tk = lerJson('token.json', {});
            const resta = tk.created_at && tk.expires_in ? (tk.created_at + tk.expires_in) - Date.now() / 1000 : null;
            out.push(item('Mercado Livre', 'Token de acesso', 'ok', `conta ${t.user_id}${resta != null ? ` · renova sozinho (vence em ${Math.max(0, Math.round(resta / 60))} min)` : ''}`, ms));
        }
    }
    if (headers) {
        const testes = [
            ['API do Mercado Livre', () => axios.get(`${ML}/users/me`, { headers, timeout: 15000 }), d => d.data.nickname],
            ['API de Publicidade (ADS)', () => axios.get(`${ML}/advertising/advertisers`, { headers, params: { product_id: 'PADS' }, timeout: 15000 }), d => `${(d.data.advertisers || []).length} anunciante(s)`],
            ['API de Promoções', () => axios.get(`${ML}/seller-promotions/users/${userId}`, { headers, params: { app_version: 'v2' }, timeout: 15000 }), d => `${(d.data.results || []).length} campanha(s)`],
            ['API de Pedidos', () => axios.get(`${ML}/orders/search`, { headers, params: { seller: userId, limit: 1 }, timeout: 15000 }), d => `${d.data.paging?.total ?? '?'} pedidos na conta`],
        ];
        for (const [nome, fn, txt] of testes) {
            const [r, ms, e] = await cronometro(fn);
            out.push(e ? item('Mercado Livre', nome, e.response?.status === 429 ? 'atencao' : 'falha', erroML(e), ms)
                       : item('Mercado Livre', nome, ms > 5000 ? 'atencao' : 'ok', `${txt(r)} · ${ms} ms`, ms));
        }
    }

    // ---- Gemini
    {
        const cfg = lerJson('config.json', {});
        const chaves = require('./ia').chavesGemini();
        if (!chaves.length) out.push(item('Gemini', 'Chaves', 'falha', 'Nenhuma chave cadastrada neste PC (Análise com IA).'));
        else if (!testarGemini) out.push(item('Gemini', 'Chaves', 'ok', `${chaves.length} chave(s): ${chaves.map(k => '••••' + k.slice(-4)).join(', ')} · clique em "Testar o Gemini" para conferir cada uma`));
        else {
            const modelo = (Array.isArray(cfg.gemini_modelos) && cfg.gemini_modelos[0]) || 'gemini-3.5-flash-lite';
            for (const k of chaves) {
                const [r, ms, e] = await cronometro(() => axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`,
                    { contents: [{ role: 'user', parts: [{ text: 'Responda só: ok' }] }], generationConfig: { maxOutputTokens: 5 } },
                    { headers: { 'x-goog-api-key': k }, timeout: 30000 }));
                require('./cotas').registrar('gemini', { status: e ? (e.response?.status || 0) : 200, chave: `${k.slice(-4)} · ${modelo}` });
                const st = e ? (e.response?.status === 429 ? 'atencao' : 'falha') : 'ok';
                out.push(item('Gemini', `Chave ••••${k.slice(-4)}`, st, e ? `${e.response?.status === 429 ? 'Cota esgotada agora' : 'Recusada'}: ${(e.response?.data?.error?.message || e.message).slice(0, 140)}` : `${modelo} respondeu em ${ms} ms`, ms));
            }
        }
    }

    // ---- Motores e dados
    const coleta = idadeH('reposicao.json');
    out.push(item('Motores', 'Coleta de estoque e vendas', coleta == null ? 'falha' : coleta > 48 ? 'falha' : coleta > 26 ? 'atencao' : 'ok', `última ${quando(coleta)}`));
    const ab = lerJson('adhealth_abertura.json', {});
    out.push(item('Motores', 'Atualização da 1ª abertura do dia', ab.dia === hojeBR() ? 'ok' : 'atencao', ab.dia === hojeBR() ? `feita hoje às ${new Date(ab.em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : 'ainda não rodou hoje (roda ao abrir o AD HEALTH)'));
    const ont = lerJson('seven_vendas_ontem.json', {});
    out.push(item('Motores', 'Pedidos de ontem', ont.dia === ontemBR() ? 'ok' : 'atencao', ont.dia ? `dia ${ont.dia.split('-').reverse().join('/')} · ${ont.pedidos} pedidos` : 'sem dado'));
    const custos = lerJson('custos.json', null);
    out.push(item('Motores', 'Planilha de custos', custos ? 'ok' : 'falha', custos ? `${Object.keys(custos).length} SKUs com custo · atualizada ${quando(idadeH('custos.json'))}` : 'sem planilha de custos: margem e queima-margem não calculam'));
    try {
        const a = require('./astra').estado();
        const pc = lerJson(HOME + '/Documents/business_Intelligence/seven/saidas/astra_concorrentes.json', null);
        const hPonte = (() => { try { return (Date.now() - fs.statSync(HOME + '/Documents/business_Intelligence/seven/saidas/astra_concorrentes.json').mtimeMs) / 3600000; } catch { return null; } })();
        out.push(item('Motores', 'Concorrentes (Astra / Nubimetrics)', a.rodando ? 'ok' : hPonte == null ? 'atencao' : hPonte > 72 ? 'atencao' : 'ok',
            a.rodando ? `rodando agora (${a.progresso ? a.progresso.feitos + '/' + a.progresso.total : ''})` : pc ? `${(pc.grupos || []).length} grupos · dados ${quando(hPonte)}` : 'sem dados do Astra neste PC'));
    } catch (e) { out.push(item('Motores', 'Concorrentes (Astra / Nubimetrics)', 'atencao', e.message)); }
    try {
        const r = require('./ranking_mt').estado();
        const u = r.ultima || {};
        const h = u.fim ? (Date.now() - new Date(u.fim).getTime()) / 3600000 : null;
        out.push(item('Motores', 'Ranking ML (Issacar)', r.rodando ? 'ok' : u.status === 'falhou' ? 'falha' : h == null || h > 72 ? 'atencao' : 'ok',
            r.rodando ? 'coletando agora' : u.fim ? `última ${quando(h)} · ${u.pesquisados ?? '?'}/${u.total ?? '?'} termos${u.status === 'falhou' ? ' · ' + (u.motivo || 'falhou') : ''}` : 'nunca coletado (só pelo botão)'));
    } catch (e) { out.push(item('Motores', 'Ranking ML (Issacar)', 'atencao', e.message)); }

    // ---- Integracoes deste PC
    {
        const [r, ms, e] = await cronometro(() => axios.get('http://127.0.0.1:8790/api/status', { timeout: 3000, headers: { 'X-Hub': '1' } }));
        out.push(e ? item('Integrações', 'Hub de Pedidos (Finance)', 'atencao', 'não está aberto neste PC (127.0.0.1:8790)', ms)
                   : item('Integrações', 'Hub de Pedidos (Finance)', 'ok', `conectado ao Drive como ${r.data.conta || '?'}`, ms));
    }
    {
        const pkg = require('../package.json'); const pub = (pkg.build && pkg.build.publish) || {};
        const url = `https://github.com/${pub.owner}/${pub.repo}/releases/latest/download/latest.yml`;
        const [r, ms, e] = await cronometro(() => axios.get(url, { timeout: 15000, maxRedirects: 5 }));
        const ultima = r ? ((String(r.data).match(/version:\s*(\S+)/) || [])[1]) : null;
        out.push(e ? item('Integrações', 'Atualização automática', 'falha', `${pub.owner}/${pub.repo}: ${e.response?.status === 404 ? 'repositório não encontrado (404) — os PCs não recebem atualização' : e.message}`, ms)
                   : item('Integrações', 'Atualização automática', ultima === pkg.version ? 'ok' : 'atencao', `instalada ${pkg.version} · publicada ${ultima || '?'} (${pub.owner}/${pub.repo})`, ms));
    }

    // ---- Este PC
    {
        const disco = await new Promise(res => execFile('powershell', ['-NoProfile', '-Command', "(Get-PSDrive C).Free"], { windowsHide: true, timeout: 10000 }, (err, so) => res(err ? null : Number(String(so).trim()))));
        const gb = disco != null ? disco / 1e9 : null;
        out.push(item('Este PC', 'Espaço em disco (C:)', gb == null ? 'atencao' : gb < 3 ? 'falha' : gb < 10 ? 'atencao' : 'ok', gb == null ? 'não consegui ler' : `${gb.toFixed(1)} GB livres`));
        const livreRam = os.freemem() / 1e9, totalRam = os.totalmem() / 1e9;
        out.push(item('Este PC', 'Memória', livreRam < 1 ? 'atencao' : 'ok', `${livreRam.toFixed(1)} de ${totalRam.toFixed(1)} GB livres`));
        out.push(item('Este PC', 'Pasta de dados', 'ok', STORAGE));
    }

    const cont = { ok: 0, atencao: 0, falha: 0 };
    for (const i of out) cont[i.status]++;
    return { verificado_em: new Date().toISOString(), versao: require('../package.json').version, resumo: cont, itens: out };
}

module.exports = { verificar };
