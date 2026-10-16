const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Tray, Menu, nativeImage, screen } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

let mainWindow;
let tray = null;
let encerrando = false;

// Só uma instância: o atalho do Start Menu, com o app já na bandeja, apenas
// traz a janela de volta em vez de abrir um segundo servidor na porta 3001.
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => mostrarJanela());
}

// Iniciado pelo Windows (login): fica só na bandeja, sem abrir a janela.
const SEGUNDO_PLANO = process.argv.includes('--segundo-plano');

function mostrarJanela() {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
}

const userDataPath = app.getPath('userData');
const storagePath = path.join(userDataPath, 'storage');
if (!fs.existsSync(storagePath)) fs.mkdirSync(storagePath, { recursive: true });

const appStorage = path.join(__dirname, 'storage');
for (const file of ['config.json', 'usuarios.json', 'custos.json', 'envios_full.json']) {
    const dest = path.join(storagePath, file);
    const src  = path.join(appStorage, file);
    if (!fs.existsSync(src)) continue;
    if (!fs.existsSync(dest)) {
        fs.copyFileSync(src, dest);
    } else if (file === 'envios_full.json') {
        try {
            const existing = JSON.parse(fs.readFileSync(dest, 'utf8'));
            const defaults = JSON.parse(fs.readFileSync(src,  'utf8'));
            const numeros  = new Set(existing.map(e => e.numero));
            const skusExistentes = new Set(existing.flatMap(e => Object.keys(e.skus || {})));
            const novas = defaults.filter(e =>
                !numeros.has(e.numero) &&
                !Object.keys(e.skus || {}).some(sku => skusExistentes.has(sku))
            );
            if (novas.length > 0) {
                fs.writeFileSync(dest, JSON.stringify([...existing, ...novas], null, 2), 'utf8');
            }
        } catch {}
    } else if (file === 'config.json') {
        try {
            const existing = JSON.parse(fs.readFileSync(dest, 'utf8'));
            const defaults = JSON.parse(fs.readFileSync(src,  'utf8'));
            const merged   = { ...defaults, ...existing };
            // outro_app é aninhado: o spread raso preservaria o objeto antigo inteiro
            // e chaves novas (ex: exe_nome) nunca chegariam em quem já tem o app.
            if (defaults.outro_app || existing.outro_app) {
                merged.outro_app = { ...(defaults.outro_app || {}), ...(existing.outro_app || {}) };
            }
            fs.writeFileSync(dest, JSON.stringify(merged, null, 4), 'utf8');
        } catch {}
    }
}

process.env.STORAGE_PATH = storagePath;

// Sem AppUserModelId o Windows descarta a notificação (toast) do app. O
// instalador registra o mesmo id no atalho; aqui vale também no npm start.
app.setAppUserModelId('com.thebigmath.dashboard-ml');

const server = require('./server');

// Avisos do monitor de frete viram notificação nativa do Windows; clicar
// traz o app pra frente já na tela de frete.
require('./lib/notificar').usarNotificador((titulo, corpo, rota, opcoes = {}) => {
    // Aviso urgente (reputação em risco): beep do sistema 3x, além do toast.
    if (opcoes.beep) { let i = 0; const id = setInterval(() => { shell.beep(); if (++i >= 3) clearInterval(id); }, 450); }
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: titulo, body: corpo, urgency: opcoes.urgente ? 'critical' : 'normal', timeoutType: opcoes.urgente ? 'never' : 'default' });
    n.on('click', () => {
        if (!mainWindow) return;
        mostrarJanela();
        if (rota) mainWindow.loadURL('http://localhost:3001' + rota);
    });
    n.show();
});

// Auto-updater
// ---- painel lateral: estoque em ATENCAO (igual ao do Harvey) ----
// Quando um produto do Full entra em Atencao (cobertura de 15 a 30 dias), abre no canto direito da tela sem roubar
// o foco. O X esconde; volta quando outro produto entrar em Atencao ou pela bandeja.
let alerta = null;
function criarAlerta() {
    const area = screen.getPrimaryDisplay().workArea;
    const largura = 360, altura = Math.min(620, Math.round(area.height * 0.7));
    alerta = new BrowserWindow({
        width: largura, height: altura, x: area.x + area.width - largura - 12, y: area.y + area.height - altura - 12,
        frame: false, resizable: true, minimizable: false, maximizable: false, alwaysOnTop: true, skipTaskbar: true, show: false,
        title: 'Estoque em atenção', backgroundColor: '#111318',
        webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
    });
    alerta.loadURL('http://localhost:3001/alerta_estoque.html');
    alerta.on('close', (e) => { if (!encerrando) { e.preventDefault(); alerta.hide(); } });
}
function mostrarAlerta() {
    if (!alerta || alerta.isDestroyed()) criarAlerta();
    else alerta.webContents.send('recarregar');
    alerta.showInactive();
}
function verificarAlerta() {
    try { if (require('./lib/alerta_estoque').verificar().abrir) mostrarAlerta(); } catch {}
}
ipcMain.on('fechar-alerta', () => alerta?.hide());
ipcMain.on('abrir-produto', (_, chave) => {
    if (!mainWindow) return;
    mostrarJanela();
    mainWindow.loadURL('http://localhost:3001/painel?chave=' + encodeURIComponent(String(chave || '')));
});

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.logger = require('electron').app && (() => {
    const log = { info: console.log, warn: console.warn, error: console.error, debug: console.log };
    return log;
})();

autoUpdater.on('checking-for-update', () => {
    mainWindow?.webContents.send('update-status', 'Verificando atualizações...');
});
autoUpdater.on('update-available', (info) => {
    mainWindow?.webContents.send('update-available', info.version);
    mainWindow?.webContents.send('update-status', `Update encontrado: v${info.version}`);
});
autoUpdater.on('update-not-available', () => {
    mainWindow?.webContents.send('update-status', 'App já está atualizado.');
});
autoUpdater.on('error', (err) => {
    mainWindow?.webContents.send('update-status', `Erro update: ${err.message}`);
});
let updateReady = false;
let versaoBaixada = '';
autoUpdater.on('update-downloaded', (info) => {
    updateReady = true;
    versaoBaixada = (info && info.version) || '';
    mainWindow?.webContents.send('update-downloaded');
    // Com o app na bandeja a janela pode estar escondida: o aviso da barra
    // lateral ninguem ve. A notificacao do Windows chega de qualquer jeito.
    if (Notification.isSupported()) {
        const n = new Notification({ title: `Flavia Stock: atualização ${versaoBaixada} pronta`, body: 'Clique para instalar agora (o app reinicia).' });
        n.on('click', () => { encerrando = true; autoUpdater.quitAndInstall(); });
        n.show();
    }
});

// O processo vive na bandeja e nao reinicia: sem isto, a verificacao so
// rodava uma vez, na abertura, e nunca mais.
let ultimaVerificacaoUpdate = 0;
function verificarUpdate(minIntervaloMs = 0) {
    if (Date.now() - ultimaVerificacaoUpdate < minIntervaloMs) return;
    ultimaVerificacaoUpdate = Date.now();
    autoUpdater.checkForUpdates().catch(() => {});
}
setInterval(() => verificarUpdate(), 30 * 60 * 1000);

ipcMain.on('install-update', () => {
    encerrando = true; // senao o 'close' da janela so esconde e a instalacao nao acontece
    autoUpdater.quitAndInstall();
});

ipcMain.on('open-external', (_, url) => {
    // so endereco https (antes abria qualquer coisa: file:, programas, etc.)
    if (/^https:\/\//i.test(String(url || ''))) shell.openExternal(url);
});

app.whenReady().then(() => {
    server.start(3001, () => {
        mainWindow = new BrowserWindow({
            width: 1400,
            height: 900,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, 'preload.js'),
            },
            title: 'Dashboard ML — Flavia Stock',
            show: false,
        });

        const tokenPath = path.join(storagePath, 'token.json');
        const temToken  = fs.existsSync(tokenPath);
        const startUrl  = temToken ? 'http://localhost:3001' : 'http://localhost:3001/auth/gerar_token';

        mainWindow.loadURL(startUrl);
        mainWindow.once('ready-to-show', () => {
            if (!SEGUNDO_PLANO) mainWindow.show();
            setTimeout(() => verificarUpdate(), 5000);
        });
        mainWindow.on('show', () => verificarUpdate(5 * 60 * 1000));

        // O X esconde: o servidor e o monitor de frete continuam na bandeja.
        // Sair de verdade só pelo menu da bandeja (ou ao instalar atualização).
        let avisouBandeja = false;
        mainWindow.on('close', (e) => {
            if (encerrando) return;
            e.preventDefault();
            mainWindow.hide();
            if (!avisouBandeja && tray) {
                avisouBandeja = true;
                tray.displayBalloon({ title: 'Flavia Stock continua rodando', content: 'O SEVEN segue rodando aqui na bandeja (vigias da Agenda do Full, avisos). Clique duas vezes no ícone para abrir.', iconType: 'info' });
            }
        });

        criarBandeja();
        // estoque em atencao: olha a lista de reposicao 1 min depois de abrir e a cada 2 min
        setTimeout(verificarAlerta, 60 * 1000);
        setInterval(verificarAlerta, 2 * 60 * 1000);
        // Registra o app para abrir junto com o Windows, escondido. Só no
        // instalado: no npm start isso registraria o electron de desenvolvimento.
        if (app.isPackaged) {
            app.setLoginItemSettings({ openAtLogin: true, args: ['--segundo-plano'] });
        }
        mainWindow.webContents.on('did-finish-load', () => {
            if (updateReady) mainWindow.webContents.send('update-downloaded');
        });
    });
});

function criarBandeja() {
    const icone = nativeImage.createFromPath(path.join(__dirname, 'public/assets/img/tray.png'));
    tray = new Tray(icone);
    tray.setToolTip('Flavia Stock — rodando na bandeja');
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Abrir Flavia Stock', click: () => mostrarJanela() },
        { label: 'Mostrar estoque em atenção', click: () => mostrarAlerta() },
        { type: 'separator' },
        { label: 'Verificar atualização', click: () => { verificarUpdate(); mostrarJanela(); } },
        { label: 'Sair', click: () => { encerrando = true; server.stop(); app.quit(); } },
    ]));
    tray.on('double-click', () => mostrarJanela());
}

// A janela escondida não conta como "fechada": o app só sai pelo menu da bandeja.
app.on('window-all-closed', () => {
    if (encerrando) { server.stop(); app.quit(); }
});
app.on('before-quit', () => { encerrando = true; });
