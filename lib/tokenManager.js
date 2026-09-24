const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { registrar } = require('./registro');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const configPath = path.join(STORAGE, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const TOKEN_FILE = path.join(STORAGE, 'token.json');
const LOG_FILE = path.join(STORAGE, 'token.log');
const THRESHOLD = 600; // 10 min antes de expirar
const REDIRECT_URI = 'https://claude.ai/new';

function log(msg, evento) {
    const linha = `[${new Date().toISOString()}] ${msg}\n`;
    try { fs.appendFileSync(LOG_FILE, linha); } catch {}
    // O token.log é texto corrido, bom de ler na mão; o JSONL é para responder
    // depois "quantas vezes renovou hoje e por quê" sem garimpar texto.
    if (evento) registrar('token', evento);
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
    log(`OK: Token renovado. Expira em ${new Date((novo.created_at + novo.expires_in) * 1000).toLocaleString('pt-BR')}`,
        { evento: 'renovado', user_id: novo.user_id, expira_em_s: novo.expires_in });
    return novo;
}

// O ML ROTACIONA o refresh_token: cada renovação invalida a anterior. Como o app
// dispara várias chamadas ao mesmo tempo (motor, frete, perguntas, reputação),
// duas podiam achar o token vencido no mesmo instante e renovar em paralelo — a
// segunda invalidava a primeira e o app caía em invalid_grant. Aqui só a
// primeira renova de verdade; as outras esperam a MESMA promessa.
let renovacaoEmCurso = null;

function renovarUmaVezSo() {
    if (renovacaoEmCurso) return renovacaoEmCurso;
    renovacaoEmCurso = (async () => {
        // Relê do disco: outro processo (o outro app, o Jordan) pode ter acabado
        // de renovar — nesse caso não há o que renovar, só usar.
        const atual = carregar();
        if (tempoRestante(atual) > THRESHOLD) {
            registrar('token', { evento: 'reaproveitado_do_disco', expira_em_s: tempoRestante(atual) });
            return atual;
        }
        return renovar(atual);
    })().finally(() => { renovacaoEmCurso = null; });
    return renovacaoEmCurso;
}

async function getToken() {
    const token = carregar();
    if (tempoRestante(token) > THRESHOLD) return token;

    try {
        return await renovarUmaVezSo();
    } catch (err) {
        const msg = err.response?.data?.message || err.message;
        log(`ERRO: Falha na renovação: ${msg}`, { evento: 'renovacao_falhou', erro: String(msg).slice(0, 200) });
        return token;   // vencido, mas devolver é melhor que derrubar a chamada
    }
}

module.exports = { getToken, salvar, carregar };
