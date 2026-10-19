// Guarda do Mercado Pago (19/10/2026): camada de seguranca em volta da API do Mercado Pago, ligada uma vez no start
// do servidor, para TODA chamada do app (axios global e fetch global), sem precisar mexer em quem chama.
//   1. SO LEITURA ......... para api.mercadopago.com so passa GET. POST/PUT/PATCH/DELETE sao barrados antes de sair
//                           do computador: nada move dinheiro, estorna, cancela ou altera a conta (nem por bug, nem
//                           por sugestao de IA).
//   2. LISTA FECHADA ...... so os caminhos que o sistema usa (pagamento por id, busca de pagamentos, /users/me e as
//                           listas de relatorios). Qualquer outro caminho do Mercado Pago e recusado.
//   3. TOKEN NAO VAZA ..... uma chamada com o token do Mercado Livre (Bearer APP_USR-...) so pode ir para os dominios
//                           do ML/Mercado Pago ou para o proprio computador; para qualquer outro site e barrada.
//   4. AUDITORIA .......... toda chamada ao Mercado Pago (e todo bloqueio) fica em STORAGE/mp_auditoria.json, ultimas
//                           1000, SEM token, sem cabecalhos e sem dados do pagador (so metodo, caminho com ids mascarados,
//                           permitido/bloqueado e o motivo).
const fs = require('fs');
const path = require('path');

const STORAGE = () => process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ARQ = () => path.join(STORAGE(), 'mp_auditoria.json');
const MAX = 1000;

const HOST_MP = /^api\.mercadopago\.com$/i;
// caminhos liberados (somente GET)
const PERMITIDOS = [
    /^\/v1\/payments\/\d+$/,                                  // pagamento de uma venda (Finance)
    /^\/v1\/payments\/search$/,                               // busca de pagamentos
    /^\/users\/me$/,                                          // perfil da conta
    /^\/v1\/account\/(release|settlement|bank)_report\/list$/, // lista dos relatorios ja gerados (leitura)
];
// dominios que podem receber o token do Mercado Livre
const DOMINIOS_TOKEN = /(^|\.)(mercadolibre\.com|mercadolivre\.com\.br|mercadopago\.com|mercadopago\.com\.br|mercadolibre\.com\.br)$/i;
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i;

let fila = [], timer = null;
const estat = { desde: new Date().toISOString(), permitidas: 0, bloqueadas: 0 };

function gravarDepois() {
    if (timer) return;
    timer = setTimeout(() => {
        timer = null;
        try {
            let L = []; try { L = JSON.parse(fs.readFileSync(ARQ(), 'utf8')); } catch {}
            L = fila.concat(L).slice(0, MAX); fila = [];
            fs.writeFileSync(ARQ(), JSON.stringify(L));
        } catch { /* auditoria nunca derruba a chamada */ }
    }, 5000);
    if (timer.unref) timer.unref();
}
const mascarar = (p) => String(p || '').replace(/\d{5,}/g, '{id}');
function registrar(e) {
    e.permitido ? estat.permitidas++ : estat.bloqueadas++;
    fila.unshift({ quando: new Date().toISOString(), ...e, caminho: mascarar(e.caminho) });
    if (fila.length > MAX) fila.length = MAX;
    gravarDepois();
    if (!e.permitido) console.warn(`[mp_guarda] BLOQUEADO ${e.metodo} ${e.host}${mascarar(e.caminho)}: ${e.motivo}`);
}

// decide se a chamada pode sair. Retorna null (pode) ou o motivo do bloqueio.
function avaliar(metodo, url, autorizacao) {
    let u; try { u = new URL(url); } catch { return null; }   // url relativa/estranha: nao e com a gente
    const host = u.hostname, m = String(metodo || 'GET').toUpperCase();
    const temTokenML = /^Bearer\s+APP_USR-/i.test(String(autorizacao || ''));
    if (temTokenML && !DOMINIOS_TOKEN.test(host) && !LOCAL.test(host)) {
        const motivo = 'token do Mercado Livre indo para um site de fora';
        registrar({ metodo: m, host, caminho: u.pathname, permitido: false, motivo });
        return motivo;
    }
    if (!HOST_MP.test(host)) return null;
    let motivo = null;
    if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS') motivo = `Mercado Pago é só leitura (${m} bloqueado)`;
    else if (!PERMITIDOS.some(r => r.test(u.pathname))) motivo = 'caminho do Mercado Pago fora da lista liberada';
    registrar({ metodo: m, host, caminho: u.pathname, permitido: !motivo, motivo });
    return motivo;
}

function erroBloqueio(motivo) { const e = new Error('Bloqueado pela guarda do Mercado Pago: ' + motivo); e.code = 'MP_GUARDA'; e.bloqueado = true; return e; }

// axios global: barra antes de enviar
function ligarAxios(axios) {
    if (axios.__mpGuarda) return;
    axios.__mpGuarda = true;
    axios.interceptors.request.use(cfg => {
        let url = cfg.url || '';
        try { if (cfg.baseURL && !/^https?:/i.test(url)) url = new URL(url, cfg.baseURL).href; } catch {}
        const h = cfg.headers || {};
        const auth = (typeof h.get === 'function' ? h.get('Authorization') : null) || h.Authorization || h.authorization || (h.common && (h.common.Authorization || h.common.authorization));
        const motivo = avaliar(cfg.method, url, auth);
        if (motivo) throw erroBloqueio(motivo);
        return cfg;
    });
}

// fetch global: mesmo filtro
function ligarFetch() {
    if (typeof globalThis.fetch !== 'function' || globalThis.fetch.__mpGuarda) return;
    const original = globalThis.fetch;
    const guardado = function (input, init) {
        try {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input && input.url) || '';
            const metodo = (init && init.method) || (input && typeof input === 'object' && input.method) || 'GET';
            let auth = null;
            const hs = (init && init.headers) || (input && typeof input === 'object' && input.headers);
            if (hs) auth = typeof hs.get === 'function' ? hs.get('Authorization') : Array.isArray(hs) ? (hs.find(([k]) => /^authorization$/i.test(k)) || [])[1] : (hs.Authorization || hs.authorization);
            const motivo = avaliar(metodo, url, auth);
            if (motivo) return Promise.reject(erroBloqueio(motivo));
        } catch { /* na duvida sobre o formato, segue como antes */ }
        return original.apply(this, arguments);
    };
    guardado.__mpGuarda = true;
    globalThis.fetch = guardado;
}

function ligar(axios) { ligarAxios(axios); ligarFetch(); }

function resumo() {
    let L = []; try { L = JSON.parse(fs.readFileSync(ARQ(), 'utf8')); } catch {}
    L = fila.concat(L).slice(0, MAX);
    return { regras: { somente_leitura: true, caminhos_liberados: PERMITIDOS.map(r => r.source), token_so_para: 'mercadolibre / mercadolivre / mercadopago e o próprio computador' },
        desde_o_inicio: estat, bloqueios: L.filter(x => !x.permitido).slice(0, 50), ultimas: L.slice(0, 50) };
}

module.exports = { ligar, ligarAxios, ligarFetch, avaliar, resumo };
