// Acesso a OUTRA conta (Flavia <-> Cordeiro) a partir deste Dashboard, para a Clonagem.
// Usa o token do outro Dashboard instalado no mesmo PC (%APPDATA%\dashboard-{ml,cordeiro}\storage), do mesmo jeito
// que o Harvey faz: le o token.json dele e, se estiver vencendo, renova com o client_id/secret do config.json dele e
// grava no mesmo arquivo (o outro app passa a usar o token novo). Se o outro Dashboard nao estiver instalado neste PC,
// a clonagem para a outra conta fica indisponivel (avisa na tela).
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const APPS = { 'dashboard-ml': { nome: 'Flavia Stock' }, 'dashboard-cordeiro': { nome: 'Cordeiro Car' } };

function pastas() {
    const esteApp = path.basename(path.dirname(STORAGE));                     // dashboard-ml | dashboard-cordeiro
    const outroApp = esteApp === 'dashboard-cordeiro' ? 'dashboard-ml' : 'dashboard-cordeiro';
    const raiz = process.env.APPDATA || path.dirname(path.dirname(STORAGE));
    return { esteApp, outroApp, dir: path.join(raiz, outroApp, 'storage') };
}
const lerJson = (arq) => JSON.parse(fs.readFileSync(arq, 'utf8'));

function info() {
    const { esteApp, outroApp, dir } = pastas();
    const ok = fs.existsSync(path.join(dir, 'token.json')) && fs.existsSync(path.join(dir, 'config.json'));
    return { esta_conta: (APPS[esteApp] || {}).nome || esteApp, outra_conta: (APPS[outroApp] || {}).nome || outroApp, disponivel: ok,
        motivo: ok ? '' : `O Dashboard da ${(APPS[outroApp] || {}).nome || outroApp} não está instalado e autorizado neste PC.` };
}

let renovando = null;
async function token() {
    const { dir } = pastas();
    const arq = path.join(dir, 'token.json');
    const t = lerJson(arq);
    if ((t.created_at + t.expires_in) - Date.now() / 1000 > 600) return t;
    if (renovando) return renovando;
    renovando = (async () => {
        const cfg = lerJson(path.join(dir, 'config.json'));
        const { data } = await axios.post('https://api.mercadolibre.com/oauth/token', new URLSearchParams({
            grant_type: 'refresh_token', client_id: cfg.client_id, client_secret: cfg.client_secret, refresh_token: t.refresh_token,
        }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 });
        data.created_at = Math.floor(Date.now() / 1000);
        data.user_id = data.user_id || t.user_id;
        fs.writeFileSync(arq, JSON.stringify(data, null, 4), 'utf8');
        return data;
    })().finally(() => { renovando = null; });
    return renovando;
}
async function cabecalhos() { const t = await token(); return { headers: { Authorization: `Bearer ${t.access_token}` }, userId: t.user_id }; }

module.exports = { info, cabecalhos };
