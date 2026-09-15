// Canal único de notificação do app. Quem mostra de verdade é o main.js do
// Electron (toast nativo do Windows); rodando só o servidor, cai no console.
let mostrar = (titulo, corpo) => console.log('[NOTIF] ' + titulo + ' — ' + String(corpo).replace(/\n/g, ' | '));

function notificar(titulo, corpo, rota) { mostrar(titulo, corpo, rota); }
function usarNotificador(fn) { mostrar = fn; }

module.exports = { notificar, usarNotificador };
