const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    onUpdateAvailable:  (cb) => ipcRenderer.on('update-available',  (_, v) => cb(v)),
    onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded', ()    => cb()),
    installUpdate:      ()   => ipcRenderer.send('install-update'),
});
