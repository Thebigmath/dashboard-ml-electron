# SEVEN, Ranking ML (Issacar) e mudanças no Feed — Documentação

Atualizado em 28/09/2026. Vale para as duas contas:

| Conta | Repositório | Porta | Storage (dados do app) |
|---|---|---|---|
| Flavia Stock (vendedor STOCK EMPILHADEIRA, 99249917) | `C:\laragon\www\dashboard-ml-electron` | 3001 | `%APPDATA%\dashboard-ml\storage` |
| Cordeiro Car (vendedor CORDEIRO_CAR, 3083462484) | `C:\laragon\www\dashboard-cordeiro-electron` | 3002 | `%APPDATA%\dashboard-cordeiro\storage` |

Os dois repositórios têm o mesmo código. As únicas diferenças são as próprias de cada conta (arquivo de ranking, lista de termos, horário da coleta semanal). **Toda mudança feita numa conta tem que ir para a outra antes de publicar.**

---

## 1. Visão geral

```
                 ┌────────────── API do Mercado Livre (token de cada conta) ──────────────┐
                 │ pedidos de ontem · pedidos do mês anterior · estoque Full · anúncios   │
                 └───────────────┬────────────────────────────────────────────────────────┘
                                 │
   Issacar (Chrome próprio,      │          Dashboard (Electron + Express)
   fora da tela) ──────────────► │  lib/seven.js ──► /api/seven/*  ──► public/seven.html (SEVEN)
   busca do ML, termo a termo    │  lib/ranking_mt.js (dispara o Issacar, histórico, agenda)
   ranking_issacar_<conta>.json ─┘  lib/feed.js ──► /api/feed ──► public/feed.html (Feed)
```

---

## 2. Feed de estoque (`/feed`)

Arquivos: `lib/feed.js`, `public/feed.html`, rotas `/api/feed` e `/api/feed/assinatura` em `routes/api.js`.

- **Visual:** a capa "Mais urgentes · N decisões" abre em tela cheia (efeito macOS, técnica FLIP); as bolinhas abrem cada fila na sua própria folha; os cards ficam em coluna única, estilo Instagram, com scroll-snap.
- **Hierarquia do card:** ação (manchete) → detalhe → motivo (a prova) → produto → números, cada um com a sua janela de tempo (`metricas: [{ rotulo, valor, nota }]`).
- **Transferência não é estoque:** `disponivel = estoque − transferenciaMl`. Um anúncio com unidades só em transferência recebe "Aguardar a transferência", e não "Reativar".
- **Travado no galpão:** unidades em `internalProcess` (o galpão conferindo e guardando o que chegou) recebem **"Aguardar o ML"**. Só `notSupported`, avariado, sem cobertura fiscal e parecidos recebem "Abrir chamado no ML".
- **Botão Atualizar:** roda a coleta de verdade (`POST /api/atualizar`), mostrando o progresso, e redesenha o Feed.
- **Link para o produto:** o clique no card abre `/painel?chave=...`, que libera os filtros, vai até a página certa, rola até a linha e a destaca (`focarProdutoDaURL` em `public/assets/js/app.js` + `.linha-foco` em `style.css`).
- **Modo SEVEN:** `feed.html?fonte=seven&embed=1` lê `/api/seven/feed` no lugar de `/api/feed`, esconde menu, barra do topo e tarja de reputação, e abre o clique na janela de cima. É assim que as Notícias do SEVEN usam a mesma tela.
- `ehEmpilhadeira(p)` é exportado por `lib/feed.js` e usado pelo SEVEN.

---

## 3. SEVEN (`/seven`)

Arquivos: `public/seven.html` (tela), `lib/seven.js` (dados e planilhas), `lib/ranking_mt.js` (coleta do Ranking ML), rotas `/api/seven/*` em `routes/api.js`, rota `/seven` e agendador em `server.js`. Botão **SEVEN** no menu lateral de todas as telas, logo abaixo de "Renovar Token".

### 3.1 Menu

Um botão ☰ no topo mostra o nome da tela atual; clicando, abre o painel com:

| Botão | O que faz |
|---|---|
| Notícias urgentes | iframe de `/feed?fonte=seven&embed=1` |
| Análise de concorrentes | tabela MP / PC / DF% / RANK NUB (hoje só o MP é preenchido) |
| Análise por tempo de vendas | tabela de comparação mensal + Ranking ML |
| Análise com IA | "Em breve" (fora do escopo por enquanto) |
| Inteligência de estoque | leva ao `/feed` do Dashboard |

No topo: **Recarregar** roda `/api/atualizar` (estoque) e `/api/seven/recarregar` (pedidos de ontem). Uma **tarja vermelha** aparece quando a última coleta do Ranking ML falhou ou ficou incompleta (ver 4.5).

### 3.2 Notícias urgentes (`/api/seven/feed` → `feedSeven()`)

Só **anúncios, a partir do Ranking ML**. Concorrentes entram quando o Nubimetrics for ligado. Estoque fica no Feed; vendas, na tabela.

| Fila | Regra | Peso (R$) |
|---|---|---|
| Fora do ranking | produto descrito por algum termo pesquisado, vendeu no mês anterior e não aparece nas 3 primeiras páginas | vendas do mês × preço |
| Na 1ª página sem venda | Ranking ML na página 1, zero ontem, média ≥ 0,3/dia | média × 30 × preço |
| Quase na 1ª página | Ranking ML na página 2 ou 3 e vendeu no mês anterior | vendas do mês × preço |

A capa junta as 10 mais caras de todas as filas. Sem coleta de ranking, nenhuma fila aparece.

**Coberto:** um anúncio só conta como "fora do ranking" se todas as palavras de algum termo pesquisado estão no título dele (`coberto()` em `lib/seven.js`). Sem essa regra, todo anúncio sem termo parecia estar fora da busca.

### 3.3 Análise por tempo de vendas (`/api/seven/vendas` → `tabelaVendas()`)

- **Ontem:** pedidos não cancelados de ontem (horário de Brasília), pela API de pedidos do ML. Cache: `storage/seven_vendas_ontem.json`.
- **Base de comparação:** o **mês anterior fechado** (hoje, agosto). Pedidos do mês inteiro pela API, buscados uma vez por mês. Cache: `storage/seven_mes_anterior.json`.
- **Situação:** Acima da média (≥ +20%), Na média, Abaixo da média (≤ −20%), Não vendeu, Sem giro (média < 0,2), Sem base no mês (anúncio sem venda no mês anterior, por exemplo criado depois).
- **Ranking ML:** página e posição; "fora" quando o anúncio tem termo mas não apareceu; "—" quando não tem termo.
- **Filtros:** Todos, Não venderam, Acima da média, Abaixo da média, Na média, Rankeados, Sem ranking; busca por SKU ou produto; ordenação por coluna.
- **Anúncios de empilhadeira ficam de fora** (mesma regra do Feed).
- A coluna Meta foi removida (as metas vão para outro dashboard).

### 3.4 Planilhas (`/api/seven/planilha?tipo=vendas|concorrentes`)

Geradas com **ExcelJS** (`planilha()` em `lib/seven.js`): título e resumo no topo, cabeçalho azul congelado com filtro, formatos de número, variação em % colorida, Ranking ML (página, posição, termo) e situação colorida. A biblioteca `xlsx` continua sendo usada só pela Planilha Full.

### 3.5 Rotas `/api/seven/*`

| Rota | Função |
|---|---|
| `GET /seven/feed` | filas das Notícias (formato do Feed) |
| `GET /seven/noticias` | versão antiga em cards (não usada pela tela) |
| `GET /seven/vendas` | tabela de comparação mensal |
| `GET /seven/concorrentes` | tabela de concorrentes |
| `POST /seven/recarregar` | rebusca os pedidos de ontem |
| `GET /seven/planilha` | download do .xlsx formatado |
| `GET /seven/ranking_ml/estado` | coleta rodando? progresso, última coleta |
| `POST /seven/ranking_ml/coletar` | dispara o Issacar |
| `GET /seven/ranking_ml/historico` | últimas 20 coletas |

---

## 4. Ranking ML — Projeto Issacar

### 4.1 Onde fica

| O quê | Caminho |
|---|---|
| Script da coleta de ranking | `C:\Users\Matheus Prata\Desktop\issacar_posicao.py` (backup: `issacar_posicao.py.bak-20260927`) |
| Issacar original (preços de concorrentes) | `C:\Users\Matheus Prata\Desktop\issacar.py` |
| Módulos de apoio (Chrome, CDP) | `C:\Users\Matheus Prata\.dotnet\MLScraper\` (`bot_cdp.py`) |
| Perfil do Chrome do Issacar | `C:\Users\Matheus Prata\.dotnet\MLScraper\perfil_chrome` |
| Termos da Flavia (65, da lista do MT) | `C:\Users\Matheus Prata\Desktop\termos_ranking.txt` |
| Termos da Cordeiro (30, gerados dos anúncios do Full que mais vendem — revisar) | `C:\Users\Matheus Prata\Desktop\termos_ranking_cordeiro.txt` |
| Resultado lido pelo SEVEN | `C:\Users\Matheus Prata\.dotnet\MLScraper\saidas\ranking_issacar_flavia.json` e `..._cordeiro.json` |
| Resultados com data (json/csv) | `C:\Users\Matheus Prata\.dotnet\MLScraper\saidas\posicoes_<conta>_<data>.*` |
| Termos que não deram tempo ou foram barrados | `C:\Users\Matheus Prata\.dotnet\MLScraper\saidas\pendentes.txt` |
| Log da última coleta disparada pelo app | `<storage>\ranking_ml.log` |
| Histórico de coletas (uma linha por coleta) | `<storage>\ranking_ml_historico.jsonl` |
| Estado da coleta (pid, origem, se já foi registrada) | `<storage>\ranking_ml_estado.json` |

### 4.2 Como conta

`--modo-mt` em `issacar_posicao.py`, função `procurar_todos()`:

- pesquisa o termo em `lista.mercadolivre.com.br/<termo>`, até a página 3;
- **pula os patrocinados** e conta **cada anúncio uma vez** (a "outra opção de compra" dentro do card de outro vendedor não conta);
- 50 por página, como a API;
- guarda **todos** os anúncios da conta achados no termo, pelo MLB (lista vinda do `reposicao.json` da conta), com posição geral, página e posição entre os Full;
- o SEVEN fica com a melhor posição de cada anúncio entre todos os termos (`rankingML()` em `lib/seven.js`).

Não reproduz exatamente o Mercado Turbo: o MT provavelmente usa a API de busca (fechada para nós, erro 403), e o site muda a ordem conforme horário e localização. Serve para "está na 1ª página ou fora"; a posição exata pode variar alguns lugares.

### 4.3 Comando que o app roda

```
py -u issacar_posicao.py --arquivo <termos> --conta flavia|cordeiro --modo-mt --max-paginas 3
   --abas 3 --delay-min 1 --delay-max 2 --tempo-max 280 --saida-fixa <ranking_issacar_<conta>.json>
```

Para rodar à mão, use o mesmo comando dentro de `C:\Users\Matheus Prata\Desktop`. Configuração opcional em `<storage>\config.json`: `ranking_ml_pasta`, `ranking_ml_script`, `ranking_ml_termos`, `ranking_ml_arquivo`, `ranking_ml_abas`, `ranking_ml_python`.

### 4.4 Quando roda

- **Semanal:** toda segunda com o app aberto. Flavia a partir das **7h**, Cordeiro a partir das **8h** (as duas usam o mesmo Chrome do Issacar e não podem rodar juntas). Uma vez por dia; se o app abrir mais tarde, roda na abertura.
- **Manual:** botão **Coletar ranking ML** na tela "Análise por tempo de vendas" do SEVEN.
- Leva até 5 minutos (`--tempo-max 280`).

### 4.5 Bloqueio do Mercado Livre e avisos

- Se o ML pedir verificação, o Issacar **para no 2º bloqueio** e **não tenta passar**.
- **Uma coleta barrada não apaga o ranking bom:** termos que não foram pesquisados mantêm o resultado anterior. Se nenhum termo passar, o arquivo não é tocado.
- Ao terminar, `lib/ranking_mt.js` lê o log e grava no histórico: `{ inicio, fim, origem, status: ok|parcial|falhou, motivo, total, pesquisados, barrados }`. Se o status for `parcial` ou `falhou`, dispara uma **notificação do Windows** e mostra a **tarja vermelha no SEVEN**, com "ver histórico".
- Rodar várias coletas seguidas (ou muitas abas) aumenta o bloqueio. Ele fica no perfil do Chrome do Issacar e costuma passar em algumas horas ou até o dia seguinte. Recomendação: uma coleta por dia, no máximo.

---

## 5. Bot do Mercado Turbo (pasta `bot_precos`)

`C:\Users\Matheus Prata\Documents\business_Intelligence\bot_precos\` — **não é mais usado pelo SEVEN** (a coleta passou para o Issacar), mas continua funcionando.

- `rodar_ranking_background.ps1` agora chama `ranking_mercadoturbo_bg.py` (segundo plano, sem roubar foco) com o terminal escondido. Backup: `rodar_ranking_background.ps1.bak-20260927`.
- `ranking_mercadoturbo_bg.py`: ao abrir uma janela nova do MT, manda para trás logo em seguida; ganhou `--parte/--partes/--janela/--limite`. Backup: `.bak-20260927`.
- `ranking_paralelo.py`: teste com várias janelas em paralelo. **O MT faz uma busca por vez por login**; com mais de uma janela as buscas falham ou travam.
- Precisa do Chrome com a acessibilidade ligada (`chrome://accessibility` → Web accessibility, ou Chrome aberto com `--force-renderer-accessibility`).
- Uma coleta completa pelo MT leva ~1h20.

---

## 6. Avisos globais e Novidades

- `avisos_globais.json` (repositório ML, branch master): lido pelos dois apps direto do GitHub, sem nova versão. Hoje: **Projeto Issacar** e **Horizon Engine**. O arquivo do repositório da Cordeiro é mantido igual, mas não é lido.
- `novidades.json` (em cada repositório): notas por versão. As da **1.9.52 / 1.6.59** falam do SEVEN, do Ranking ML e do Feed.

---

## 7. Versões

| Versão | O que levou |
|---|---|
| ML 1.9.51 / Cordeiro 1.6.57–1.6.58 | Feed novo (capa, filas em tela cheia, ação em primeiro); 1.6.58 corrigiu o Feed da Cordeiro |
| ML 1.9.52 / Cordeiro 1.6.59 | SEVEN, Ranking ML pelo Issacar, internalProcess = aguardar, Atualizar do Feed, Novidades |
| próxima (não publicada) | Notícias só com anúncios, regra de "coberto", planilhas formatadas, menu hambúrguer, histórico e aviso de falha da coleta |

Publicação: `npx electron-builder --win --x64 --publish never`, renomear para o nome com hífens, `gh release create vX.Y.Z <exe> <blockmap> latest.yml`, e conferir os 3 arquivos e a tag (detalhes em `DOCUMENTACAO.md`, seção 5).

---

## 8. Pendências

- **Nubimetrics:** preencher PC, DF% e RANK NUB na tabela de concorrentes e criar a fila de Concorrentes nas Notícias.
- **Publicar** a próxima versão das duas contas, com uma nota nas Novidades.
- **Revisar os termos da Cordeiro** (`termos_ranking_cordeiro.txt`), gerados automaticamente.
- **Primeira coleta de ranking da Cordeiro:** ainda não houve (o ML estava bloqueando).
- **Análise com IA:** em espera.
