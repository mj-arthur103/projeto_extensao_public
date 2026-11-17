// Leve — popup
const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

let tab = null;
let info = null;

function show(el, text) {
  el.textContent = text;
  el.hidden = !text;
}

function hostOfTemplate(template) {
  try {
    return new URL(template.replace('{url}', 'x').replace('{w}', '1')).hostname;
  } catch {
    return 'endereço inválido';
  }
}

async function getTab() {
  // ?tabId=N permite abrir o popup como página comum (usado nos testes).
  const forced = Number(new URLSearchParams(location.search).get('tabId'));
  if (forced) return chrome.tabs.get(forced);
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  return active;
}

async function render() {
  info = await send({ type: 'getInfo', tabId: tab?.id, url: tab?.url });
  const s = info.settings;
  const isWeb = /^https?:/.test(tab?.url || '');

  $('host').textContent = isWeb ? info.host : 'Página não suportada';
  $('siteOn').checked = isWeb && !info.siteOff;
  $('siteOn').disabled = !isWeb;
  document.body.classList.toggle('off', isWeb && info.siteOff);
  show($('notice'), isWeb && info.siteOff ? 'A extensão está desligada neste site.' : '');

  $('blockImages').checked = s.blockImages;
  $('tabAllowed').checked = info.tabAllowed;
  $('tabAllowedRow').hidden = !s.blockImages || !isWeb || info.siteOff;
  $('resizeFix').checked = s.resizeFix;
  $('proxyHost').textContent = hostOfTemplate(s.proxyTemplate);
  $('cacheOnStartup').checked = s.cacheOnStartup;
  $('cacheIntervalMin').value = String(s.cacheIntervalMin);
  $('respectDpr').checked = s.respectDpr;
  $('proxyTemplate').value = s.proxyTemplate;
  $('lastClear').textContent = info.lastCacheClear
    ? `Última limpeza: ${new Date(info.lastCacheClear).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}`
    : 'O cache ainda não foi limpo.';
  $('learned').textContent = `${plural(info.learnedCount, 'imagem memorizada', 'imagens memorizadas')} para redimensionar.`;

  let stats = null;
  if (isWeb && !info.siteOff) {
    stats = await chrome.tabs.sendMessage(tab.id, { type: 'getStats' }, { frameId: 0 }).catch(() => null);
  }
  show(
    $('blockStats'),
    stats && s.blockImages && !info.tabAllowed
      ? `${plural(stats.blocked, 'imagem não baixada', 'imagens não baixadas')} nesta página · ${plural(stats.chosen, 'escolhida', 'escolhidas')} por você`
      : '',
  );
  show(
    $('resizeStats'),
    stats && stats.images
      ? `${plural(stats.oversized, 'imagem maior', 'imagens maiores')} que o necessário nesta página` +
          (s.resizeFix ? ` · ${plural(stats.optimized, 'já redimensionada', 'já redimensionadas')}` : '')
      : '',
  );
}

async function update(patch, reload) {
  await send({ type: 'setSettings', patch });
  if (reload && tab && /^https?:/.test(tab.url || '')) await chrome.tabs.reload(tab.id);
  await render();
}

$('siteOn').addEventListener('change', (e) => {
  const sites = info.settings.disabledSites.filter((d) => !(info.host === d || info.host.endsWith('.' + d)));
  if (!e.target.checked) sites.push(info.host);
  update({ disabledSites: sites }, true);
});
$('blockImages').addEventListener('change', (e) => update({ blockImages: e.target.checked }, true));
$('resizeFix').addEventListener('change', (e) => update({ resizeFix: e.target.checked }, true));
$('cacheOnStartup').addEventListener('change', (e) => update({ cacheOnStartup: e.target.checked }));
$('cacheIntervalMin').addEventListener('change', (e) => update({ cacheIntervalMin: Number(e.target.value) }));
$('respectDpr').addEventListener('change', (e) => update({ respectDpr: e.target.checked }));

$('tabAllowed').addEventListener('change', async (e) => {
  await send({ type: 'allowTab', tabId: tab.id, on: e.target.checked });
  await chrome.tabs.reload(tab.id);
  await render();
});

$('proxyTemplate').addEventListener('change', (e) => {
  const value = e.target.value.trim() || info.defaults.proxyTemplate;
  const valid = /^https:\/\//.test(value) && value.includes('{url}') && value.includes('{w}');
  if (valid) update({ proxyTemplate: value });
  else {
    e.target.value = info.settings.proxyTemplate;
    show($('notice'), 'O serviço precisa ser um endereço https:// contendo {url} e {w}.');
  }
});

$('clearNow').addEventListener('click', async () => {
  $('clearNow').disabled = true;
  await send({ type: 'clearCache' });
  $('clearNow').disabled = false;
  await render();
});

$('forget').addEventListener('click', async () => {
  await send({ type: 'forgetLearned' });
  await render();
});

getTab().then((t) => {
  tab = t;
  render();
});
