const NOMES = { 3001: 'Dashboard Flavia', 3002: 'Dashboard Cordeiro', 3911: 'Laboratório (Flavia)', 3913: 'Laboratório (Cordeiro)' };
chrome.runtime.sendMessage('estado', (e) => {
    const c = document.getElementById('conta');
    if (!e) { c.textContent = 'Sem resposta da extensão.'; return; }
    document.querySelector('h1').insertAdjacentHTML('beforeend', e.conta ? ` <small style="color:#3fe3ff">(${e.conta})</small>` : '');
    c.innerHTML = e.seller ? `<span class="ok">Mercado Livre conectado</span> · conta ${e.seller}` : '<span class="nao">Este Chrome não está logado no Central de Vendedores.</span>';
    const L = Object.entries(e.portas || {}).filter(([, p]) => p.ativo || p.motivo);
    document.getElementById('portas').innerHTML = L.length ? L.map(([porta, p]) => `<li>${NOMES[porta] || porta}: ${p.ativo ? '<span class="ok">ligado</span>' : `<span class="nao">${p.motivo || 'desligado'}</span>`}</li>`).join('') : '<li class="s">Nenhum Dashboard SEVEN aberto agora.</li>';
});
