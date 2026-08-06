const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    onUpdateAvailable:  (cb) => ipcRenderer.on('update-available',  (_, v) => cb(v)),
    onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded', ()    => cb()),
    onUpdateStatus:     (cb) => ipcRenderer.on('update-status',     (_, m) => cb(m)),
    installUpdate:      ()   => ipcRenderer.send('install-update'),
    openExternal:       (url) => ipcRenderer.send('open-external', url),
});
