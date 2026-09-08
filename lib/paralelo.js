// Primitivas de concorrencia para as chamadas ao Mercado Livre.
//
// O motor gastava a maior parte do tempo esperando resposta, nao processando:
// as paginas de pedidos vinham uma de cada vez, cada uma ~230 ms de ida e volta.
// Aqui ficam as tres pecas que resolvem isso, mais o freio que evita trocar
// lentidao por erro 429.

/**
 * Executa `fn` sobre `itens` com no maximo `limite` chamadas simultaneas.
 * Preserva a ordem do resultado. Um Promise.all solto dispara tudo de uma vez
 * (o motor chegava a abrir 340 conexoes de inventories), o que rende 429 e,
 * pior, silencio: a chamada falhada caia no fallback sem ninguem perceber.
 */
async function mapaLimitado(itens, limite, fn) {
    const lista = [...itens];
    const saida = new Array(lista.length);
    let proximo = 0;

    const trabalhador = async () => {
        while (true) {
            const i = proximo++;
            if (i >= lista.length) return;
            saida[i] = await fn(lista[i], i);
        }
    };

    const n = Math.max(1, Math.min(limite, lista.length));
    await Promise.all(Array.from({ length: n }, trabalhador));
    return saida;
}

/**
 * Repete `fn` quando o ML responde 429 (rate limit) ou 5xx, com espera
 * exponencial e jitter. O jitter importa: sem ele as chamadas que tomaram 429
 * juntas voltam juntas e tomam 429 de novo, em fase.
 * Erros 4xx que nao sao 429 nao sao tentados de novo — nao adianta insistir
 * num 404 ou num 403.
 */
async function comBackoff(fn, { tentativas = 4, baseMs = 350, aoRepetir = null } = {}) {
    let ultimoErro;
    for (let t = 0; t < tentativas; t++) {
        try {
            return await fn();
        } catch (err) {
            ultimoErro = err;
            const status = err.response && err.response.status;
            const valeTentar = status === 429 || status === undefined || (status >= 500 && status < 600);
            if (!valeTentar || t === tentativas - 1) throw err;
            const espera = baseMs * Math.pow(2, t) + Math.random() * baseMs;
            if (aoRepetir) aoRepetir(t + 1, status, espera);
            await new Promise(r => setTimeout(r, espera));
        }
    }
    throw ultimoErro;
}

/**
 * Pagina um endpoint de busca do ML sem esperar pagina por pagina.
 *
 * A primeira chamada e obrigatoriamente sozinha, porque e ela que revela
 * `paging.total` — so depois de saber o total da para pedir o resto de uma vez.
 *
 * `buscarPagina(offset)` deve devolver a resposta crua da API.
 * `extrair(data)` devolve o array de resultados daquela pagina.
 */
async function paginarEmParalelo({ buscarPagina, extrair, limite = 50, concorrencia = 8, aoProgredir }) {
    const primeira = await comBackoff(() => buscarPagina(0));
    const total = (primeira.paging && primeira.paging.total) || 0;
    let itens = extrair(primeira);

    const offsets = [];
    for (let o = limite; o < total; o += limite) offsets.push(o);

    if (aoProgredir) aoProgredir(itens.length, total);

    let prontas = 0;
    const paginas = await mapaLimitado(offsets, concorrencia, async (offset) => {
        const data = await comBackoff(() => buscarPagina(offset));
        prontas++;
        if (aoProgredir) aoProgredir(Math.min(total, (prontas + 1) * limite), total);
        return extrair(data);
    });

    for (const p of paginas) itens = itens.concat(p);
    return { itens, total };
}

module.exports = { mapaLimitado, comBackoff, paginarEmParalelo };
