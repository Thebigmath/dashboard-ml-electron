// Senha da Area do desenvolvedor (mesmo esquema do Harvey).
// A senha NUNCA fica no codigo (o repositorio e publico) nem e mostrada: so o hash scrypt com sal fica no
// config.json local do app (%APPDATA%\mediacoes-ml\storage). Na primeira vez, o hash e gerado a partir do
// arquivo px32.txt da Area de Trabalho. A IA nunca recebe a senha: ela nao entra em prompt nenhum, e mensagem
// que contenha a senha nao e repassada para a IA.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const CONFIG = path.join(STORAGE, 'config.json');
// arquivo da senha na Area de Trabalho de quem instala (so na 1a vez, para gerar o hash); sem ele a area fica bloqueada
const ARQ_SENHA = path.join(require('os').homedir(), 'Desktop', 'px32.txt');
const VALIDADE_MS = 8 * 3600 * 1000;   // a sessao vale 8 h (e some quando o app fecha)
const sessoes = new Map();
const tentativas = [];

const lerCfg = () => { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; } };
const hash = (texto, sal) => crypto.scryptSync(String(texto), Buffer.from(sal, 'hex'), 32).toString('hex');

// Gera o hash a partir do px32.txt se ainda nao existir. Nao devolve nem registra a senha.
function garantirHash() {
    const c = lerCfg();
    if (c.dev_senha_hash && c.dev_senha_sal) return true;
    let senha = '';
    try { senha = fs.readFileSync(ARQ_SENHA, 'utf8').trim(); } catch { return false; }
    if (!senha) return false;
    const sal = crypto.randomBytes(16).toString('hex');
    c.dev_senha_sal = sal; c.dev_senha_hash = hash(senha, sal); c.dev_senha_len = senha.length;
    fs.mkdirSync(STORAGE, { recursive: true });
    fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2), 'utf8');
    return true;
}

function confere(senha) {
    const c = lerCfg();
    if (!c.dev_senha_hash || !c.dev_senha_sal) return false;
    const a = Buffer.from(hash(senha, c.dev_senha_sal), 'hex'), b = Buffer.from(c.dev_senha_hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Entrar: devolve um token de sessao. Depois de 5 erros em 10 min, bloqueia por 10 min.
function entrar(senha) {
    const agora = Date.now();
    while (tentativas.length && agora - tentativas[0] > 10 * 60 * 1000) tentativas.shift();
    if (tentativas.length >= 5) return { ok: false, erro: 'Muitas tentativas. Aguarde 10 minutos.' };
    if (!garantirHash()) return { ok: false, erro: 'Senha da Área do desenvolvedor não configurada.' };
    if (!confere(senha)) { tentativas.push(agora); return { ok: false, erro: 'Senha incorreta.' }; }
    // instalacoes antigas nao tinham o tamanho: grava no primeiro acesso certo (acelera o contemSenha)
    const c = lerCfg();
    if (!c.dev_senha_len) { c.dev_senha_len = senha.length; fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2), 'utf8'); }
    const token = crypto.randomBytes(24).toString('hex');
    sessoes.set(token, agora + VALIDADE_MS);
    return { ok: true, token };
}
function valido(token) {
    const ate = token && sessoes.get(token);
    if (!ate) return false;
    if (Date.now() > ate) { sessoes.delete(token); return false; }
    return true;
}
function sair(token) { sessoes.delete(token); }


module.exports = { entrar, valido, sair, garantirHash };
