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
                    body: JSON.stringify({ porta: outro.porta, exe: outro.exe, nome: outro.nome, exe_nome: outro.exe_nome }),
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
        window.electronAPI.onUpdateStatus((msg) => {
            console.log('[updater]', msg);
            let el = document.getElementById('update-status-debug');
            if (!el) {
                el = document.createElement('div');
                el.id = 'update-status-debug';
                el.style.cssText = 'position:fixed;bottom:8px;left:8px;background:rgba(0,0,0,.75);color:#0a84ff;font-size:10px;padding:4px 8px;border-radius:6px;z-index:9999;max-width:300px;';
                document.body.appendChild(el);
            }
            el.textContent = msg;
            setTimeout(() => el?.remove(), 8000);
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

/* ── Tema claro / escuro ────────────────────────────────────────────────── */
(function() {
    const tema = localStorage.getItem('tema') || 'light';
    aplicarTema(tema);

    function aplicarTema(t) {
        const root = document.documentElement;
        // Congela transições durante a troca: evita dezenas de cross-fades ao mesmo
        // tempo e força o Chromium a recalcular var() em box-shadow (que ele mantém
        // com o valor antigo quando a propriedade está em transition).
        root.classList.add('sem-transicao');
        root.setAttribute('data-theme', t);
        void root.offsetHeight;
        requestAnimationFrame(() => root.classList.remove('sem-transicao'));

        const icone = document.getElementById('iconeTema');
        if (icone) icone.className = t === 'dark' ? 'bi bi-sun-fill' : 'bi bi-moon-stars-fill';
    }

    window.toggleTema = function() {
        const atual = document.documentElement.getAttribute('data-theme') || 'light';
        const novo  = atual === 'dark' ? 'light' : 'dark';
        localStorage.setItem('tema', novo);
        aplicarTema(novo);
    };
})();

/* ── Tema de fundo (aurora) ─────────────────────────────────────────────── */
(function() {
    const FUNDOS = [
        { id: 'padrao',  nome: 'Padrão',  cor: 'var(--accent)' },  // segue a cor da marca do app
        { id: 'oceano',  nome: 'Oceano',  cor: '#5AC8FA' },
        { id: 'menta',   nome: 'Menta',   cor: '#34C759' },
        { id: 'poente',  nome: 'Poente',  cor: '#FF9500' },
        { id: 'grafite', nome: 'Grafite', cor: '#8E8E93' },
    ];

    // Aplica antes de montar a UI para não piscar o fundo anterior.
    const salvo = localStorage.getItem('fundo') || 'padrao';
    aplicarFundo(salvo);

    function aplicarFundo(id) {
        const root = document.documentElement;
        if (id === 'padrao') root.removeAttribute('data-bg');
        else root.setAttribute('data-bg', id);
        document.querySelectorAll('.bg-dot').forEach(b => {
            b.classList.toggle('ativo', b.dataset.fundo === id);
            b.setAttribute('aria-pressed', String(b.dataset.fundo === id));
        });
    }

    const sidebar = document.querySelector('.sidebar');
    const footer  = sidebar && sidebar.querySelector('.sidebar-footer');
    if (!sidebar || !footer) return;

    const bloco = document.createElement('div');
    bloco.className = 'bg-picker';
    bloco.innerHTML =
        '<div class="bg-picker-label">Fundo</div><div class="bg-dots">' +
        FUNDOS.map(f =>
            `<button type="button" class="bg-dot" data-fundo="${f.id}" title="${f.nome}" aria-label="Fundo ${f.nome}" style="background:${f.cor}"></button>`
        ).join('') +
        '</div>';

    sidebar.insertBefore(bloco, footer);

    bloco.addEventListener('click', e => {
        const btn = e.target.closest('.bg-dot');
        if (!btn) return;
        localStorage.setItem('fundo', btn.dataset.fundo);
        aplicarFundo(btn.dataset.fundo);
    });

    aplicarFundo(salvo);   // marca o selecionado agora que os botões existem
})();
