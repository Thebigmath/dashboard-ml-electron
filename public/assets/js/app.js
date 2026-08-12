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

// QTD FULL é o que sobra do estoque para enviar — não é a reposição. O que já foi
// despachado sai da conta.
// Mesma fórmula do "Enviar hoje" do Magiic:
//   max(0, estoqueAlvoFull - estoqueAtualFull - transitoFull)
// Fórmula alternativa testada (2026-08-05): estoque - trânsito
// Resultado: ~7.8% de match com Magiic — descartada.
// function qtdFullSugerida(p) {
//     return Math.max(0, Number(p.estoque) - (window.transitoMap[p.sku] || 0));
// }

function qtdFullSugerida(p) {
    return Number(p.reposicao) || 0;
}
window.transitoMap = {};
window.custosMap   = {};
// Seleção por "chave" (identificador único), não pelo SKU: assim ela sobrevive
// à paginação, aos filtros e a SKUs repetidos entre produtos diferentes.
window.selecionados = new Set();
let apenasSelecionados = false;

const chaveDe = p => p.chave || p.sku;

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

function detectarFornecedor(p) {
    const t = (p.titulo || '').toLowerCase();
    const s = (p.sku    || '').toLowerCase();
    if (t.includes('lanterna')) return 'Fitam';
    if (/^\d+tb/.test(s))      return 'Attis';
    if (/^tb\d+/.test(s))      return 'Grid';
    return null;
}

function getFiltrosFornecedores() {
    const checks = document.querySelectorAll('#f-fornecedores input[type=checkbox]');
    if (!checks.length) return null;
    if ([...checks].every(c => c.checked)) return null;
    return new Set([...checks].filter(c => c.checked).map(c => c.value));
}

async function renderizarGraficoFaturamento() {
    const el = document.getElementById('grafico-faturamento');
    if (!el) return;
    el.innerHTML = `<div style="text-align:center;color:var(--l3);font-size:12px;padding:20px 0">Carregando...</div>`;
    try {
        const r = await fetch('/api/faturamento_mensal');
        const dados = await r.json();
        if (!Array.isArray(dados) || !dados.length) throw new Error();
        const max = Math.max(...dados.map(d => d.valor), 1);
        const fmt = v => 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
        const W = 240, H = 120, PAD_L = 8, PAD_B = 22, barW = Math.floor((W - PAD_L) / dados.length) - 4;
        const barH = (v) => Math.max(2, ((v / max) * (H - PAD_B - 8)));
        const barX = (i) => PAD_L + i * ((W - PAD_L) / dados.length) + 2;
        const bars = dados.map((d, i) => {
            const h = barH(d.valor);
            const x = barX(i);
            const y = H - PAD_B - h;
            const mesAtual = i === dados.length - 1;
            return `
                <rect class="fat-bar" x="${x}" y="${y}" width="${barW}" height="${h}" rx="3"
                    data-mes="${d.mes}" data-valor="${fmt(d.valor)}" data-atual="${mesAtual}"
                    fill="${mesAtual ? '#0a84ff' : 'rgba(10,132,255,0.35)'}"
                    style="cursor:pointer;transition:fill .15s"/>
                <text x="${x + barW/2}" y="${H - 6}" text-anchor="middle"
                    font-size="9" fill="var(--l3)" style="pointer-events:none">${d.mes}</text>`;
        }).join('');
        const total = dados.reduce((s, d) => s + d.valor, 0);
        el.innerHTML = `
            <div style="font-size:18px;font-weight:700;color:var(--l1);margin-bottom:4px">${fmt(total)}</div>
            <div style="font-size:11px;color:var(--l3);margin-bottom:10px">últimos 6 meses</div>
            <div style="position:relative">
                <div id="fat-tooltip" style="display:none;position:absolute;background:var(--s1);border:1px solid var(--sep);border-radius:8px;padding:6px 10px;font-size:12px;pointer-events:none;white-space:nowrap;z-index:10;box-shadow:0 4px 16px rgba(0,0,0,.4)"></div>
                <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" style="overflow:visible">${bars}</svg>
            </div>`;

        const tooltip = el.querySelector('#fat-tooltip');
        el.querySelectorAll('.fat-bar').forEach(rect => {
            rect.addEventListener('mouseenter', () => {
                tooltip.innerHTML = `<span style="color:var(--l3)">${rect.dataset.mes}&nbsp;</span><strong style="color:var(--l1)">${rect.dataset.valor}</strong>`;
                tooltip.style.display = 'block';
                rect.style.fill = '#0a84ff';
            });
            rect.addEventListener('mousemove', (e) => {
                const box = el.getBoundingClientRect();
                let left = e.clientX - box.left + 12;
                if (left + 180 > box.width) left = e.clientX - box.left - 190;
                tooltip.style.left = left + 'px';
                tooltip.style.top  = (e.clientY - box.top - 40) + 'px';
            });
            rect.addEventListener('mouseleave', () => {
                tooltip.style.display = 'none';
                rect.style.fill = rect.dataset.atual === 'true' ? '#0a84ff' : 'rgba(10,132,255,0.35)';
            });
        });
    } catch {
        el.innerHTML = `<div style="text-align:center;color:var(--l3);font-size:12px;padding:20px 0">Sem dados de faturamento</div>`;
    }
}

function contarFiltrosAtivos() {
    let n = 0;
    ['f-ruptura','f-reposicao','f-semvenda','f-comtransito','f-semtransito','f-comestoque'].forEach(id => {
        if (document.getElementById(id)?.checked) n++;
    });
    if ((parseInt(document.getElementById('f-periodo')?.value) || 30) !== 30) n++;
    const statusOpts = [...(document.getElementById('f-status')?.options || [])];
    if (statusOpts.some(o => !o.selected)) n++;
    if (getFiltrosFornecedores()) n++;
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
    const fComTransito = document.getElementById('f-comtransito')?.checked;
    const fSemTransito = document.getElementById('f-semtransito')?.checked;
    const fComEstoque  = document.getElementById('f-comestoque')?.checked;
    const statusSel    = new Set([...(document.getElementById('f-status')?.selectedOptions || [])].map(o => o.value));
    const fornecedoresSel = getFiltrosFornecedores();

    let lista = window.produtosReposicao.map(p => {
        if (periodo !== 30) {
            const mediaDia  = p.vendas30 / periodo;
            // conta o trânsito e usa a média em precisão total — mesma regra do backend
            const coberto   = Number(p.estoque) + Number(window.transitoMap[p.sku] || 0);
            const cobertura = coberto === 0 ? 0 : (mediaDia > 0 ? parseFloat((coberto / mediaDia).toFixed(1)) : 999);
            return { ...p, mediaDia: Math.round(mediaDia * 100) / 100, cobertura };
        }
        return p;
    });

    lista = lista.filter(p => !isEmpilhadeira(p));

    if (textoPesquisa) lista = lista.filter(p =>
        p.titulo.toLowerCase().includes(textoPesquisa) || (p.sku||'').toLowerCase().includes(textoPesquisa));

    if (statusSel.size && statusSel.size < 3)
        lista = lista.filter(p => statusSel.has(p.status));

    if (fornecedoresSel)
        lista = lista.filter(p => { const f = detectarFornecedor(p); return f ? fornecedoresSel.has(f) : false; });

    if (fRuptura)     lista = lista.filter(p => Number(p.estoque) === 0 && Number(p.mediaDia) > 0);
    if (fReposicao)   lista = lista.filter(p => Number(p.reposicao) > 0);
    if (fSemVenda)    lista = lista.filter(p => Number(p.mediaDia) === 0);
    if (fComTransito) lista = lista.filter(p => Number(window.transitoMap[p.sku] || 0) > 0);
    if (fSemTransito) lista = lista.filter(p => Number(window.transitoMap[p.sku] || 0) === 0);
    if (fComEstoque)  lista = lista.filter(p => Number(p.estoque) > 0);
    if (apenasSelecionados) lista = lista.filter(p => window.selecionados.has(chaveDe(p)));

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
    ['f-ruptura','f-reposicao','f-semvenda','f-comtransito','f-semtransito','f-comestoque'].forEach(id => {
        const el = document.getElementById(id); if (el) el.checked = false;
    });
    const periodo = document.getElementById('f-periodo'); if (periodo) periodo.value = 30;
    const status  = document.getElementById('f-status');  if (status) [...status.options].forEach(o => o.selected = true);
    document.querySelectorAll('#f-fornecedores input').forEach(c => c.checked = true);
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
function badgeUrgencia(p) {
    const c = Number(typeof p === 'object' && p !== null ? p.cobertura : p);
    const vendeu = typeof p === 'object' && p !== null ? Number(p.vendas30) > 0 : true;
    // Estoque zerado sem nenhuma venda não é ruptura, é produto parado. Os dois casos
    // caíam em "SEM ESTOQUE" e 149 produtos mortos apareciam como crítico, escondendo
    // as 57 rupturas de verdade.
    if (c === 0 && !vendeu) return '<span class="urgencia-badge sem-venda">PARADO</span>';
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
        <tr data-sku="${p.sku}" data-chave="${chaveDe(p)}"${window.selecionados.has(chaveDe(p)) ? ' class="linha-sel"' : ''}>
            <td class="col-sel"><input type="checkbox" class="sel-check sel-linha" data-chave="${chaveDe(p)}"${window.selecionados.has(chaveDe(p)) ? ' checked' : ''}></td>
            <td>${badgeUrgencia(p)}</td>
            <td>${p.titulo}${p.curvaAbc ? ` <span class="badge-abc badge-abc-${p.curvaAbc.toLowerCase()}">${p.curvaAbc}</span>` : ''}</td>
            <td>${p.sku}</td>
            <!-- estoque cru: o que está em trânsito tem coluna própria e ainda não chegou
                 ao FULL, então não pode ser subtraído daqui (subtrair mostrava 0 em produto
                 com estoque real, ex. 35063d com 48 un e 86 em trânsito) -->
            <td>${Number(p.estoque)}</td>
            <td>${p.vendas30}</td>
            <td>${p.mediaDia}</td>
            <td>${Number(p.cobertura) >= 999 ? '—' : p.cobertura}</td>
            <td><strong>${Number(p.reposicao) > 0 ? p.reposicao : '—'}</strong></td>
            <td><span class="qtd-transito-display" style="display:inline-block;min-width:40px;text-align:center;font-weight:600;color:${(window.transitoMap[p.sku]||0)>0?'#f39c12':'var(--l3,#8ca0b3)'}">${window.transitoMap[p.sku] || 0}</span></td>
            <td><input type="number" class="qtd-full" data-chave="${chaveDe(p)}" data-item-id="${p.item_id || ''}" min="0" placeholder="0" value="${window.qtdsFull[chaveDe(p)] ?? (qtdFullSugerida(p) > 0 ? qtdFullSugerida(p) : '')}" style="${inputStyle}" oninput="window.qtdsFull[this.dataset.chave]=parseInt(this.value)||0"></td>
        </tr>`).join('');

    renderControles(lista.length, pagina);
    sincronizarSelecaoUI();
}

/* ── Seleção de produtos ────────────────────────────────────────────────── */
function sincronizarSelecaoUI() {
    const n = window.selecionados.size;

    // checkbox mestre reflete o estado da página visível
    const visiveis = [...document.querySelectorAll('.sel-linha')];
    const master   = document.getElementById('selTodos');
    if (master) {
        const marcados = visiveis.filter(c => c.checked).length;
        master.checked       = visiveis.length > 0 && marcados === visiveis.length;
        master.indeterminate = marcados > 0 && marcados < visiveis.length;
    }

    let painel = document.getElementById('painel-selecao');
    if (!n) { painel?.remove(); return; }

    if (!painel) {
        painel = document.createElement('div');
        painel.id = 'painel-selecao';
        document.body.appendChild(painel);
        painel.addEventListener('click', e => {
            const acao = e.target.closest('[data-acao]')?.dataset.acao;
            if (acao === 'filtrar') { apenasSelecionados = !apenasSelecionados; paginaAtual = 1; aplicarFiltros(); }
            if (acao === 'limpar')  { window.selecionados.clear(); apenasSelecionados = false; paginaAtual = 1; aplicarFiltros(); }
            if (acao === 'planilha') document.getElementById('btnGerarPlanilhaFull')?.click();
        });
    }

    // soma as quantidades informadas apenas dos selecionados
    const porChave = {};
    window.produtosReposicao.forEach(p => { porChave[chaveDe(p)] = p; });
    let unidades = 0;
    window.selecionados.forEach(c => {
        const p = porChave[c];
        // indexado por chave: o input grava por chave, e buscar por item_id fazia o
        // contador ignorar as quantidades editadas à mão
        if (p) unidades += Number(window.qtdsFull[c] ?? qtdFullSugerida(p)) || 0;
    });

    painel.innerHTML = `
        <div class="ps-topo"><i class="bi bi-check2-square"></i> ${n} produto${n > 1 ? 's' : ''} selecionado${n > 1 ? 's' : ''}</div>
        <div class="ps-num"><strong>${unidades}</strong><span>unidades a enviar</span></div>
        <button class="ps-btn ps-primario" data-acao="filtrar">
            <i class="bi bi-funnel"></i> ${apenasSelecionados ? 'Mostrar todos' : 'Mostrar apenas selecionados'}
        </button>
        <button class="ps-btn" data-acao="planilha"><i class="bi bi-file-earmark-arrow-down"></i> Gerar planilha dos selecionados</button>
        <button class="ps-btn ps-limpar" data-acao="limpar"><i class="bi bi-x-circle"></i> Limpar seleção</button>`;
}

if (tabela) {
    tabela.addEventListener('change', e => {
        const chk = e.target.closest('.sel-linha');
        if (!chk) return;
        const c = chk.dataset.chave;
        if (chk.checked) window.selecionados.add(c); else window.selecionados.delete(c);
        chk.closest('tr')?.classList.toggle('linha-sel', chk.checked);
        sincronizarSelecaoUI();
    });
}

document.getElementById('selTodos')?.addEventListener('change', function () {
    document.querySelectorAll('.sel-linha').forEach(chk => {
        chk.checked = this.checked;
        if (this.checked) window.selecionados.add(chk.dataset.chave);
        else window.selecionados.delete(chk.dataset.chave);
        chk.closest('tr')?.classList.toggle('linha-sel', this.checked);
    });
    sincronizarSelecaoUI();
});

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
                // agrupa pela chave única, não pelo rótulo: SKUs iguais podem ser
                // produtos diferentes e não devem ter as vendas somadas
                const sku = p.chave || p.sku;
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
                    const _diasA = parseInt(diasAlvo?.value)   || 35;
                    const _diasTotal = (mapa[sku].status === 'active') ? (_diasC + _diasA) : _diasA;
                    mapa[sku].reposicao = Math.max(0, Math.ceil(mediaDia * _diasTotal) - estoqueMax);
                }
            });
            const produtos = Object.values(mapa);
            window.produtosReposicao = produtos;
            renderizarGraficoFaturamento();
            aplicarFiltros();
        })
        .catch(() => {
            if (tabela) tabela.innerHTML = '<tr><td colspan="11" class="text-center text-danger py-4">Erro ao carregar dados.</td></tr>';
        });
}

if (tabela) {
    fetch('/api/app_info')
        .then(r => r.json())
        .then(info => {
            if (info.dias_coleta) {
                const el = document.getElementById('diasColeta');
                if (el) el.value = info.dias_coleta;
            }
            if (info.dias_alvo) {
                const el = document.getElementById('diasAlvo');
                if (el) el.value = info.dias_alvo;
                const slider = document.getElementById('sliderReposicao');
                if (slider) slider.value = info.dias_alvo;
            }
        })
        .catch(() => {})
        .finally(() => {
            fetch('/api/transito').then(r => r.json()).catch(() => ({}))
                .then(transito => {
                    window.transitoMap = transito || {};
                    carregarProdutos();
                });
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

/* ── Cálculo Magis5 ─────────────────────────────────────────────────────── */
function calcularReposicaoMagis5(vendas30d, diasColeta, diasAlvo, estoqueAtualFull, transitoFull, itensPorKit, ativo) {
    transitoFull  = transitoFull  || 0;
    itensPorKit   = itensPorKit   || 1;
    // precisão total: arredondar o vdm antes de multiplicar errava até 1 unidade
    const vdm = vendas30d / 30;
    // Dias de venda até a mercadoria chegar — pausado não vende nesse período
    const diasAteChegar = ativo ? diasColeta : 0;
    const coberturaNecessaria  = vdm * diasAlvo;
    // do estoque atual só sobra o que não for vendido durante a espera (nunca negativo)
    const estoqueNaChegada = Math.max(0, estoqueAtualFull - vdm * diasAteChegar);
    const necessidade = coberturaNecessaria - estoqueNaChegada - transitoFull;
    if (necessidade <= 0) return 0;
    let sugestao = Math.ceil(necessidade);
    if (itensPorKit > 1) {
        const resto = sugestao % itensPorKit;
        if (resto !== 0) sugestao += (itensPorKit - resto);
    }
    return sugestao;
}

/* ── Recalcular ─────────────────────────────────────────────────────────── */
if (btnRecalcular) {
    btnRecalcular.addEventListener('click', () => {
        if (!window.produtosReposicao.length) return;
        const diasC = parseInt(diasColeta?.value) || 0;
        const diasA = parseInt(diasAlvo?.value)   || 35;

        window.produtosReposicao = window.produtosReposicao.map(p => {
            const estoque  = Number(p.estoque);
            const vendas30 = Number(p.vendas30);
            const transito = Number(window.transitoMap[p.sku] || 0);
            const vdm      = Math.round((vendas30 / 30) * 100) / 100;
            // cobertura conta o trânsito e usa a média em precisão total — igual ao backend
            const vdmReal   = vendas30 / 30;
            const coberto   = estoque + transito;
            const cobertura = coberto === 0 ? 0 : (vdmReal > 0 ? parseFloat((coberto / vdmReal).toFixed(1)) : 999);
            const reposicao = calcularReposicaoMagis5(vendas30, diasC, diasA, estoque, transito, 1, p.status === 'active');
            return { ...p, mediaDia: vdm, cobertura, reposicao };
        });

        paginaAtual = 1;
        aplicarFiltros();
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
            const c   = input.dataset.chave;
            const qty = parseInt(input.value) || 0;
            if (c) window.qtdsFull[c] = qty;
        });

        // Percorre a lista completa, não os inputs visíveis: um produto
        // selecionado em outra página nunca foi renderizado e sumiria calado.
        // Sem quantidade digitada, vale a reposição sugerida — que é o número
        // que o campo já mostra.
        const temSelecao = window.selecionados.size > 0;
        const produtosExportar = window.produtosReposicao
            .filter(p => !temSelecao || window.selecionados.has(chaveDe(p)))
            .map(p => {
                const c = chaveDe(p);
                const qtd = window.qtdsFull[c] ?? qtdFullSugerida(p);
                return { chave: c, item_id: p.item_id, sku: p.sku, qtdFull: Number(qtd) || 0 };
            })
            .filter(p => p.qtdFull > 0);

        if (!produtosExportar.length) {
            alert(temSelecao
                ? 'Nenhum dos produtos selecionados tem quantidade a enviar.'
                : 'Nenhum produto com quantidade informada.');
            return;
        }

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
        const url = 'https://vendedores.mercadolivre.com.br/shipping/import/excel/upload';
        if (window.electronAPI?.openExternal) window.electronAPI.openExternal(url);
        else window.open(url, '_blank');
    });
}

/* ── Tooltips de cabeçalho (clique, não hover) ─────────────────────────── */
const thTooltipPopup = document.createElement('div');
thTooltipPopup.id = 'th-tooltip-popup';
document.body.appendChild(thTooltipPopup);

document.addEventListener('click', (e) => {
    const icone = e.target.closest('.th-info-icon');
    if (icone) {
        const jaAberto = thTooltipPopup.classList.contains('show') && thTooltipPopup._alvo === icone;
        if (jaAberto) {
            thTooltipPopup.classList.remove('show');
            thTooltipPopup._alvo = null;
            return;
        }
        thTooltipPopup.textContent = icone.dataset.tip || '';
        thTooltipPopup.classList.add('show');
        thTooltipPopup._alvo = icone;

        const r = icone.getBoundingClientRect();
        const h = thTooltipPopup.offsetHeight;
        const w = thTooltipPopup.offsetWidth;

        // Abre abaixo do ícone; se não couber, abre acima. Nunca sai da tela.
        let top = r.bottom + 6;
        if (top + h > window.innerHeight - 8) top = r.top - h - 6;
        top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
        thTooltipPopup.style.top = top + 'px';

        let left = r.left + r.width / 2 - w / 2;
        left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
        thTooltipPopup.style.left = left + 'px';
    } else if (!e.target.closest('#th-tooltip-popup')) {
        thTooltipPopup.classList.remove('show');
        thTooltipPopup._alvo = null;
    }
});

}); // DOMContentLoaded
