const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const STORAGE = process.env.STORAGE_PATH || require('path').join(__dirname, '../storage');
const ARQ_CONFIG = path.join(STORAGE, 'config.json');
const lerConfig = () => JSON.parse(fs.readFileSync(ARQ_CONFIG, 'utf8'));   // lida a cada pedido (Secret Key pode mudar)
const TokenManager = require('../lib/tokenManager');

const REDIRECT_URI = 'https://claude.ai/new';

// Página de gerar token
router.get('/gerar_token', (req, res) => {
    const config = lerConfig();
    const authUrl = `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${config.client_id}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=offline_access%20supply_chain`;
    res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><title>Gerar Token</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0d14;color:#fff;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
.card{background:#111827;border:1px solid rgba(10,132,255,.25);border-radius:16px;padding:40px;max-width:520px;width:100%}
h1{font-size:20px;margin-bottom:20px}
.step{display:flex;gap:12px;margin-bottom:16px;font-size:13px;color:rgba(255,255,255,.65)}
.n{width:24px;height:24px;border-radius:50%;background:#0a84ff;color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.btn{display:block;width:100%;padding:14px;background:#0a84ff;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;text-decoration:none;text-align:center;margin-bottom:24px}
hr{border:none;border-top:1px solid rgba(255,255,255,.1);margin:24px 0}
label{display:block;font-size:11px;text-transform:uppercase;color:rgba(255,255,255,.35);margin-bottom:6px}
input{width:100%;height:44px;background:rgba(10,132,255,.06);border:0.5px solid rgba(10,132,255,.30);border-radius:10px;color:#fff;font-size:13px;padding:0 14px;outline:none;font-family:monospace}
button[type=submit]{width:100%;height:44px;margin-top:12px;background:#0a84ff;border:none;border-radius:10px;color:#fff;font-size:14px;font-weight:600;cursor:pointer}
</style></head>
<body><div class="card">
<h1>🔑 Autorizar — Flavia Stock</h1>
<div class="step"><div class="n">1</div><div>Clique em <strong>Autorizar no ML</strong> e logue com a conta <strong>99249917</strong></div></div>
<div class="step"><div class="n">2</div><div>Copie o <strong>?code=XXXXX</strong> da URL do Python.org ou claude.ai</div></div>
<div class="step"><div class="n">3</div><div>Cole abaixo e clique <strong>Trocar pelo Token</strong></div></div>
<a href="${authUrl}" class="btn" target="_blank">Autorizar no Mercado Livre →</a>
<hr>
<details style="margin:0 0 18px"><summary style="cursor:pointer;font-size:12px;color:rgba(255,255,255,.55)">Trocou a Secret Key no portal do Mercado Livre? Cole a nova aqui</summary>
<form method="POST" action="/auth/app_secret" style="margin-top:10px">
<label>App ID (client_id)</label>
<input type="text" name="client_id" value="${String(config.client_id || '').replace(/[^0-9]/g, '')}">
<label style="margin-top:10px">Secret Key nova (client_secret)</label>
<input type="password" name="client_secret" placeholder="Cole a Secret Key nova" autocomplete="off">
<button type="submit">Salvar Secret Key</button>
</form></details>
<form method="POST" action="/auth/callback">
<label>Código (code)</label>
<input type="text" name="code" placeholder="Cole o code aqui..." autofocus>
<button type="submit">Trocar pelo Token</button>
</form>
</div></body></html>`);
});

// Grava a Secret Key nova (depois de trocar no portal do ML). Nunca devolve o segredo para a tela.
router.post('/app_secret', (req, res) => {
    const id = String(req.body.client_id || '').trim(), sec = String(req.body.client_secret || '').trim();
    if (!/^\d{6,}$/.test(id) || sec.length < 10) return res.send('<h2 style="font-family:system-ui;color:#f85149;padding:40px">App ID ou Secret Key inválidos.<br><a href="/auth/gerar_token" style="color:#0a84ff">← Voltar</a></h2>');
    const c = lerConfig(); c.client_id = id; c.client_secret = sec;
    const tmp = ARQ_CONFIG + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(c, null, 4), 'utf8'); fs.renameSync(tmp, ARQ_CONFIG);
    res.send('<h2 style="font-family:system-ui;color:#3fb950;padding:40px">✅ Secret Key salva. Agora autorize de novo no Mercado Livre.<br><a href="/auth/gerar_token" style="color:#0a84ff">→ Autorizar</a></h2>');
});

// Troca o code pelo token
router.post('/callback', async (req, res) => {
    const config = lerConfig();
    const code = req.body.code?.trim();
    if (!code) return res.send('Código ausente.');

    try {
        const resp = await axios.post('https://api.mercadolibre.com/oauth/token',
            new URLSearchParams({
                grant_type: 'authorization_code',
                client_id: config.client_id,
                client_secret: config.client_secret,
                code,
                redirect_uri: REDIRECT_URI,
            }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        const token = resp.data;
        token.created_at = Math.floor(Date.now() / 1000);

        // Extrai user_id do access_token
        const match = token.access_token?.match(/-(\d{6,})$/);
        if (match) token.user_id = parseInt(match[1]);

        // Fallback: /users/me
        if (!token.user_id) {
            const me = await axios.get('https://api.mercadolibre.com/users/me', {
                headers: { Authorization: `Bearer ${token.access_token}` }
            });
            token.user_id = me.data.id;
        }

        TokenManager.salvar(token);
        res.send(`<h2 style="font-family:system-ui;color:#3fb950;padding:40px">✅ Token salvo! User ID: ${token.user_id}<br><a href="/" style="color:#0a84ff">← Voltar ao dashboard</a></h2>`);

    } catch (err) {
        res.send(`<h2 style="font-family:system-ui;color:#f85149;padding:40px">❌ Erro: ${err.response?.data?.message || err.message}<br><a href="/auth/gerar_token" style="color:#0a84ff">← Tentar novamente</a></h2>`);
    }
});

module.exports = router;
