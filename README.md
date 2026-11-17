# Leve — páginas mais leves

Extensão para Chrome (e navegadores baseados em Chromium) que corrige, do lado do usuário,
problemas que o [GreenIT-Analysis](https://github.com/cnumr/GreenIT-Analysis)
aponta nos sites. O GreenIT **mostra** o que está pesado; a Leve **age** sobre isso.

| O que faz | Como |
| --- | --- |
| **Usuário escolhe baixar imagem** | Nenhuma imagem é baixada ao abrir a página. Cada uma vira um espaço reservado; ao clicar, só aquela é baixada. Passar o mouse mostra quanto ela pesa. |
| **Imagens sem resize** | Detecta imagens maiores do que o espaço em que aparecem (a regra "não redimensionar imagens no navegador" do GreenIT) e passa a baixá-las já no tamanho exibido. |
| **Limpar cache automaticamente** | Limpa o cache ao abrir o navegador e/ou em intervalos (15 min, 1 h, 6 h, 24 h), além do botão "Limpar agora". |

## Instalar (modo desenvolvedor)

1. Baixe ou clone este repositório.
2. Abra `chrome://extensions`.
3. Ligue o **Modo do desenvolvedor** (canto superior direito).
4. Clique em **Carregar sem compactação** e escolha a pasta do repositório (a que contém `manifest.json`).

O ícone da folha aparece na barra; o número sobre ele é a quantidade de imagens não baixadas na página.

## Usar

Clique no ícone para abrir o painel:

- **Interruptor ao lado do nome do site** — desliga a extensão só naquele site.
- **Escolher quais imagens baixar** — ligado por padrão. "Baixar todas as imagens nesta aba" libera a aba atual até ela ser fechada.
- **Corrigir imagens sem resize** — desligado por padrão (veja "Privacidade").
- **Limpar cache automaticamente** — ao abrir o navegador (ligado por padrão) e/ou em intervalos.
- **Avançado** — nitidez em telas de alta densidade, endereço do serviço de redimensionamento e botão para esquecer as imagens memorizadas.

### Como a correção de "imagens sem resize" funciona

O navegador não consegue encolher uma imagem antes de baixá-la; quem faz isso é um serviço de
redimensionamento (por padrão o [wsrv.nl](https://wsrv.nl), de código aberto), que entrega a imagem
na largura pedida.

- **Com "escolher imagens" ligado:** ao clicar no espaço reservado, a extensão já sabe a largura que a
  página reserva e baixa a imagem direto nesse tamanho.
- **Sem bloqueio:** na primeira visita a extensão mede cada imagem (tamanho do arquivo × tamanho exibido)
  e memoriza as que estão grandes demais. A partir da visita seguinte, o pedido dessas imagens é
  redirecionado para o serviço, na largura certa — a original nem chega a ser baixada.
- Se o serviço falhar para alguma imagem, a extensão volta a usar a original.

Para conferir com o GreenIT: analise a página, ligue a correção, recarregue duas vezes e analise de novo.
O GreenIT compara com pixels CSS; em telas de alta densidade, desligue "Manter nitidez em telas de alta
densidade" (em Avançado) para zerar o aviso.

## Privacidade

- A extensão não coleta nem envia dados para os autores.
- **Corrigir imagens sem resize** é opcional porque o serviço de redimensionamento recebe o endereço das
  imagens corrigidas (não o da página). Imagens de endereços locais/privados nunca são enviadas. Em
  Avançado é possível apontar para um serviço próprio (qualquer um que aceite `{url}` e `{w}` no endereço).
- Para mostrar o peso de uma imagem ao passar o mouse, a extensão faz um pedido `HEAD` (só cabeçalhos, sem cookies).

## Limitações conhecidas

- O bloqueio vale para todas as imagens, inclusive as de fundo (CSS), que não ganham espaço reservado.
  Use "Baixar todas as imagens nesta aba" ou desligue a extensão no site quando elas fizerem falta.
- Enquanto uma imagem escolhida carrega, a aba fica liberada por um instante; outra imagem pedida pela
  página exatamente nesse momento pode passar.
- Imagens com `srcset`/`<picture>`, SVG e GIF não são redimensionadas (o navegador já escolhe o tamanho,
  ou o formato não se beneficia).
- Limpar o cache libera espaço em disco, mas faz o navegador baixar tudo de novo na visita seguinte.
  Use intervalos curtos só se esse for o objetivo (por exemplo, para medir sites com o GreenIT sempre a frio).

## Estrutura

```
manifest.json          manifesto (Manifest V3)
src/background.js      service worker: regras de rede, limpeza de cache, imagens memorizadas
src/content.js         roda nas páginas: espaços reservados, clique para baixar, medição das imagens
src/content.css        estilo dos espaços reservados
src/popup/             painel da extensão
icons/                 ícones (gerados de icons/icon.svg com `npm run icons`)
test/e2e.js            teste de ponta a ponta com Chromium real
```

## Testar

```bash
npm install
```

```bash
npx playwright install chromium
```

```bash
npm test
```

O teste sobe um servidor local com uma página de exemplo e uma imitação do serviço de redimensionamento,
carrega a extensão no Chromium e confere o que foi — e o que não foi — baixado em cada cenário.
