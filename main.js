const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

let mainWindow;

const userDataPath = app.getPath('userData');
const storagePath = path.join(userDataPath, 'storage');
if (!fs.existsSync(storagePath)) fs.mkdirSync(storagePath, { recursive: true });

const appStorage = path.join(__dirname, 'storage');
for (const file of ['config.json', 'usuarios.json']) {
    const dest = path.join(storagePath, file);
    const src  = path.join(appStorage, file);
    if (!fs.existsSync(src)) continue;
    if (!fs.existsSync(dest)) {
        fs.copyFileSync(src, dest);
    } else if (file === 'config.json') {
        try {
            const existing = JSON.parse(fs.readFileSync(dest, 'utf8'));
            const defaults = JSON.parse(fs.readFileSync(src,  'utf8'));
            const merged   = { ...defaults, ...existing };
            fs.writeFileSync(dest, JSON.stringify(merged, null, 4), 'utf8');
        } catch {}
    }
}

process.env.STORAGE_PATH = storagePath;

const server = require('./server');

// Auto-updater
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('update-available', (info) => {
    mainWindow?.webContents.send('update-available', info.version);
});

autoUpdater.on('update-downloaded', () => {
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
    });
});

app.on('window-all-closed', () => {
    server.stop();
    app.quit();
});
