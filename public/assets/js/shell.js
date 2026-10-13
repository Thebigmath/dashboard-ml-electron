/* ── Menu do SEVEN (13/10/2026) ────────────────────────────────────────────
   No molde do Olist: uma barra estreita à esquerda com os apps (STOCK Ops,
   AD HEALTH, Finance) e, ao clicar num app, uma segunda aba com os submenus
   dele. "Fixar menu" deixa a segunda aba sempre aberta. O 7 leva ao Início.
   Embaixo: Novidades do app, Atualizações globais e a conta (trocar de conta,
   tema, fundo, token, área do desenvolvedor).
   Substitui o menu lateral antigo (.sidebar) em todas as telas, sem mexer nelas. */
(function () {
    if (window.top !== window || new URLSearchParams(location.search).get('embed') === '1') return;   // dentro do iframe do Seven
    const root = document.documentElement;
    root.classList.add('sh');
    let fixo = true;
    try { fixo = localStorage.getItem('menuFixo') !== '0'; } catch {}
    root.classList.toggle('sh-fixo', fixo);

    const LOGO7 = `<svg viewBox="0 0 200 200" aria-hidden="true"><circle cx="100" cy="100" r="88" fill="none" stroke="currentColor" stroke-width="9"/>
        <circle cx="100" cy="100" r="74" fill="none" stroke="currentColor" stroke-width="4"/>
        <path d="M66 58 H146 L100 152 H84 L124 74 H56 Z" fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round"/></svg>`;

    const APPS = {
        stock: { nome: 'STOCK Ops', curto: 'Stock', sub: 'Estoque e reposição do Full', icone: 'bi-boxes', itens: [
            ['/painel', 'bi-layout-sidebar', 'Painel de Controle'],
            // acoes do Painel (os botoes do menu antigo): na tela do Painel clicam o botao dele; fora dela, abrem o Painel e clicam
            ['acao:btnAtualizarML', 'bi-arrow-clockwise', 'Atualizar Estoque'], ['acao:btnGerarPlanilhaFull', 'bi-arrow-down-circle', 'Planilha Full'], ['acao:btnEnviarFull', 'bi-cloud-arrow-up', 'Enviar para Full'],
            ['/feed', 'bi-lightning-charge', 'Feed'], ['/envio_full', 'bi-box-seam', 'Envio Full'],
            ['/valor_estoque', 'bi-pie-chart', 'Valor do Estoque'], ['/frete', 'bi-truck', 'Frete'], ['/parados', 'bi-pause-circle', 'Parados']] },
        ad: { nome: 'AD HEALTH', curto: 'AD Health', sub: 'Saúde dos anúncios', icone: 'bi-heart-pulse', itens: [
            ['/seven#noticias', 'bi-lightning-charge', 'Notícias urgentes'], ['/seven#rankeamento', 'bi-graph-up-arrow', 'Rankeamento'], ['/seven#defesa', 'bi-shield-check', 'Defesa'],
            ['/seven#concorrentes', 'bi-people', 'Análise de concorrentes'], ['/seven#vendas', 'bi-bar-chart-line', 'Análise por tempo de vendas'],
            ['/seven#ia', 'bi-stars', 'Análise com IA'], ['/seven#parados', 'bi-hourglass-split', 'Controle de estoque parado'], ['/seven#clonagem', 'bi-copy', 'Clonagem de anúncios']] },
        fin: { nome: 'Finance', curto: 'Finance', sub: 'O financeiro da conta', icone: 'bi-cash-coin', itens: [
            ['/finance#resumo', 'bi-clipboard-data', 'Resultado do mês (DRE)'], ['/finance#conciliacao', 'bi-arrow-left-right', 'Conciliação'],
            ['/finance#produtos', 'bi-box', 'Margem por produto'], ['/finance#custos', 'bi-wallet2', 'Custos operacionais'],
            ['/finance#notas', 'bi-file-earmark-pdf', 'Notas de fornecedores']] },
    };
    const caminho = location.pathname.replace(/\/$/, '') || '/';
    const appDaPagina = caminho === '/finance' ? 'fin' : caminho === '/seven' ? 'ad' : ['/painel', '/feed', '/envio_full', '/valor_estoque', '/frete', '/parados', '/stock-ops'].includes(caminho) ? 'stock' : null;
    let aberto = appDaPagina;   // app mostrado na segunda aba
    let info = {};

    function montar() {
        if (document.getElementById('shRail')) return;
        const antigo = document.querySelector('.sidebar');
        const pai = (antigo && antigo.parentElement) || document.querySelector('.d-flex') || document.body;
        const rail = document.createElement('nav');
        rail.id = 'shRail';
        rail.innerHTML = `<a class="sh-7" href="/" title="Início">${LOGO7}</a>
            <div class="sh-apps">${Object.entries(APPS).map(([k, a]) => `<button class="sh-app" data-app="${k}" title="${a.nome}"><i class="bi ${a.icone}"></i><span>${a.curto}</span></button>`).join('')}</div>
            <div class="sh-base">
                <a class="sh-ic" href="/novidades" title="Novidades do app"><i class="bi bi-megaphone"></i><b class="sh-badge" id="shNov"></b></a>
                <a class="sh-ic" href="/avisos" title="Atualizações globais"><i class="bi bi-broadcast"></i><b class="sh-badge" id="shAv"></b></a>
                <button class="sh-conta" data-app="conta" title="Conta e preferências" id="shConta">··</button>
            </div>`;
        const painel = document.createElement('aside');
        painel.id = 'shPainel';
        pai.insertBefore(painel, pai.firstChild);
        pai.insertBefore(rail, pai.firstChild);

        rail.addEventListener('click', (e) => {
            const b = e.target.closest('[data-app]');
            if (!b) return;
            const k = b.dataset.app;
            if (!root.classList.contains('sh-fixo') && aberto === k && painel.classList.contains('aberto')) { fechar(); return; }
            aberto = k; desenhar(); painel.classList.add('aberto');
        });
        document.addEventListener('click', (e) => {
            if (root.classList.contains('sh-fixo') && aberto !== 'conta') return;
            if (!e.target.closest('#shPainel, #shRail')) fechar();
        });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && painel.classList.contains('aberto') && !root.classList.contains('sh-fixo')) fechar(); });
        desenhar();
        carregarInfo();
    }
    function fechar() {
        const p = document.getElementById('shPainel');
        if (aberto === 'conta' || !root.classList.contains('sh-fixo')) { aberto = root.classList.contains('sh-fixo') ? appDaPagina : null; }
        if (!root.classList.contains('sh-fixo')) p.classList.remove('aberto');
        desenhar();
    }
    const ativo = (href) => {
        if (href.startsWith('acao:')) return false;
        const [p, h] = href.split('#');
        if (p !== caminho && !(p === '/painel' && caminho === '/stock-ops')) return false;
        if (!h) return true;
        const atual = (location.hash || (caminho === '/finance' ? '#resumo' : '#noticias')).slice(1);
        const mapa = { regras: 'rankeamento', vendasmc: 'rankeamento', ads: 'defesa', promocoes: 'defesa' };
        return (mapa[atual] || atual) === h;
    };

    function desenhar() {
        const p = document.getElementById('shPainel');
        document.querySelectorAll('#shRail [data-app]').forEach(b => b.classList.toggle('on', b.dataset.app === aberto || (b.dataset.app === appDaPagina && !aberto)));
        p.classList.toggle('tem', !!aberto);
        if (!aberto) { p.innerHTML = ''; return; }
        const rodape = `<div class="sh-pe"><label class="sh-fixar"><span>Fixar menu</span><input type="checkbox" id="shFixar" ${root.classList.contains('sh-fixo') ? 'checked' : ''}><i></i></label></div>`;
        if (aberto === 'conta') {
            const outro = info.outro_app;
            p.innerHTML = `<div class="sh-cab"><h2>${info.nome || 'Conta'}</h2><small>v${info.versao || ''}</small></div>
                <ul class="sh-menu">
                    ${outro ? `<li id="shTrocar"><i class="bi bi-arrow-left-right"></i><span>Trocar para ${outro.nome}</span></li>` : ''}
                    <li onclick="window.toggleTema && window.toggleTema()"><i class="bi bi-circle-half"></i><span>Tema claro / escuro</span></li>
                    <li onclick="location.href='/auth/gerar_token'"><i class="bi bi-key"></i><span>Renovar acesso ao Mercado Livre</span></li>
                    <li onclick="location.href='/dev'"><i class="bi bi-code-slash"></i><span>Área do desenvolvedor</span></li>
                </ul><div id="shFundo"></div>${rodape}`;
            const bg = document.querySelector('.bg-picker'); if (bg) p.querySelector('#shFundo').appendChild(bg);
            const t = p.querySelector('#shTrocar');
            if (t) t.onclick = async () => {
                t.querySelector('span').textContent = 'Abrindo…';
                try {
                    const d = await fetch('/api/switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ porta: outro.porta, exe: outro.exe, nome: outro.nome, exe_nome: outro.exe_nome }) }).then(r => r.json());
                    if (d.ok) location.href = `http://localhost:${d.porta}`; else throw new Error(d.erro);
                } catch (e) { t.querySelector('span').textContent = 'Não abriu: ' + e.message; }
            };
        } else {
            const a = APPS[aberto];
            p.innerHTML = `<div class="sh-cab"><h2>${a.nome}</h2><small>${a.sub}</small></div>
                ${a.itens.length ? `<ul class="sh-menu">${a.itens.map(([href, ic, nome]) => `<li class="${ativo(href) ? 'on' : ''}" data-href="${href}"><i class="bi ${ic}"></i><span>${nome}</span></li>`).join('')}</ul>`
                    : `<div class="sh-vazio">${a.vazio || ''}</div>`}${rodape}`;
            p.querySelectorAll('.sh-menu li[data-href]').forEach(li => li.onclick = () => {
                const href = li.dataset.href;
                if (href.startsWith('acao:')) { executarAcao(href.slice(5), li); return; }
                const [pp, h] = href.split('#');
                if (pp === caminho && h) { location.hash = h; setTimeout(desenhar, 50); if (!root.classList.contains('sh-fixo')) fechar(); }
                else location.href = href;
            });
        }
        p.querySelector('#shFixar').onchange = (e) => {
            root.classList.toggle('sh-fixo', e.target.checked);
            try { localStorage.setItem('menuFixo', e.target.checked ? '1' : '0'); } catch {}
            if (e.target.checked) { if (aberto === 'conta' || !aberto) aberto = appDaPagina; p.classList.remove('aberto'); }
            desenhar();
        };
    }
    // Executa um botao do Painel (Atualizar Estoque, Planilha Full, Enviar para Full) e espelha o andamento no menu
    function executarAcao(id, li) {
        const alvo = document.getElementById(id);
        if (!alvo) { location.href = '/painel?acao=' + encodeURIComponent(id); return; }
        alvo.click();
        if (!li) return;
        const espelhar = () => { const sp = alvo.querySelector('span'), ic = alvo.querySelector('i'); if (sp) li.querySelector('span').textContent = sp.textContent; if (ic) li.querySelector('i').className = ic.className; };
        espelhar();
        const t = setInterval(() => { if (!document.body.contains(li)) return clearInterval(t); espelhar(); }, 400);
        setTimeout(() => clearInterval(t), 15 * 60 * 1000);
    }
    // chegou de outra tela pedindo uma acao do Painel: espera a tela montar e clica
    (function () {
        const acao = new URLSearchParams(location.search).get('acao');
        if (!acao) return;
        history.replaceState(null, '', location.pathname + location.hash);
        const tentar = (n) => { const el = document.getElementById(acao); if (el && document.readyState === 'complete') setTimeout(() => executarAcao(acao, document.querySelector(`#shPainel li[data-href="acao:${acao}"]`)), 600); else if (n < 40) setTimeout(() => tentar(n + 1), 250); };
        tentar(0);
    })();
    window.addEventListener('hashchange', () => { if (document.getElementById('shPainel')) desenhar(); });
    window.addEventListener('sh-redesenhar', () => { if (document.getElementById('shPainel')) desenhar(); });

    async function carregarInfo() {
        try { info = await fetch('/api/app_info').then(r => r.json()); } catch {}
        const ini = String(info.nome || '··').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
        const c = document.getElementById('shConta'); if (c) { c.textContent = ini; c.title = `${info.nome || 'Conta'} · trocar de conta, tema e preferências`; }
        const badge = (id, n) => { const b = document.getElementById(id); if (b) { b.textContent = n || ''; b.style.display = n ? '' : 'none'; } };
        try { badge('shNov', (await fetch('/api/novidades').then(r => r.json())).nao_vistas); } catch {}
        try { badge('shAv', (await fetch('/api/avisos').then(r => r.json())).nao_vistos); } catch {}
        document.addEventListener('novidades-vistas', () => badge('shNov', 0));
        document.addEventListener('avisos-vistos', () => badge('shAv', 0));
        if (aberto === 'conta') desenhar();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', montar); else montar();
})();
