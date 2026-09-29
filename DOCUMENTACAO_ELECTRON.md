# Dashboard ML — como o app Electron é feito e como os updates sobem

Vale para os dois apps:

| | Flavia Stock | Cordeiro Car |
|---|---|---|
| Pasta | `C:\laragon\www\dashboard-ml-electron` | `C:\laragon\www\dashboard-cordeiro-electron` |
| Nome / appId | Dashboard ML · `com.thebigmath.dashboard-ml` | Dashboard Cordeiro · `com.thebigmath.dashboard-cordeiro` |
| Porta local | 3001 | 3002 |
| Dados do usuário | `%APPDATA%\dashboard-ml\storage` | `%APPDATA%\dashboard-cordeiro\storage` |
| Repositório / releases | github.com/Thebigmath/dashboard-ml-electron | github.com/Thebigmath/dashboard-cordeiro-electron |
| Versão (29/09/2026) | 1.9.54 | 1.6.61 |

A Cordeiro é uma cópia da Flavia: mesmas telas e rotinas, mudando só nome, porta, conta do ML e o que é "só leitura" (Ranking ML e Astra são coletados pelo app da Flavia).

---

## 1. Como o app é montado

O app é um **site local embrulhado numa janela**:

```
Electron (main.js)
  ├─ sobe o servidor Express (server.js) em localhost:3001
  │     ├─ /api/*   → routes/api.js  (fala com o Mercado Livre e lê os arquivos)
  │     ├─ /auth/*  → routes/auth.js (token do ML)
  │     └─ páginas  → public/*.html  (Feed, Painel, SEVEN, Frete, Avisos…)
  └─ abre uma janela (BrowserWindow) apontando para http://localhost:3001
```

### Arquivos principais
| Arquivo | Papel |
|---|---|
| `main.js` | Processo principal do Electron: janela, bandeja, notificações, início com o Windows e **atualização automática**. |
| `preload.js` | Ponte segura entre a página e o Electron (`window.electronAPI`): avisar update, instalar update, abrir link externo. |
| `server.js` | Servidor Express com as rotas e as páginas. |
| `routes/` | APIs do app. |
| `lib/` | Regras de negócio: token, feed, frete, SEVEN, Ranking ML, Astra, IA… |
| `public/` | Telas (HTML/CSS/JS). |
| `storage/` | Arquivos iniciais (config, usuários, custos) copiados para o `%APPDATA%` na primeira abertura. |
| `novidades.json` | Texto que aparece em "Novidades" a cada versão. |
| `avisos_globais.json` | Avisos globais (ex.: Projeto Issacar, Horizon). |

### Comportamento do app (main.js)
- **Uma instância só:** abrir de novo só traz a janela de volta (não sobe outro servidor na mesma porta).
- **Dados fora do instalador:** tudo o que muda (token, coletas, históricos) fica em `%APPDATA%\...\storage`. Atualizar o app **não apaga** esses dados. Na primeira abertura os arquivos iniciais são copiados; nas próximas, só chaves novas do `config.json` são mescladas.
- **Bandeja:** fechar no X esconde a janela; o servidor, o monitor de frete e as coletas continuam rodando. Sair de verdade é pelo menu da bandeja.
- **Abre com o Windows** (só no app instalado), escondido na bandeja (`--segundo-plano`).
- **Notificações do Windows** para avisos (frete, reputação, coleta que falhou); clicar abre a tela certa.
- **Segurança da janela:** `contextIsolation: true` e `nodeIntegration: false` — a página não tem acesso direto ao Node.

### Configuração de empacotamento (`package.json` → `build`)
- Ferramenta: **electron-builder**, alvo **NSIS** (instalador `.exe` do Windows, x64).
- Instalador não é "um clique": deixa escolher a pasta, cria atalho na Área de Trabalho e no Menu Iniciar.
- `asar: true`: o código vai empacotado num arquivo só dentro do app.
- `files`: o que entra no app (main, preload, server, rotas, lib, public, node_modules, storage inicial). **Não entram**: arquivos de teste (`start-teste.js`, `start-real-3911.js`), a pasta `dist` nem dados do `%APPDATA%`.
- `publish`: provedor **GitHub** (dono `Thebigmath`, repositório do app) — é daí que o app instalado busca as atualizações.

### Rodar em desenvolvimento
```bash
npm start
```
Abre o Electron usando o código da pasta. Para testar só o servidor com os dados reais, sem abrir outra janela, usamos um servidor de teste na porta 3911 (`start-real-3911.js`), que lê o `%APPDATA%` do app.

---

## 2. Como a atualização chega no usuário (electron-updater)

1. **Quando verifica:** 5 s depois de abrir, a cada **30 minutos** (o app vive na bandeja) e ao mostrar a janela (no máximo a cada 5 min).
2. **Onde verifica:** no **último release do GitHub** do app, lendo o arquivo `latest.yml`.
3. **Se tem versão nova:** baixa sozinho em segundo plano (`autoDownload = true`) usando o `.blockmap` (baixa só o que mudou quando possível).
4. **Quando instala:**
   - o app avisa na tela e por notificação ("atualização pronta") — clicar instala e reabre; ou
   - instala sozinho quando o app é fechado pela bandeja (`autoInstallOnAppQuit = true`).
5. Os dados do `%APPDATA%` ficam intactos; na primeira abertura da versão nova, as "Novidades" mostram o texto do `novidades.json`.

**Conclusão:** para o usuário receber, basta existir no GitHub um release com os **3 arquivos certos**: o `.exe`, o `.exe.blockmap` e o `latest.yml` com a versão nova.

---

## 3. Como eu subo uma versão (passo a passo)

> Sempre as duas contas juntas quando a mudança vale para as duas (Flavia e Cordeiro precisam ficar iguais).

### 3.1 Antes de buildar
1. **Conferir Flavia × Cordeiro:** comparar os arquivos mudados entre as duas pastas. Diferenças esperadas: nome, porta, conta, e o que é só leitura na Cordeiro.
2. **Tirar do build o que não deve ir** (ex.: a Análise com IA enquanto está em teste). O build usa o que está **na pasta**, não o que está commitado.
3. **Versão:** subir o número em `package.json` (`"version"`), ex.: 1.9.54 → 1.9.55 e 1.6.61 → 1.6.62.
4. **Novidades:** adicionar a entrada no topo do `novidades.json` (versão, data, título, texto).
5. **Commit e push** para o GitHub **antes** de criar o release (a tag aponta para o commit publicado).

### 3.2 Build (um app de cada vez)
```bash
npx electron-builder --win --x64 --publish never
```
Gera em `dist\`:
- `Dashboard ML Setup 1.9.55.exe` (instalador)
- `Dashboard ML Setup 1.9.55.exe.blockmap`
- `latest.yml` (aponta para `Dashboard-ML-Setup-1.9.55.exe`, com hífens)

Usamos `--publish never` de propósito: com `--publish always` o electron-builder às vezes cria o release **sem o `latest.yml`**, e aí ninguém recebe o update.

### 3.3 Acertar o nome e publicar
O `latest.yml` espera o nome com **hífens**, então renomeamos antes de subir:
```bash
mv "dist/Dashboard ML Setup 1.9.55.exe" dist/Dashboard-ML-Setup-1.9.55.exe
mv "dist/Dashboard ML Setup 1.9.55.exe.blockmap" dist/Dashboard-ML-Setup-1.9.55.exe.blockmap
gh release create v1.9.55 dist/Dashboard-ML-Setup-1.9.55.exe dist/Dashboard-ML-Setup-1.9.55.exe.blockmap dist/latest.yml --title "v1.9.55" --notes "o que mudou"
```
Na Cordeiro é igual, com `Dashboard Cordeiro Setup` / `Dashboard-Cordeiro-Setup` e a tag `v1.6.62`.

### 3.4 Conferir
- O release no GitHub tem os **3 arquivos** (`.exe`, `.blockmap`, `latest.yml`).
- `latest.yml` mostra a versão nova.
- Abrir o app instalado: em alguns minutos aparece "atualização pronta".

### 3.5 Limpeza
Os instaladores antigos ficam publicados no GitHub; a cópia local em `dist\` pode ser apagada depois de conferir que o release existe. Cada build precisa de ~2 GB livres no disco C:.

---

## 4. Problemas que já aconteceram (e como evitar)

| Problema | Causa | Como evitar |
|---|---|---|
| Release sem `latest.yml`, ninguém atualiza | `--publish always` do electron-builder | Buildar com `--publish never` e subir com `gh release create` |
| Cordeiro saiu com tela antiga (1.6.57) | Arquivo não copiado da Flavia | Comparar as duas pastas antes de publicar |
| Build falhou "out of memory" | Dois builds ao mesmo tempo | Buildar um app de cada vez |
| Build falhou "no space left on device" | Disco C: cheio | Apagar instaladores antigos de `dist\` (já estão no GitHub) |
| Update quebrou o auto-update | Mudança fora do escopo junto com a versão | Publicar só o que foi pedido e testado |
| `server.js` vazio num commit | Script abriu o arquivo para escrever antes de ler | Restaurado do commit anterior; conferir `git diff --stat` antes de commitar |

---

## 5. Resumo em uma linha
**Mudo o código → testo no servidor de teste → sobo a versão e as novidades → commit e push → build com `--publish never` (um de cada vez) → renomeio com hífens → `gh release create` com `.exe` + `.blockmap` + `latest.yml` → o app instalado baixa e instala sozinho.**
