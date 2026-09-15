# Dashboard ML — Documentação

Dois apps irmãos, mesmo código, contas diferentes do Mercado Livre:

| App | Pasta | Porta | Repositório | Versão atual |
|---|---|---|---|---|
| **Flavia Stock** (Dashboard ML) | `C:\laragon\www\dashboard-ml-electron` | 3001 | `Thebigmath/dashboard-ml-electron` | 1.9.39 |
| **Cordeiro Car** (Dashboard Cordeiro) | `C:\laragon\www\dashboard-cordeiro-electron` | 3002 | `Thebigmath/dashboard-cordeiro-electron` | 1.6.45 |

Toda mudança é feita nos dois. As diferenças são só de identidade (nome, cor grafite na Cordeiro, categoria Empilhadeira na Cordeiro) e de dados.

---

## 1. Como o app funciona

**Electron + Express.** O `main.js` abre a janela e sobe um servidor Express local (`server.js`) que serve as telas (`public/*.html`) e a API (`routes/api.js`). A tela conversa com o servidor por `fetch('/api/...')`.

**Dados ficam por computador**, em `%APPDATA%\dashboard-ml\storage\` (Cordeiro: `dashboard-cordeiro`):

| Arquivo | O que é |
|---|---|
| `config.json` | client_id/secret do app ML, `dias_coleta`, `dias_alvo`, caminho da planilha de custos, dados do "outro app" |
| `token.json` | access/refresh token do ML (renovado pelo app — não compartilhar com outro programa, o ML invalida o anterior) |
| `reposicao.json` | resultado da última coleta: uma linha por produto |
| `envios_full.json` | envios ao Full cadastrados (trânsito) |
| `custos.json` | custo por SKU (Valor do Estoque) |
| `estrelas.json` | chaves dos produtos marcados com estrela |
| `faturamento_mensal.json` | cache do faturamento por mês |
| `frete_tabela.json`, `frete_mudancas.json`, `frete_vendas.json`, `frete_config.json` | monitor de frete |
| `novidades_estado.json` | qual versão de novidades já foi vista/avisada |
| `avisos_sku.json`, `ultima_atualizacao.txt`, `uploads/` | avisos de SKU, hora da coleta, uploads temporários |

**Importante:** nada disso sincroniza entre PCs. Dois computadores com o app têm envios, custos e estrelas independentes (só a coleta do ML é igual). Ver "Pendências".

---

## 2. A coleta (motor) — `POST /api/atualizar`

Roda ao abrir o app (se a última coleta tem mais de 10 min, com a barra de carregamento) e no botão **Atualizar Estoque**. Em paralelo (`lib/paralelo.js`: `mapaLimitado`, `comBackoff`, `paginarEmParalelo`), ~5 s na Flavia e ~3 s na Cordeiro:

1. **Pedidos** dos últimos 30 dias (`/orders/search`), sem cancelados → vendas e faturamento por SKU / anúncio / variação.
2. **Anúncios** ativos + encerrados (`/users/{id}/items/search`, scan) → detalhes em lotes de 20 (`/items`).
3. **Estoque Full** (`/inventories/{inventory_id}/stock/fulfillment`): `available_quantity` + unidades em `transfer` (transferência entre galpões). Não conta `lost`, `withdrawal`, `internalProcess`, `noFiscalCoverage`.
4. **Montagem das linhas** (`porSku`): uma por produto; anúncio com variações vira uma linha por variação. SKU repetido em produtos diferentes ganha rótulo (`020tb-pulse`, `020tb-fastback`). `chave` é o identificador único da linha; `inventory_id` é o "Código ML" do galpão.
5. **Cálculo** (fórmula Magico): `mediaDia = vendas30/30`, `cobertura = estoque/mediaDia`, `reposicao = max(0, (dias_coleta + dias_alvo) × mediaDia − estoque)` (pausados usam só `dias_alvo`). Na tela: **Qtd Full = Reposição − Em Trânsito**.

### Full × Fora do Full (corrigido em 15/09/2026, v1.9.37)
Só é Full quem tem `shipping.logistic_type === 'fulfillment'` **e** `inventory_id`. Anúncio que **saiu** do Full continua com `inventory_id` no ML e o galpão responde 0 — antes o app tratava "tem inventory_id" como Full e mostrava 84 produtos (Flavia) / 8 (Cordeiro) como Full com estoque 0. Agora esses ficam em **Fora do Full** com o estoque do anúncio (`available_quantity`) e sem Código ML.

Verificação feita contra o ML ao vivo: Flavia 266 Full + 502 fora, Cordeiro 122 + 348, nenhum anúncio ativo sem linha.

### Trânsito — `GET /api/dados`
Soma dos envios abertos de `envios_full.json` (não arquivados e com `recebido < unidades`), por Código ML quando o envio tem (`codigos`), senão por SKU. Desconta `transferenciaMl` (o ML já contou aquelas unidades). **A API do ML não expõe o status de envio ao Full** (todas as rotas testadas dão 404/403), então o fechamento automático nunca acontece: envio só sai do trânsito quando alguém preenche **Recebido** ou **Arquiva** na tela Envio Full. Envio esquecido "Pendente" desconta unidades fantasmas da reposição.

---

## 3. Telas

### Painel de Controle (`/`)
- Estratégia de reposição (dias até coleta / dias alvo), faturamento mensal, avisos de SKU.
- **Categorias** (menu de três pontinhos, abre na horizontal): Todos · Peças Auto · **Retrovex** (título com "retrovisor") · **Fitam** (título com "farol"/"faróis" ou "pisca", exceto empilhadeira) · Fora do Full · ★ Estrela · Filtros. Cordeiro tem também Empilhadeira. Retrovex/Fitam mostram só produtos do Full, como as outras categorias.
- Coluna **Qtd Full** editável; **setinha no cabeçalho** ordena maior → menor → (clique de novo) menor → maior → ordem normal.
- **Estrela** por produto (marcação manual, `estrelas.json`).
- **Caixa de seleção flutuante** (arrastável pelo topo; duplo clique volta ao lugar): gerar planilha Full / txt dos selecionados.
- **Planilha Full**: formato que o ML aceita (aba "Dados Mercado Livre", coluna A SKU real, C Código ML, D item_id, E variação, F quantidade, a partir da linha 6).
- Barra de carregamento na abertura enquanto a coleta roda.

### Envio Full (`/envio_full`)
Cadastro dos envios (número, unidades, SKUs/Códigos ML, recebido), upload do PDF do ML. Status Pendente / Parcial / Recebido; Arquivar; Excluir.

### Valor do Estoque (`/valor_estoque`)
Custo por SKU × estoque. Custos vêm de:
- **Sincronizar Planilha**: lê o `.xlsx` configurado em `config.planilha_custos` (hoje `Desktop\ALL TIME\estoqueall(Ollie)\planilha de custos .xlsx`, de julho/2026).
- **Upload Manual**: `.xlsx`/`.csv` com colunas **SKU** e **CUSTO** (o CSV exportado `atributos-produtos.csv` funciona).

Corrigido em 14/09/2026: a leitura perdia a vírgula decimal (`181,44` virava `18144`) e o total ficava 100× maior (R$ 3,3 mi em vez de R$ 252 mil). O parser entende `181,44`, `1.320,36`, `1,320.36`, `R$ 1.700,00`, `3500.00`; PDF ou planilha sem as colunas dá erro claro; a tela avisa quando um custo muda mais de 50× (sinal de vírgula perdida). O xlsx de julho tem 4 células gravadas sem vírgula (901290836, 580061342, sb277, sb278) — sincronizar por cima do CSV recorrompe esses 4; o app avisa.

### Frete (`/frete`) — monitor do frete que o vendedor paga
Porte dos scripts do Jordan (`bot_precos/frete_monitor.py` e `frete_pedidos.py`, README_FRETE.md) para dentro do app (`lib/frete.js`):
- **Tabela por anúncio**: `/users/{id}/shipping_options/free?item_id=` → custo (`list_cost`) e peso cobrado de cada anúncio ativo. Snapshot em `frete_tabela.json`; diferença para o anterior vira registro em `frete_mudancas.json` e aviso.
- **Custo por venda**: `/shipments/{id}` + `/shipments/{id}/costs` → o que o ML cobrou de nós em cada envio (`senders[0].cost`), tabela cheia, desconto, destino, logística. Histórico incremental em `frete_vendas.json` (primeira carga: 30 dias). A última venda de cada anúncio é comparada com a anterior (só vendas "limpas": 1 item, 1 unidade, mesma logística).
- **Agendador**: 90 s depois de abrir e de hora em hora; a tabela só a cada 12 h (configurável). Não roda junto com a coleta.
- **Avisos** (chaves na tela): tabela mudou · venda com frete diferente da anterior · toda venda nova (desligado por padrão). Botões Verificar agora e Testar aviso.

### Novidades (`/novidades`)
Notas por versão em `novidades.json` (raiz do app, vai no instalador): título, texto, **vídeo** (link do YouTube vira player; `.mp4` vira `<video>`) e imagens. Contador de versões não vistas no menu; "Marcar tudo como visto". Ao atualizar, 8 s depois de abrir sai a notificação "Versão X instalada — …" (só em atualização, não em instalação nova).

Para publicar uma novidade: editar `novidades.json` (versão, data, título, texto, `video`, `imagens`) e soltar a versão.

---

## 4. Notificações, bandeja e início com o Windows (v1.9.35+)

- **Notificação nativa do Windows** (`lib/notificar.js` → `main.js`, `Notification` do Electron; `app.setAppUserModelId` obrigatório). Clicar traz a janela e abre a rota (ex.: `/frete`).
- **Bandeja**: ícone ao lado do relógio (`public/assets/img/tray.png`). O **X esconde** a janela; o servidor e o monitor continuam. Menu: Abrir · Frete: verificar agora · Sair. Duplo clique abre.
- **Inicia com o Windows** escondido (`--segundo-plano`), registrado pela versão instalada na primeira abertura. Instância única: abrir o atalho com o app na bandeja só traz a janela.
- Atualização automática (electron-updater, GitHub releases): verifica 5 s depois de abrir; instala quando o usuário aceita na barra lateral (o app reinicia).

---

## 5. Publicar uma versão

Ordem obrigatória (ver memória "race no publish"):

```bash
git push origin master                 # ANTES da release: a tag nasce do HEAD que está no GitHub
npm version X.Y.Z --no-git-tag-version && git commit -am "vX.Y.Z" && git push
npx electron-builder --win --x64 --publish never
# renomear "Dashboard ML Setup X.Y.Z.exe" -> "Dashboard-ML-Setup-X.Y.Z.exe" (+ .blockmap), conferir size/sha512 com latest.yml
gh release create vX.Y.Z Dashboard-ML-Setup-X.Y.Z.exe Dashboard-ML-Setup-X.Y.Z.exe.blockmap latest.yml --repo Thebigmath/dashboard-ml-electron
```

Sempre conferir: 3 assets, `size`/`sha512` do `latest.yml` batendo com o exe, tag no commit certo. Nunca `--publish always` (race que deixa a release sem `latest.yml`). Apagar instaladores antigos de `dist/` — em 14/09 o disco chegou a 100% por causa deles.

---

## 6. Histórico recente

| Data | Flavia | Cordeiro | O quê |
|---|---|---|---|
| 07/09 | 1.9.32 | 1.6.38 | Produtos estrela, filtro Retrovisores, caixa de seleção flutuante; Cordeiro com visual da Flavia (grafite) |
| 08/09 | 1.9.33 | 1.6.39 | Coleta paralela (13 s → 5 s), barra de carregamento na abertura |
| 08/09 | 1.9.34 | 1.6.40 | Categorias no menu de três pontinhos |
| 14/09 | 1.9.35 | 1.6.41 | Monitor de frete + notificações do Windows + bandeja + início com o Windows; custos com vírgula decimal |
| 14/09 | 1.9.36 | 1.6.42 | Tela de Novidades |
| 15/09 | 1.9.37 | 1.6.43 | Full só quem está no Full (84/8 produtos reclassificados) |
| 15/09 | 1.9.38 | 1.6.44 | Categorias Retrovex e Fitam |
| 15/09 | 1.9.39 | 1.6.45 | Setinha na Qtd Full; pisca-seta no Fitam |

Verificações feitas em 15/09 (contra o ML ao vivo): estoque Full idêntico ao galpão (336/346 na Flavia; as 10 diferenças eram vendas das 3 h seguintes), Full × Fora do Full sem mistura, trânsito da Flavia zerado depois de marcar os 4 envios como recebidos.

---

## 7. Pendências conhecidas

1. **Envios fantasmas**: como a API não fecha envio, um envio esquecido em Pendente desconta unidades para sempre. Proposta: aviso na tela + notificação "envio #X está há N dias aberto — já chegou?".
2. **Registros de exemplo no instalador**: `storage/envios_full.json` do repositório traz "TRANSIT-MAGIIC-05082026-…" (placeholders de 05/08) que são injetados em toda instalação. Tirar.
3. **Sincronização entre PCs**: envios, custos, estrelas e config do frete são locais. Proposta: pasta compartilhada (OneDrive) para esses arquivos.
4. **Planilha de custos de julho** com 4 células sem vírgula (ver Valor do Estoque); preferir o CSV exportado.
5. **Vídeos das novidades**: estrutura pronta, faltam os vídeos/imagens de cada versão.
6. Ainda abertos de antes: estoque no galpão do vendedor (82 Flavia + 22 Cordeiro) não exibido; `tap-50` under_review; SKU `66064de-par` mal formado.
