(async () => {
    // ── Info do app ──────────────────────────────────────────────────────────
    let appInfo = {};
    try { appInfo = await fetch('/api/app_info').then(r => r.json()); } catch {}

    // ── Account switcher ─────────────────────────────────────────────────────
    const switcher = document.querySelector('.account-switcher');
    if (switcher && appInfo.outro_app) {
        const outro = appInfo.outro_app;

        switcher.innerHTML = `
            <div style="flex:1;min-width:0">
                <div style="display:flex;align-items:center;gap:6px">
                    <div class="account-switcher-dot"></div>
                    <span style="font-size:12px;font-weight:600;color:var(--l1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${appInfo.nome || '—'}</span>
                </div>
                <div id="switchBtn" style="display:flex;align-items:center;gap:5px;margin-top:4px;cursor:pointer;padding:3px 6px;border-radius:6px;background:rgba(255,255,255,.06);transition:background .2s" title="Trocar para ${outro.nome}">
                    <i class="bi bi-arrow-left-right" style="font-size:11px;color:#0a84ff"></i>
                    <span style="font-size:11px;color:var(--l2)">${outro.nome}</span>
                </div>
            </div>
        `;

        document.getElementById('switchBtn').addEventListener('click', async () => {
            const btn = document.getElementById('switchBtn');
            btn.innerHTML = '<i class="bi bi-hourglass-split" style="font-size:11px;color:#0a84ff"></i><span style="font-size:11px;color:var(--l2)">Abrindo...</span>';

            try {
                const r = await fetch('/api/switch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ porta: outro.porta, exe: outro.exe }),
                });
                const d = await r.json();
                if (d.ok) window.location.href = `http://localhost:${d.porta}`;
                else throw new Error(d.erro);
            } catch (e) {
                btn.innerHTML = `<i class="bi bi-exclamation-triangle" style="font-size:11px;color:#ff453a"></i><span style="font-size:11px;color:#ff453a">Erro ao abrir</span>`;
                setTimeout(() => {
                    btn.innerHTML = `<i class="bi bi-arrow-left-right" style="font-size:11px;color:#0a84ff"></i><span style="font-size:11px;color:var(--l2)">${outro.nome}</span>`;
                }, 2500);
            }
        });

        document.getElementById('switchBtn').addEventListener('mouseenter', e => e.currentTarget.style.background = 'rgba(255,255,255,.12)');
        document.getElementById('switchBtn').addEventListener('mouseleave', e => e.currentTarget.style.background = 'rgba(255,255,255,.06)');
    }

    // ── Versão no rodapé ─────────────────────────────────────────────────────
    const footer = document.querySelector('.sidebar-footer');
    if (footer && appInfo.versao) footer.textContent = `v${appInfo.versao}`;

    // ── Notificações de update (via Electron preload) ─────────────────────────
    if (window.electronAPI) {
        window.electronAPI.onUpdateAvailable((versao) => {
            mostrarToastUpdate(`Nova versão ${versao} baixando...`, false);
        });
        window.electronAPI.onUpdateDownloaded(() => {
            mostrarToastUpdate('Atualização pronta! Clique para instalar.', true);
        });
    }

    function mostrarToastUpdate(msg, instalar) {
        let toast = document.getElementById('update-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'update-toast';
            toast.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#1c1c1e;border:1px solid var(--sep);border-radius:12px;padding:14px 18px;display:flex;align-items:center;gap:12px;z-index:9999;box-shadow:0 8px 32px rgba(0,0,0,.5);max-width:320px;';
            document.body.appendChild(toast);
        }
        toast.innerHTML = `
            <i class="bi bi-cloud-arrow-down" style="color:#0a84ff;font-size:20px;flex-shrink:0"></i>
            <div style="flex:1">
                <div style="font-size:12px;font-weight:600;color:var(--l1);margin-bottom:2px">Atualização disponível</div>
                <div style="font-size:11px;color:var(--l3)">${msg}</div>
            </div>
            ${instalar ? `<button onclick="window.electronAPI.installUpdate()" style="background:#0a84ff;color:#fff;border:none;border-radius:6px;padding:6px 12px;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap">Instalar</button>` : ''}
        `;
    }
})();
