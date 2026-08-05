const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

let mainWindow;

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

const server = require('./server');

// Auto-updater
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
autoUpdater.on('update-downloaded', () => {
    updateReady = true;
    mainWindow?.webContents.send('update-downloaded');
});

ipcMain.on('install-update', () => {
    autoUpdater.quitAndInstall();
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
            mainWindow.show();
            setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5000);
        });
        mainWindow.webContents.on('did-finish-load', () => {
            if (updateReady) mainWindow.webContents.send('update-downloaded');
        });
    });
});

app.on('window-all-closed', () => {
    server.stop();
    app.quit();
});
