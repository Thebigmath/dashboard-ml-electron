const express = require('express');
const path = require('path');
const fs = require('fs');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, 'storage');

const app = express();
// Monitor de cotas: conta toda chamada ao Mercado Livre e ao Mercado Pago (Area do desenvolvedor)
require('./lib/cotas').ligarAxios(require('axios'));
// guarda do Mercado Pago: so leitura, lista fechada de caminhos, token do ML nao sai para outros sites, tudo auditado
require('./lib/mp_guarda').ligar(require('axios'));
let httpServer = null;

// a extensao da Agenda do Full devolve a agenda inteira do ML (centenas de horarios): limite maior so nessa rota
app.use('/api/agenda-full/ext', express.json({ limit: '15mb' }));
// planilha de estoque do ERP Commander chega em base64
app.use('/api/olist-estoque/upload/previa', express.json({ limit: '25mb' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Seguranca do servidor local (06/10/2026): so o proprio Dashboard pode usar.
// - Host: so 127.0.0.1/localhost na porta do app (bloqueia "DNS rebinding" de sites maliciosos)
// - pedidos que ALTERAM algo (POST/PUT/DELETE...): recusados se vierem de outro site
//   (Origin diferente ou Sec-Fetch-Site cross-site). Sem isso, qualquer pagina aberta no PC
//   podia mandar um formulario para o Dashboard (ex.: alterar preco).
app.use((req, res, next) => {
    const host = String(req.headers.host || '').toLowerCase();
    const porta = httpServer && httpServer.address() ? String(httpServer.address().port) : null;
    const m = host.match(/^(127\.0\.0\.1|localhost)(?::(\d+))?$/);
    if (!m || (porta && m[2] && m[2] !== porta)) return res.status(403).send('Acesso negado.');
    // Agenda do Full: a extensao do Chrome (Origin chrome-extension://) pega tarefas e devolve resultados.
    // Nessas duas rotas so ela entra: pagina de site (Sec-Fetch-Site cross-site / Origin http) e recusada.
    if (req.path.startsWith('/api/agenda-full/ext/')) {
        const origin = String(req.headers.origin || ''), site = req.headers['sec-fetch-site'];
        if (origin.startsWith('chrome-extension://') || (!origin && (!site || site === 'none'))) return next();
        return res.status(403).json({ erro: 'Só a extensão do SEVEN usa esta rota.' });
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const site = req.headers['sec-fetch-site'];
        if (site && !['same-origin', 'none'].includes(site)) return res.status(403).json({ erro: 'Pedido de outro site bloqueado.' });
        const origin = req.headers.origin;
        if (origin) {
            let ok = false;
            try { ok = new URL(origin).host.toLowerCase() === host; } catch {}
            if (!ok) return res.status(403).json({ erro: 'Pedido de outro site bloqueado.' });
        }
    }
    next();
});

// Rotas API e Auth (sem autenticação)
app.use('/api', require('./routes/api'));
app.use('/auth', require('./routes/auth'));

// Dashboard principal (sem login)
// O app abre no Feed: e a tela que diz o que fazer hoje. O painel completo
// continua inteiro em /painel (e no menu), so deixou de ser a porta de entrada.
// O app abre na pagina Inicio (arquitetura SEVEN, 06/10/2026): faturamento, as portas dos
// ecossistemas (STOCK Ops, AD HEALTH, Finance), noticias globais e atualizacoes do app.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/inicio.html')));
// STOCK Ops abre direto no Painel, onde se monta o Full (a tela de cards repetia o menu lateral)
app.get('/stock-ops', (req, res) => res.redirect('/painel'));
app.get('/dev', (req, res) => res.sendFile(path.join(__dirname, 'public/dev.html')));
app.get('/feed', (req, res) => res.sendFile(path.join(__dirname, 'public/feed.html')));
app.get('/painel', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
app.get('/envio_full', (req, res) => res.sendFile(path.join(__dirname, 'public/envio_full.html')));
app.get('/valor_estoque', (req, res) => res.sendFile(path.join(__dirname, 'public/valor_estoque.html')));
app.get('/frete', (req, res) => res.sendFile(path.join(__dirname, 'public/frete.html')));
app.get('/novidades', (req, res) => res.sendFile(path.join(__dirname, 'public/novidades.html')));
app.get('/avisos', (req, res) => res.sendFile(path.join(__dirname, 'public/avisos.html')));
app.get('/seven', (req, res) => res.sendFile(path.join(__dirname, 'public/seven.html')));
app.get('/reputacao', (req, res) => res.sendFile(path.join(__dirname, 'public/reputacao.html')));
app.get('/finance-saldo-mp', (req, res) => res.sendFile(path.join(__dirname, 'public/finance_saldo_mp.html')));
app.get('/finance-fluxo-caixa', (req, res) => res.sendFile(path.join(__dirname, 'public/finance_fluxo_caixa.html')));
app.get('/finance-extrato', (req, res) => res.sendFile(path.join(__dirname, 'public/finance_extrato.html')));
app.get('/finance-contas-pagar', (req, res) => res.sendFile(path.join(__dirname, 'public/finance_contas_pagar.html')));
app.get('/finance-liberacoes', (req, res) => res.sendFile(path.join(__dirname, 'public/finance_liberacoes.html')));
app.get('/finance-conciliacao', (req, res) => res.sendFile(path.join(__dirname, 'public/finance_conciliacao.html')));
app.get('/finance-planilha', (req, res) => res.sendFile(path.join(__dirname, 'public/finance_planilha.html')));
app.get('/finance', (req, res) => res.sendFile(path.join(__dirname, 'public/finance.html')));
// a tela antiga de Parados esta em standby (dependia da ponte do Nubimetrics): vai para o Controle de estoque parado
app.get('/parados', (req, res) => res.redirect('/seven#parados'));
app.get('/metricas-stock', (req, res) => res.sendFile(path.join(__dirname, 'public/metricas_stock.html')));
app.get('/erp-commander', (req, res) => res.sendFile(path.join(__dirname, 'public/erp_commander.html')));
app.get('/full-erp', (req, res) => res.redirect('/erp-commander'));
app.get('/agenda-full', (req, res) => res.sendFile(path.join(__dirname, 'public/agenda_full.html')));

// Arquivos estáticos
// etag: true + maxAge 0 faz o navegador revalidar a cada carga em vez de
// reusar o arquivo em cache as cegas. Sem isso, depois de uma atualizacao o
// Electron continuava rodando o app.js antigo — a tela nova ficava parada
// porque o codigo que a movia nem estava carregado.
app.use(express.static(path.join(__dirname, 'public'), {
    etag: true,
    lastModified: true,
    maxAge: 0,
    setHeaders: (res, caminho) => {
        if (/\.(html|js|css)$/i.test(caminho)) res.setHeader('Cache-Control', 'no-cache');
    },
}));

module.exports = {
    start: (port, cb) => {
        httpServer = app.listen(port, '127.0.0.1', cb);
        // monitor de frete: 90 s depois de abrir e de hora em hora
        require('./lib/frete').iniciarAgendador();
        // envio ao Full esquecido em aberto: aviso 2 min depois de subir e a cada 12 h
        require('./lib/envios_alerta').iniciarAgendador();
        // reputação: 40 s depois de subir e a cada 4 min
        // notificações globais: feed dos próximos projetos, 45 s depois e a cada 30 min
        require('./lib/avisos').iniciarAgendador();
        // ranking ML (Issacar direto na busca do ML): todo dia a partir das 7h, para as duas contas
        require('./lib/ranking_mt').iniciarAgendador();
        require('./lib/motor_preco').iniciarAgendador();
        require('./lib/flex_auto').iniciarAgendador();
        require('./lib/reputacao_previsao').iniciarAgendador();   // reputacao: coleta e previsao do Platinum a cada 6 h (a partir das 7h)
        require('./lib/belvo').iniciarAgendador();   // Belvo (Open Finance): saldo e cartao do Mercado Pago PJ, so se ja conectou (a cada 30 min)
        require('./lib/finance_saldo_mp').iniciarAgendador();   // saldo do Mercado Pago: ancora diaria (7h) + bots a cada 3 min
        require('./lib/simulacao_precos').iniciarAgendador();   // simulacao de precos da IA (vendas de ontem), todo dia a partir das 8h    // Flex automatico pelo estoque do Olist (so no Dashboard da Flavia, so se ligado)
        require('./lib/central_ml').iniciarAgendador();   // vigias da Agenda do Full (so se houver vigia ativa)   // modo automatico das regras de preco (so se ligado)
        // "Versão X instalada — veja o que mudou": 8 s depois de subir, para a
        // janela já existir quando o clique na notificação quiser abri-la.
        setTimeout(() => { try { require('./lib/novidades').avisarSeAtualizou(); } catch {} }, 8000);
    },
    stop: () => {
        require('./lib/frete').pararAgendador();
        require('./lib/envios_alerta').pararAgendador();
        require('./lib/avisos').pararAgendador();
        require('./lib/ranking_mt').pararAgendador();
        require('./lib/motor_preco').pararAgendador();
        require('./lib/flex_auto').pararAgendador();
        require('./lib/reputacao_previsao').pararAgendador();
        require('./lib/belvo').pararAgendador();
        require('./lib/finance_saldo_mp').pararAgendador();
        require('./lib/simulacao_precos').pararAgendador();
        if (httpServer) httpServer.close();
    }
};
