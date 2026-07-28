document.addEventListener('DOMContentLoaded', () => {

/* ── Elementos ──────────────────────────────────────────────────────────── */
const slider      = document.getElementById('sliderReposicao');
const diasAlvo    = document.getElementById('diasAlvo');
const diasColeta  = document.getElementById('diasColeta');
const estrategia  = document.getElementById('tipoEstratagia');
const tabela      = document.getElementById('tabelaReposicao');
const pesquisa    = document.getElementById('pesquisaProduto');
const btnAtualizar      = document.getElementById('btnAtualizarML');
const btnRecalcular     = document.getElementById('btnRecalcular');
const btnGerarPlanilha  = document.getElementById('btnGerarPlanilhaFull');
const btnEnviarFull     = document.getElementById('btnEnviarFull');

/* ── Estado ─────────────────────────────────────────────────────────────── */
const POR_PAGINA = 100;
let paginaAtual       = 1;
let produtosFiltrados = [];
let textoPesquisa     = '';
window.produtosReposicao = [];
window.qtdsFull   = {};
window.transitoMap = {};
window.custosMap   = {};

const KEYWORDS_EMPILHADEIRA = ['empilhadeira','hyster','yale','bobcat','forklift','trator'];
let filtroCategoria = 'todos';

function isEmpilhadeira(p) {
    const t = (p.titulo || '').toLowerCase();
    const s = (p.sku    || '').toLowerCase();
    return KEYWORDS_EMPILHADEIRA.some(k => t.includes(k)) || s.startsWith('bf');
}

window.setFiltroCategoria = function(cat) {
    filtroCategoria = cat;
    document.querySelectorAll('.cat-filter-btn').forEach(b => {
        b.classList.toggle('cat-filter-ativo', b.dataset.cat === cat);
    });
    aplicarFiltros();
};

const MARCAS_CONHECIDAS = ['Retrovex','Fitam','Toyota','Crown','Linde','Still','BYD','Fiat','Chevrolet','Jeep','Renault','Volkswagen','Ford','Honda','Nissan','Mitsubishi','Caterpillar','Hyster','Yale'];

function detectarMarca(titulo) {
    const t = (titulo || '').toLowerCase();
    for (const m of MARCAS_CONHECIDAS) {
        if (t.includes(m.toLowerCase())) return m;
    }
    return null;
}

function construirListaMarcas() {
    const presentes = new Set();
    window.produtosReposicao.forEach(p => {
        const m = detectarMarca(p.titulo);
        if (m) presentes.add(m);
    });
    const el = document.getElementById('f-marcas');
    if (!el) return;
    el.innerHTML = [...presentes].sort().map(m => `
        <label class="marca-item">
            <input type="checkbox" value="${m}" checked onchange="aplicarFiltros()">
            <span>${m}</span>
        </label>`).join('');
}

function getFiltrosMarcas() {
    const checks = document.querySelectorAll('#f-marcas input[type=checkbox]');
    if (!checks.length) return null;
    if ([...checks].every(c => c.checked)) return null;
    return new Set([...checks].filter(c => c.checked).map(c => c.value));
}

function contarFiltrosAtivos() {
    let n = 0;
    ['f-ruptura','f-reposicao','f-semvenda','f-ajuste','f-comtransito','f-semtransito','f-comestoque'].forEach(id => {
        if (document.getElementById(id)?.checked) n++;
    });
    if ((parseInt(document.getElementById('f-periodo')?.value) || 30) !== 30) n++;
    const statusOpts = [...(document.getElementById('f-status')?.options || [])];
    if (statusOpts.some(o => !o.selected)) n++;
    if (getFiltrosMarcas()) n++;
    return n;
}

function atualizarBadgeFiltros() {
    const n = contarFiltrosAtivos();
    const badge = document.getElementById('badgeFiltros');
    if (!badge) return;
    badge.style.display = n > 0 ? 'inline' : 'none';
    badge.textContent = n;
}

function aplicarFiltros() {
    const periodo      = parseInt(document.getElementById('f-periodo')?.value) || 30;
    const fRuptura     = document.getElementById('f-ruptura')?.checked;
    const fReposicao   = document.getElementById('f-reposicao')?.checked;
    const fSemVenda    = document.getElementById('f-semvenda')?.checked;
    const fAjuste      = document.getElementById('f-ajuste')?.checked;
    const fComTransito = document.getElementById('f-comtransito')?.checked;
    const fSemTransito = document.getElementById('f-semtransito')?.checked;
    const fComEstoque  = document.getElementById('f-comestoque')?.checked;
    const statusSel    = new Set([...(document.getElementById('f-status')?.selectedOptions || [])].map(o => o.value));
    const marcasSel    = getFiltrosMarcas();

    let lista = window.produtosReposicao.map(p => {
        if (periodo !== 30) {
            const mediaDia  = p.vendas30 / periodo;
            const cobertura = mediaDia > 0 ? parseFloat((Number(p.estoque) / mediaDia).toFixed(1)) : 999;
            return { ...p, mediaDia: Math.round(mediaDia * 100) / 100, cobertura };
        }
        return p;
    });

    if (filtroCategoria === 'empilhadeira') lista = lista.filter(p => isEmpilhadeira(p));
    else if (filtroCategoria === 'outros')  lista = lista.filter(p => !isEmpilhadeira(p));

    if (textoPesquisa) lista = lista.filter(p =>
        p.titulo.toLowerCase().includes(textoPesquisa) || (p.sku||'').toLowerCase().includes(textoPesquisa));

    if (statusSel.size && statusSel.size < 3)
        lista = lista.filter(p => statusSel.has(p.status));

    if (marcasSel)
        lista = lista.filter(p => { const m = detectarMarca(p.titulo); return m ? marcasSel.has(m) : false; });

    if (fRuptura)     lista = lista.filter(p => Number(p.estoque) === 0 && Number(p.mediaDia) > 0);
    if (fReposicao)   lista = lista.filter(p => Number(p.reposicao) > 0);
    if (fSemVenda)    lista = lista.filter(p => Number(p.mediaDia) === 0);
    if (fAjuste)      lista = lista.filter(p => Number(p.estoque) === 0 && Number(p.vendas30) > 0);
    if (fComTransito) lista = lista.filter(p => Number(window.transitoMap[p.sku] || 0) > 0);
    if (fSemTransito) lista = lista.filter(p => Number(window.transitoMap[p.sku] || 0) === 0);
    if (fComEstoque)  lista = lista.filter(p => Number(p.estoque) > 0);

    const PRIORIDADE = ['tapete','lanterna','calota'];
    function nivelPrioridade(p) {
        if (isEmpilhadeira(p)) return 2;
        const t = (p.titulo || '').toLowerCase();
        if (PRIORIDADE.some(k => t.includes(k))) return 0;
        return 1;
    }
    lista.sort((a, b) => nivelPrioridade(a) - nivelPrioridade(b));

    produtosFiltrados = lista;
    paginaAtual = 1;
    renderPagina(produtosFiltrados, paginaAtual);
    atualizarBadgeFiltros();
}

window.aplicarFiltros = aplicarFiltros;

window.toggleFiltros = function() {
    const sidebar = document.getElementById('filterSidebar');
    const btn     = document.getElementById('btnToggleFiltros');
    sidebar.classList.toggle('collapsed');
    btn.classList.toggle('ativo', !sidebar.classList.contains('collapsed'));
};

window.limparFiltros = function() {
    ['f-ruptura','f-reposicao','f-semvenda','f-ajuste','f-comtransito','f-semtransito','f-comestoque'].forEach(id => {
        const el = document.getElementById(id); if (el) el.checked = false;
    });
    const periodo = document.getElementById('f-periodo'); if (periodo) periodo.value = 30;
    const status  = document.getElementById('f-status');  if (status) [...status.options].forEach(o => o.selected = true);
    document.querySelectorAll('#f-marcas input').forEach(c => c.checked = true);
    aplicarFiltros();
};

/* ── Estratégia ─────────────────────────────────────────────────────────── */
function atualizarEstrategia(valor) {
    if (!diasAlvo || !estrategia) return;
    diasAlvo.value = valor;
    if (valor <= 25) {
        estrategia.innerHTML = 'Conservadora';
        estrategia.style.color = '#f39c12';
        estrategia.parentElement.style.background = 'rgba(243,156,18,.10)';
        estrategia.parentElement.style.border     = '1px solid rgba(243,156,18,.25)';
    } else if (valor <= 45) {
        estrategia.innerHTML = 'Equilibrada';
        estrategia.style.color = '#00ff99';
        estrategia.parentElement.style.background = 'rgba(0,255,153,.08)';
        estrategia.parentElement.style.border     = '1px solid rgba(0,255,153,.20)';
    } else if (valor <= 60) {
        estrategia.innerHTML = 'Agressiva';
        estrategia.style.color = '#ff476f';
        estrategia.parentElement.style.background = 'rgba(255,71,111,.08)';
        estrategia.parentElement.style.border     = '1px solid rgba(255,71,111,.20)';
    } else {
        estrategia.innerHTML = 'Não Recomendada';
        estrategia.style.color = '#8ca0b3';
        estrategia.parentElement.style.background = 'rgba(140,160,179,.08)';
        estrategia.parentElement.style.border     = '1px solid rgba(140,160,179,.20)';
    }
}

if (slider && diasAlvo && estrategia) {
    slider.addEventListener('input', () => atualizarEstrategia(parseInt(slider.value)));
    diasAlvo.addEventListener('input', () => {
        let v = parseInt(diasAlvo.value);
        if (isNaN(v)) return;
        v = Math.min(Math.max(v, 15), 70);
        slider.value = v;
        atualizarEstrategia(v);
    });
    atualizarEstrategia(parseInt(slider.value));
}

/* ── Badge urgência ─────────────────────────────────────────────────────── */
function badgeUrgencia(cobertura) {
    const c = Number(cobertura);
    if (c === 0)  return '<span class="urgencia-badge critico">SEM ESTOQUE</span>';
    if (c >= 999) return '<span class="urgencia-badge sem-venda">SEM VENDA</span>';
    if (c < 7)    return '<span class="urgencia-badge critico">CRÍTICO</span>';
    if (c < 15)   return '<span class="urgencia-badge urgente">URGENTE</span>';
    if (c < 30)   return '<span class="urgencia-badge atencao">ATENÇÃO</span>';
    return '<span class="urgencia-badge ok">OK</span>';
}

/* ── Renderizar página ──────────────────────────────────────────────────── */
function renderPagina(lista, pagina) {
    if (!tabela) return;
    const inicio = (pagina - 1) * POR_PAGINA;
    const fatia  = lista.slice(inicio, inicio + POR_PAGINA);

    const inputStyle = 'width:70px;background:var(--s2,#1c1c1e);border:1px solid var(--sep2,#3a3a3c);border-radius:6px;color:var(--l1,#fff);padding:3px 6px;font-size:12px;text-align:center;outline:none;';

    tabela.innerHTML = fatia.map(p => `
        <tr data-sku="${p.sku}">
            <td>${badgeUrgencia(p.cobertura)}</td>
            <td>${p.titulo}</td>
            <td>${p.sku}</td>
            <td>${p.estoque}</td>
            <td>${p.vendas30}</td>
            <td>${p.mediaDia}</td>
            <td>${p.cobertura}</td>
            <td><strong>${p.reposicao}</strong></td>
            <td><span class="qtd-transito-display" style="display:inline-block;min-width:40px;text-align:center;font-weight:600;color:${(window.transitoMap[p.sku]||0)>0?'#f39c12':'var(--l3,#8ca0b3)'}">${window.transitoMap[p.sku] || 0}</span></td>
            <td><input type="number" class="qtd-full" data-item-id="${p.item_id || ''}" min="0" placeholder="0" value="${window.qtdsFull[p.item_id] ?? (p.reposicao > 0 ? p.reposicao : '')}" style="${inputStyle}" oninput="window.qtdsFull[this.dataset.itemId]=parseInt(this.value)||0"></td>
        </tr>`).join('');

    renderControles(lista.length, pagina);
}

function renderControles(total, pagina) {
    const totalPaginas = Math.ceil(total / POR_PAGINA);
    const inicio = (pagina - 1) * POR_PAGINA + 1;
    const fim    = Math.min(pagina * POR_PAGINA, total);

    ['paginacaoReposicao', 'paginacaoReposicaoTopo'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        if (totalPaginas <= 1) { el.innerHTML = ''; return; }

        const delta = 2;
        let btns = `<button class="pg-btn" ${pagina === 1 ? 'disabled' : ''} onclick="irPagina(${pagina - 1})">&#8249;</button>`;
        for (let p = 1; p <= totalPaginas; p++) {
            if (p === 1 || p === totalPaginas || (p >= pagina - delta && p <= pagina + delta)) {
                btns += `<button class="pg-btn${p === pagina ? ' pg-ativo' : ''}" onclick="irPagina(${p})">${p}</button>`;
            } else if (p === pagina - delta - 1 || p === pagina + delta + 1) {
                btns += `<span class="pg-sep">…</span>`;
            }
        }
        btns += `<button class="pg-btn" ${pagina === totalPaginas ? 'disabled' : ''} onclick="irPagina(${pagina + 1})">&#8250;</button>`;
        btns += `<span class="pg-sep" style="margin-left:8px;color:var(--l3)">${inicio}–${fim} de ${total}</span>`;

        el.innerHTML = `<div class="pg-wrap">${btns}</div>`;
    });
}

window.irPagina = function(p) {
    paginaAtual = p;
    renderPagina(produtosFiltrados, paginaAtual);
    document.getElementById('paginacaoReposicaoTopo')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

/* ── Carregar JSON ──────────────────────────────────────────────────────── */
function carregarProdutos() {
    // deduplica por SKU somando estoque e vendas30
    fetch('/api/dados')
        .then(r => r.json())
        .then(resp => {
            const raw = resp.produtos || resp;
            if (resp.transito) window.transitoMap = resp.transito;
            // O motor já deduplicou por SKU (estoque = max, vendas = soma)
            // Aqui apenas indexa por SKU como segurança
            const mapa = {};
            raw.forEach(p => {
                const sku = p.sku;
                if (!mapa[sku]) {
                    mapa[sku] = { ...p };
                } else {
                    // Mantém o maior estoque e soma vendas (caso motor antigo ainda exista no JSON)
                    const estoqueMax = Math.max(Number(mapa[sku].estoque), Number(p.estoque));
                    mapa[sku].vendas30 += Number(p.vendas30);
                    const mediaDia = mapa[sku].vendas30 / 30;
                    mapa[sku].estoque   = estoqueMax;
                    mapa[sku].mediaDia  = Math.round(mediaDia * 100) / 100;
                    mapa[sku].cobertura = mediaDia > 0 ? Math.round((estoqueMax / mediaDia) * 10) / 10 : 999;
                    const _diasC = parseInt(diasColeta?.value) || 0;
                    const _diasA = parseInt(diasAlvo?.value)   || 44;
                    mapa[sku].reposicao = Math.max(0, Math.ceil(mediaDia * (_diasC + _diasA)) - estoqueMax);
                }
            });
            const produtos = Object.values(mapa);
            window.produtosReposicao = produtos;
            construirListaMarcas();
            aplicarFiltros();
        })
        .catch(() => {
            if (tabela) tabela.innerHTML = '<tr><td colspan="10" class="text-center text-danger py-4">Erro ao carregar dados.</td></tr>';
        });
}

if (tabela) {
    fetch('/api/transito').then(r => r.json()).catch(() => ({}))
        .then(transito => {
            window.transitoMap = transito || {};
            carregarProdutos();
        });
}

/* ── Pesquisa ───────────────────────────────────────────────────────────── */
if (pesquisa) {
    pesquisa.addEventListener('input', function () {
        textoPesquisa = this.value.toLowerCase().trim();
        aplicarFiltros();
        paginaAtual = 1;
        renderPagina(produtosFiltrados, paginaAtual);
    });
}

/* ── Recalcular ─────────────────────────────────────────────────────────── */
if (btnRecalcular) {
    btnRecalcular.addEventListener('click', () => {
        if (!window.produtosReposicao.length) return;
        const diasC = parseInt(diasColeta?.value) || 0;
        const diasA = parseInt(diasAlvo?.value)   || 44;
        const diasT = diasC + diasA;

        produtosFiltrados = window.produtosReposicao.map(p => {
            const estoque   = Number(p.estoque);
            const mediaDia  = Number(p.mediaDia);
            const transito  = Number(window.transitoMap[p.sku] || 0);
            const cobertura = mediaDia > 0 ? parseFloat((estoque / mediaDia).toFixed(1)) : 999;
            const reposicao = Math.max(Math.ceil(mediaDia * diasT) - estoque - transito, 0);
            return { ...p, cobertura, reposicao };
        });

        paginaAtual = 1;
        renderPagina(produtosFiltrados, paginaAtual);
    });
}

/* ── Atualizar via motor ────────────────────────────────────────────────── */
if (btnAtualizar) {
    btnAtualizar.addEventListener('click', async function () {
        const iconOriginal = btnAtualizar.querySelector('i');
        const spanOriginal = btnAtualizar.querySelector('span');
        if (iconOriginal) iconOriginal.className = 'bi bi-arrow-repeat spin';
        if (spanOriginal) spanOriginal.textContent = 'Atualizando...';
        btnAtualizar.style.opacity      = '0.6';
        btnAtualizar.style.pointerEvents = 'none';

        try {
            const resp = await fetch('/api/atualizar', { method: 'POST' });
            // lê o stream de log linha a linha
            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const linha = decoder.decode(value);
                console.log('[motor]', linha.trim());
            }
            if (iconOriginal) iconOriginal.className = 'bi bi-check-circle';
            if (spanOriginal) spanOriginal.textContent = 'Concluído!';
            setTimeout(() => location.reload(), 1200);
        } catch (e) {
            if (iconOriginal) iconOriginal.className = 'bi bi-x-circle';
            if (spanOriginal) spanOriginal.textContent = 'Erro';
            btnAtualizar.style.opacity       = '1';
            btnAtualizar.style.pointerEvents = '';
        }
    });
}

/* ── Gerar planilha Full ────────────────────────────────────────────────── */
if (btnGerarPlanilha) {
    btnGerarPlanilha.addEventListener('click', async function () {
        // salva inputs visiveis antes de exportar
        document.querySelectorAll('.qtd-full').forEach(input => {
            const id  = input.dataset.itemId;
            const qty = parseInt(input.value) || 0;
            if (id) window.qtdsFull[id] = qty;
        });

        const produtosExportar = Object.entries(window.qtdsFull)
            .filter(([, qty]) => qty > 0)
            .map(([item_id, qtdFull]) => {
                const produto = window.produtosReposicao.find(p => p.item_id === item_id);
                return { item_id, qtdFull, sku: produto?.sku || '' };
            });

        if (!produtosExportar.length) { alert('Nenhum produto com quantidade informada.'); return; }

        try {
            const resp = await fetch('/api/gerar_planilha', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(produtosExportar),
            });
            if (!resp.ok) throw new Error(resp.status);
            const blob = await resp.blob();
            const url  = URL.createObjectURL(blob);
            const a    = Object.assign(document.createElement('a'), { href: url, download: 'reposicao_full.xlsx' });
            document.body.appendChild(a); a.click(); a.remove();
            URL.revokeObjectURL(url);
        } catch (e) {
            alert('Erro ao gerar planilha. Verifique o console.');
            console.error(e);
        }
    });
}

/* ── Enviar para Full ───────────────────────────────────────────────────── */
if (btnEnviarFull) {
    btnEnviarFull.addEventListener('click', () => {
        window.open('https://myaccount.mercadolivre.com.br/shipping/import/excel/upload', '_blank');
    });
}

}); // DOMContentLoaded
