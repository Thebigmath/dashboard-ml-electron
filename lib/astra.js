// Botao "Rodar Astra" do SEVEN: dispara a coleta de concorrentes e a ponte para o Dashboard.
//
//   Nubimetrics --(MCP)--> Astra (astra_v2.py atualizar) --> astra.db
//                                  --> ponte_dashboard.py --> astra_concorrentes.json --> lib/seven.js
//
// O Dashboard nao fala com o Nubimetrics: so roda os scripts do Astra (que respeitam os tetos e o
// bloqueio registrados por ele) e acompanha o log. Uma execucao por vez.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ESTADO = path.join(STORAGE, 'astra_estado.json');
const LOG = path.join(STORAGE, 'astra.log');
// Na Cordeiro este valor e false: ela so le o resultado (os dois apps nao rodam o Astra juntos).
const COLETOR = true;

function lerJson(arquivo, padrao) {
    try { return JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch { return padrao; }
}

function config() {
    const c = lerJson(path.join(STORAGE, 'config.json'), {});
    return {
        pasta: c.astra_pasta || 'C:/Users/Matheus Prata/Documents/business_Intelligence/seven/sala_de_maquinas',
        python: c.astra_python || 'C:/Users/Matheus Prata/AppData/Local/Programs/Python/Python314/python.exe',
        max: Number(c.astra_max_por_execucao) || 600,
        intervalo: Number(c.astra_intervalo_s) || 2,
        dias: Number(c.astra_dias) || 7,
    };
}

function vivo(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
}

function estado() {
    const e = lerJson(ESTADO, {});
    const rodando = vivo(e.pid);
    let linhas = [];
    try { linhas = fs.readFileSync(LOG, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean); } catch {}
    const passos = linhas.filter(l => /^\[\d+\/\d+\]/.test(l));
    const ultimo = passos[passos.length - 1] || '';
    const m = ultimo.match(/^\[(\d+)\/(\d+)\]/);
    const resumo = linhas.filter(l => /chamadas feitas|Respondido com|Nada a coletar|Ficam para as próximas/.test(l)).join(' · ');
    const parou = linhas.find(l => /^PAROU:|limite|bloquead/i.test(l)) || '';
    const ponte = linhas.find(l => /grupos com dado/.test(l)) || '';
    return {
        coletor: COLETOR, rodando, iniciado_em: e.iniciado_em || null,
        progresso: m ? { feitos: Number(m[1]), total: Number(m[2]) } : null,
        atual: ultimo, ultima_linha: linhas[linhas.length - 1] || '', resumo, parou, ponte,
        log: linhas.slice(-12),
        aviso: COLETOR ? '' : 'O Astra é rodado pelo app da Flavia Stock. Aqui aparecem os dados que ele coletou.',
    };
}

// Grupos com anuncio NOSSO (das duas contas): o botao universal so atualiza estes.
// O Astra so busca o que venceu, entao repetir no mesmo dia custa quase nada.
const JSON_PONTE = 'C:/Users/Matheus Prata/Documents/business_Intelligence/seven/saidas/astra_concorrentes.json';
function gruposNossos() {
    return (lerJson(JSON_PONTE, {}).grupos || []).filter(g => (g.nossos || []).length).map(g => g.group_id);
}

// grupos: lista de group_id (o botao da linha); vazio = todos os grupos com anuncio nosso.
function iniciar(grupos) {
    if (!COLETOR) return { ok: false, erro: 'O Astra é rodado pelo app da Flavia Stock.' };
    if (estado().rodando) return { ok: false, erro: 'O Astra já está rodando.' };
    const cfg = config();
    if (!fs.existsSync(path.join(cfg.pasta, 'astra_v2.py')) || !fs.existsSync(path.join(cfg.pasta, 'ponte_dashboard.py'))) {
        return { ok: false, erro: `Astra não encontrado em ${cfg.pasta}` };
    }
    fs.mkdirSync(STORAGE, { recursive: true });
    const inicio = new Date().toISOString();
    const lista = (Array.isArray(grupos) && grupos.length ? grupos : gruposNossos()).map(Number).filter(Boolean);
    const escopo = lista.length ? lista.join(',') : 'todos';
    fs.writeFileSync(LOG, `Astra iniciado em ${new Date().toLocaleString('pt-BR')} — ${lista.length ? lista.length + ' grupo(s)' : 'todos os grupos'}
`, 'utf8');
    // So os grupos de PRODUTO (os que dao PC e RANK NUB), comecando pelos de maior faturamento.
    // O "atualizar" do Astra prioriza os catalogos de vendedores, que nao servem ao SEVEN.
    // Depois (mesmo se a coleta parar no teto/bloqueio) roda a ponte para o Dashboard.
    // Tetos afrouxados via ambiente (o Astra le ASTRA_*): plano Nubimetrics permite 800/hora.
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8',
        ASTRA_INTERVALO_S: String(cfg.intervalo), ASTRA_TETO_MINUTO: '30', ASTRA_TETO_HORA: '700', ASTRA_TETO_DIA: '1500' };
    // python.exe direto (o py.exe nao repassa os handles): stdout/stderr vao para o log.
    const fd = fs.openSync(LOG, 'a');
    const proc = spawn(cfg.python, ['-X', 'utf8', '-u', 'astra_v2.py', 'perguntar', 'concorrentes', '--escopo', escopo,
        '--dias', String(cfg.dias), '--max', String(cfg.max)], { cwd: cfg.pasta, windowsHide: true, stdio: ['ignore', fd, fd], env });
    fs.closeSync(fd);
    proc.on('exit', () => {
        const fd2 = fs.openSync(LOG, 'a');
        const ponte = spawn(cfg.python, ['-X', 'utf8', '-u', 'ponte_dashboard.py', '--dias', String(cfg.dias)],
            { cwd: cfg.pasta, windowsHide: true, stdio: ['ignore', fd2, fd2], env });
        fs.closeSync(fd2);
        ponte.on('exit', () => fs.writeFileSync(ESTADO, JSON.stringify({ iniciado_em: inicio, fim: new Date().toISOString() }, null, 2)));
        fs.writeFileSync(ESTADO, JSON.stringify({ pid: ponte.pid, iniciado_em: inicio }, null, 2));
    });
    fs.writeFileSync(ESTADO, JSON.stringify({ pid: proc.pid, iniciado_em: inicio }, null, 2));
    return { ok: true, pid: proc.pid };
}

module.exports = { estado, iniciar };
