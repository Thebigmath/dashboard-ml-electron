const fs = require('fs');
const path = require('path');
const axios = require('axios');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const configPath = path.join(STORAGE, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const TOKEN_FILE = path.join(STORAGE, 'token.json');
const LOG_FILE = path.join(STORAGE, 'token.log');
const THRESHOLD = 600; // 10 min antes de expirar
const REDIRECT_URI = 'https://claude.ai/new';

function log(msg) {
    const linha = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(LOG_FILE, linha);
}

function carregar() {
    if (!fs.existsSync(TOKEN_FILE)) throw new Error('token.json não encontrado');
    const raw = fs.readFileSync(TOKEN_FILE, 'utf8');
    const token = JSON.parse(raw);
    if (!token.access_token) throw new Error('token.json inválido');
    return token;
}

function salvar(token) {
    if (!token.created_at) token.created_at = Math.floor(Date.now() / 1000);
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 4), 'utf8');
}

function tempoRestante(token) {
    return (token.created_at + token.expires_in) - Math.floor(Date.now() / 1000);
}

async function renovar(token) {
    const resp = await axios.post('https://api.mercadolibre.com/oauth/token',
        new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: config.client_id,
            client_secret: config.client_secret,
            refresh_token: token.refresh_token,
            redirect_uri: REDIRECT_URI,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const novo = resp.data;
    novo.created_at = Math.floor(Date.now() / 1000);

    // Extrai user_id
    const match = novo.access_token?.match(/-(\d{6,})$/);
    if (match) novo.user_id = parseInt(match[1]);
    if (!novo.user_id) novo.user_id = token.user_id;

    salvar(novo);
    log(`OK: Token renovado. Expira em ${new Date((novo.created_at + novo.expires_in) * 1000).toLocaleString('pt-BR')}`);
    return novo;
}

async function getToken() {
    let token = carregar();

    if (tempoRestante(token) > THRESHOLD) return token;

    try {
        token = await renovar(token);
    } catch (err) {
        log(`ERRO: Falha na renovação: ${err.response?.data?.message || err.message}`);
    }

    return token;
}

module.exports = { getToken, salvar, carregar };
