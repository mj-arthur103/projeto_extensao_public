// Teste de ponta a ponta: carrega a extensão num Chromium de verdade e confere,
// contra um servidor local, o que foi (e o que não foi) baixado.
//
//   npm test            (precisa do Playwright: npm install && npx playwright install chromium)
//
// site.test  -> página de exemplo e imagens originais
// proxy.test -> imitação do serviço de redimensionamento
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { chromium } = require('playwright');

const EXTENSION = path.join(__dirname, '..');
const SHOTS = process.env.LEVE_SHOTS || '';

// ------------------------------------------------------------------ servidor

function png(w, h) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8 bits, RGB
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set([47 + ((x * 80) / w) | 0, 125, 79 + ((x * 120) / w) | 0], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>Página de teste</title>
<style>body{font:14px sans-serif;margin:16px} img{margin:4px;vertical-align:top} #b{width:250px}</style>
<h1>Página de teste</h1>
<a href="/outra"><img id="a" src="/img/a.png?w=1200&h=800" width="300" height="200" alt="a"></a>
<img id="b" src="/img/b.png?w=1000&h=500" alt="b">
<img id="c" src="/img/c.png?w=200&h=100" alt="c">
<img id="r" src="/redir?to=%2Fimg%2Fr.png%3Fw%3D120%26h%3D120" alt="r">
<img id="s" src="/img/s0.png?w=400&h=200" srcset="/img/s1.png?w=400&h=200 1x, /img/s2.png?w=800&h=400 2x" width="400" height="200" alt="s">
<img id="f" src="/img/fail.png?w=900&h=600" width="150" height="100" alt="f">
<script src="/cached.js"></script>`;

const log = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const host = url.hostname;
  if (req.method === 'GET' && url.pathname !== '/favicon.ico') log.push(`${host}${url.pathname}${url.search}`);
  const image = (w, h) => {
    const body = png(w, h);
    res.writeHead(200, {
      'content-type': 'image/png',
      'content-length': body.length,
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  if (host === 'proxy.test') {
    const orig = new URL(url.searchParams.get('url'));
    if (orig.pathname.includes('fail')) return res.writeHead(500).end();
    const w = Number(url.searchParams.get('w'));
    const ow = Number(orig.searchParams.get('w'));
    const oh = Number(orig.searchParams.get('h'));
    return image(Math.min(w, ow), Math.max(1, Math.round((oh * Math.min(w, ow)) / ow)));
  }
  if (url.pathname.startsWith('/img/')) return image(Number(url.searchParams.get('w')), Number(url.searchParams.get('h')));
  if (url.pathname === '/redir') return res.writeHead(302, { location: url.searchParams.get('to') }).end();
  if (url.pathname === '/cached.js') {
    return res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'max-age=3600' }).end('/* ok */');
  }
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }).end(PAGE);
});

// ------------------------------------------------------------------ apoio

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? '  ok ' : 'FALHA'}  ${name}${ok ? '' : `  ${detail}`}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, what, timeout = 8000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(100);
  }
  throw new Error(`tempo esgotado: ${what}`);
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const site = `http://site.test:${port}`;
  const proxyTemplate = `http://proxy.test:${port}/resize?url={url}&w={w}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'leve-'));

  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 900, height: 700 },
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      '--host-resolver-rules=MAP *.test 127.0.0.1',
    ],
  });

  try {
    const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
    const extId = new URL(worker.url()).host;
    const popupUrl = `chrome-extension://${extId}/src/popup/popup.html`;

    // Página da extensão usada para mandar as mesmas mensagens que o popup manda.
    const control = await context.newPage();
    await control.goto(popupUrl);
    const send = (msg) => control.evaluate((m) => chrome.runtime.sendMessage(m), msg);
    const sessionRules = () => control.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
    const learned = async () => (await control.evaluate(() => chrome.storage.local.get('learned'))).learned || {};

    const page = await context.newPage();
    const open = async () => {
      log.length = 0;
      await page.goto(site + '/', { waitUntil: 'load' });
      await sleep(500);
    };
    const imgs = () =>
      page.evaluate(() =>
        Object.fromEntries(
          [...document.images].map((i) => [i.id, { state: i.dataset.leve || '', nw: i.naturalWidth, src: i.currentSrc.slice(0, 60) }]),
        ),
      );
    const requested = (part) => log.filter((l) => l.includes(part));
    const loaded = (id, width) =>
      until(
        () => page.evaluate(([i, w]) => document.getElementById(i).complete && document.getElementById(i).naturalWidth === w, [id, width]),
        `#${id} com ${width}px`,
      );
    const shot = async (p, name) => SHOTS && p.screenshot({ path: path.join(SHOTS, name) });

    await send({ type: 'setSettings', patch: { proxyTemplate } });
    await open();
    const tabId = await control.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => (t.url || '').startsWith(u))?.id, site);
    if (!tabId) throw new Error('aba de teste não encontrada');

    // ---------------------------------------------------------------- 1
    console.log('\n1. Usuário escolhe quais imagens baixar');
    await open();
    let state = await imgs();
    check('nenhuma imagem é baixada ao abrir a página', requested('/img/').length === 0, log.join(' '));
    check('todas as imagens viram espaço reservado', Object.values(state).every((i) => i.state === 'blocked'), JSON.stringify(state));
    await shot(page, '1-bloqueadas.png');

    await page.click('#a');
    await loaded('a', 1200);
    await sleep(300);
    state = await imgs();
    check('clicar baixa a imagem escolhida', state.a.nw === 1200 && state.a.state === 'loaded');
    check('clicar não segue o link em volta da imagem', page.url() === site + '/');
    check('só a imagem escolhida é baixada', requested('/img/').length === 1, log.join(' '));
    check('as outras continuam bloqueadas', ['b', 'c', 'r', 's', 'f'].every((id) => state[id].state === 'blocked'));

    await page.click('#r');
    await loaded('r', 120);
    check('imagem com redirecionamento carrega', true);
    await page.click('#s');
    await until(async () => (await imgs()).s.nw >= 400, '#s carregada');
    check('imagem com srcset carrega', (await imgs()).s.src.includes('/img/s1.png'));
    await until(async () => (await sessionRules()).length === 0, 'liberação temporária removida');
    check('a liberação temporária da aba é removida', true);
    await shot(page, '2-escolhidas.png');

    await page.hover('#b');
    await until(() => page.evaluate(() => /kB|MB/.test(document.getElementById('b').title)), 'tamanho no título');
    check('passar o mouse mostra o peso da imagem', true);

    // ---------------------------------------------------------------- 2
    console.log('\n2. Escolher imagens + corrigir imagens sem resize');
    await send({ type: 'setSettings', patch: { resizeFix: true } });
    await open();
    await page.click('#a');
    await loaded('a', 300);
    check('imagem com width/height é baixada já em 300px', requested('proxy.test').some((l) => l.includes('w=300')));
    await page.click('#b');
    await loaded('b', 250);
    check('imagem dimensionada por CSS é baixada já em 250px', requested('proxy.test').some((l) => l.includes('w=250')));
    await page.click('#c');
    await loaded('c', 200);
    check('imagem sem tamanho definido baixa a original', requested('site.test/img/c.png').length === 1);
    await page.click('#f');
    await loaded('f', 900);
    check('se o redimensionador falha, baixa a original', requested('site.test/img/fail.png').length === 1);
    check('as originais grandes não foram baixadas', !requested('site.test/img/a.png').length && !requested('site.test/img/b.png').length, log.join(' '));

    // ---------------------------------------------------------------- 3
    console.log('\n3. Corrigir imagens sem resize (sem bloqueio)');
    await send({ type: 'forgetLearned' });
    await send({ type: 'setSettings', patch: { blockImages: false } });
    await open();
    state = await imgs();
    check('primeira visita: imagens carregam normalmente', state.a.nw === 1200 && state.b.nw === 1000 && state.c.nw === 200);
    const known = await until(async () => {
      const l = await learned();
      return Object.keys(l).length >= 3 && l;
    }, 'imagens memorizadas');
    const widthOf = (name) => Object.entries(known).find(([u]) => u.includes(name))?.[1]?.w;
    check('memoriza as imagens grandes demais', widthOf('a.png') === 300 && widthOf('b.png') === 250 && widthOf('fail.png') === 150, JSON.stringify(known));
    check('não memoriza a imagem de tamanho certo', widthOf('c.png') === undefined);

    await open();
    await until(async () => (await imgs()).f.nw === 900, 'original de #f após falha do redimensionador');
    state = await imgs();
    check('segunda visita: imagens chegam redimensionadas', state.a.nw === 300 && state.b.nw === 250, JSON.stringify(state));
    check('as originais grandes não são mais baixadas', !requested('site.test/img/a.png').length && !requested('site.test/img/b.png').length, log.join(' '));
    check('imagem de tamanho certo não passa pelo redimensionador', state.c.nw === 200 && !requested('proxy.test').some((l) => l.includes('c.png')));
    check('falha do redimensionador volta para a original', state.f.nw === 900);
    await sleep(600);
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 340, height: 640 });
    await popup.goto(`${popupUrl}?tabId=${tabId}`);
    await until(() => popup.evaluate(() => !document.getElementById('resizeStats').hidden), 'estatísticas no popup');
    const statText = await popup.textContent('#resizeStats');
    check('popup mostra as imagens redimensionadas', /2 já redimensionadas/.test(statText), statText);
    await shot(popup, '3-popup.png');
    await popup.close();

    // ---------------------------------------------------------------- 4
    console.log('\n4. Site desligado e aba liberada');
    await send({ type: 'setSettings', patch: { blockImages: true, disabledSites: ['site.test'] } });
    await open();
    state = await imgs();
    check('site desligado: imagens originais carregam sem intervenção', state.a.nw === 1200 && state.a.state === '', JSON.stringify(state) + log.join(' '));
    await send({ type: 'setSettings', patch: { disabledSites: [] } });
    await send({ type: 'allowTab', tabId, on: true });
    await open();
    state = await imgs();
    check('aba liberada: imagens carregam sem espaço reservado', state.c.nw === 200 && state.c.state === '', JSON.stringify(state.c));
    await send({ type: 'allowTab', tabId, on: false });
    await open();
    check('aba bloqueada de novo', (await imgs()).c.state === 'blocked');

    // ---------------------------------------------------------------- 5
    console.log('\n5. Limpar cache');
    await open();
    await open();
    check('sem limpar, o recurso vem do cache', requested('/cached.js').length === 0, log.join(' '));
    const before = Date.now();
    const cleared = await send({ type: 'clearCache' });
    check('limpeza registra o horário', cleared.lastCacheClear >= before);
    await open();
    check('depois de limpar, o recurso é baixado de novo', requested('/cached.js').length === 1, log.join(' '));
    await send({ type: 'setSettings', patch: { cacheIntervalMin: 15 } });
    const alarms = await control.evaluate(() => chrome.alarms.getAll());
    check('limpeza periódica agenda um alarme', alarms.length === 1 && alarms[0].periodInMinutes === 15, JSON.stringify(alarms));
  } catch (err) {
    failures++;
    console.error('\nERRO:', err.message);
    console.error('requisições:', log.join('\n  '));
  } finally {
    await context.close();
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }

  console.log(failures ? `\n${failures} verificação(ões) falharam` : '\nTudo certo.');
  process.exit(failures ? 1 : 0);
})();
