// Leve — service worker (Manifest V3)
//
// Responsabilidades:
//   1. Limpar o cache automaticamente (ao iniciar o navegador e/ou em intervalos).
//   2. Bloquear o download de imagens até o usuário escolher (regras declarativeNetRequest).
//   3. Redirecionar imagens "sem resize" (maiores do que o tamanho exibido) para um
//      serviço de redimensionamento, na largura que a página realmente usa.

const DEFAULTS = {
  blockImages: true, // usuário escolhe quais imagens baixar
  resizeFix: false, // corrigir imagens sem resize (usa serviço externo, por isso é opcional)
  respectDpr: true, // considerar telas de alta densidade ao calcular a largura
  proxyTemplate: 'https://wsrv.nl/?url={url}&w={w}&we&output=webp',
  cacheOnStartup: true, // limpar cache ao abrir o navegador
  cacheIntervalMin: 0, // limpar cache a cada N minutos (0 = desligado)
  disabledSites: [], // sites onde a extensão não age
};

// IDs e prioridades das regras. Prioridade maior vence; por isso:
//   liberar (3) > bloquear imagens (2) > redirecionar para o redimensionador (1)
const RULE_BLOCK = 1;
const RULE_PROXY = 2;
const RULE_SITES = 3;
const RULE_TABS = 9; // regra de sessão
const RULE_REDIRECT_BASE = 10000;
const MAX_LEARNED = 2000;
const ALARM = 'leve-cache';

// ---------------------------------------------------------------- utilidades

// Fila simples: evita que duas mensagens simultâneas alterem regras/armazenamento ao mesmo tempo.
let chain = Promise.resolve();
function lock(fn) {
  const p = chain.then(() => fn());
  chain = p.catch(() => {});
  return p;
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...settings };
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function isSiteDisabled(settings, host) {
  return !!host && settings.disabledSites.some((d) => host === d || host.endsWith('.' + d));
}

function proxyUrl(template, url, w) {
  return template.replace('{url}', () => encodeURIComponent(url)).replace('{w}', () => String(w));
}

function proxyHost(template) {
  if (!template.includes('{url}') || !template.includes('{w}')) return '';
  return hostOf(proxyUrl(template, 'x', 1));
}

// O serviço de redimensionamento só alcança endereços públicos.
function isPublicImageUrl(url) {
  if (typeof url !== 'string' || url.length > 1500 || !/^https?:\/\/[\x21-\x7e]+$/.test(url)) return false;
  const host = hostOf(url);
  if (!host.includes('.') || host.startsWith('[')) return false;
  if (/\.(local|localhost|internal|lan|home|intranet)$/.test(host)) return false;
  if (/^(10|127|0)\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  return true;
}

function isExtensionPage(sender) {
  return !!sender.url && sender.url.startsWith(chrome.runtime.getURL(''));
}

// ---------------------------------------------------------------- regras de rede

function redirectRule(template, url, entry) {
  return {
    id: entry.id,
    priority: 1,
    action: { type: 'redirect', redirect: { url: proxyUrl(template, url, entry.w) } },
    condition: { urlFilter: `|${url}|`, isUrlFilterCaseSensitive: true, resourceTypes: ['image'] },
  };
}

// Reconstrói todas as regras dinâmicas a partir das configurações.
async function syncRules() {
  const s = await getSettings();
  const { learned = {} } = await chrome.storage.local.get('learned');
  const host = proxyHost(s.proxyTemplate);
  const base = [];

  if (s.blockImages) {
    base.push({ id: RULE_BLOCK, priority: 2, action: { type: 'block' }, condition: { resourceTypes: ['image'] } });
  }
  if (s.resizeFix && host) {
    base.push({
      id: RULE_PROXY,
      priority: 3,
      action: { type: 'allow' },
      condition: { requestDomains: [host], resourceTypes: ['image'] },
    });
  }
  if (s.disabledSites.length) {
    // Por domínio de origem da requisição (e não allowAllRequests, que só passa a valer
    // depois que a navegação termina e deixava as primeiras imagens da página bloqueadas).
    base.push({
      id: RULE_SITES,
      priority: 3,
      action: { type: 'allow' },
      condition: { initiatorDomains: s.disabledSites, resourceTypes: ['image'] },
    });
  }

  const redirects = [];
  if (s.resizeFix && host) {
    for (const [url, entry] of Object.entries(learned)) {
      if (!entry.bad) redirects.push(redirectRule(s.proxyTemplate, url, entry));
    }
  }

  const removeRuleIds = (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.id);
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: [...base, ...redirects] });
  } catch (err) {
    // Uma regra de redirecionamento inválida não pode derrubar o bloqueio: descarta o aprendizado.
    console.warn('Leve: regras de redimensionamento descartadas', err);
    await chrome.storage.local.set({ learned: {} });
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: base });
  }
}

// Abas com imagens liberadas: as que o usuário liberou + as que estão carregando
// uma imagem escolhida pelo usuário neste instante.
async function syncTabRule() {
  const { allowedTabs = [], tempTabs = {} } = await chrome.storage.session.get(['allowedTabs', 'tempTabs']);
  const temp = Object.keys(tempTabs).filter((id) => tempTabs[id] > 0).map(Number);
  const tabIds = [...new Set([...allowedTabs, ...temp])];
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [RULE_TABS],
    addRules: tabIds.length
      ? [{ id: RULE_TABS, priority: 3, action: { type: 'allow' }, condition: { tabIds, resourceTypes: ['image'] } }]
      : [],
  });
}

async function changeTemp(tabId, delta) {
  if (tabId == null) return;
  const { tempTabs = {} } = await chrome.storage.session.get('tempTabs');
  const next = delta === null ? 0 : Math.max(0, (tempTabs[tabId] || 0) + delta);
  if (next === (tempTabs[tabId] || 0)) return;
  if (next) tempTabs[tabId] = next;
  else delete tempTabs[tabId];
  await chrome.storage.session.set({ tempTabs });
  await syncTabRule();
}

async function setTabAllowed(tabId, on) {
  const { allowedTabs = [] } = await chrome.storage.session.get('allowedTabs');
  const next = allowedTabs.filter((id) => id !== tabId);
  if (on) next.push(tabId);
  await chrome.storage.session.set({ allowedTabs: next });
  await syncTabRule();
}

// ---------------------------------------------------------------- imagens sem resize

// Recebe medições das páginas ({url, nw: largura baixada, w: largura necessária}) e
// guarda as imagens grandes demais; nas próximas requisições elas são redirecionadas
// para o redimensionador já na largura certa.
async function learn(items) {
  const s = await getSettings();
  const active = s.resizeFix && !!proxyHost(s.proxyTemplate);
  const stored = await chrome.storage.local.get(['learned', 'nextRuleId']);
  const learned = stored.learned || {};
  let nextRuleId = stored.nextRuleId || RULE_REDIRECT_BASE;
  const now = Date.now();
  const out = {};
  const removeRuleIds = [];
  const addRules = [];
  let changed = false;

  for (const it of items) {
    if (!isPublicImageUrl(it.url) || !(it.w > 0) || !(it.nw > 0)) continue;
    const w = Math.ceil(it.w);
    const entry = learned[it.url];
    if (entry) {
      if (entry.bad) continue;
      const res = { w: entry.w, optimized: active && it.nw <= entry.w + 1 };
      if (w > entry.w * 1.05) {
        // A imagem está sendo exibida maior do que o tamanho aprendido: aumenta.
        entry.w = w;
        changed = true;
        if (active) {
          removeRuleIds.push(entry.id);
          addRules.push(redirectRule(s.proxyTemplate, it.url, entry));
          res.upgradeTo = w;
        }
      }
      entry.t = now;
      out[it.url] = res;
    } else if (w < it.nw * 0.9) {
      const created = { id: nextRuleId++, w, t: now };
      learned[it.url] = created;
      changed = true;
      if (active) addRules.push(redirectRule(s.proxyTemplate, it.url, created));
    }
  }

  const urls = Object.keys(learned);
  if (urls.length > MAX_LEARNED) {
    urls.sort((a, b) => (learned[a].t || 0) - (learned[b].t || 0));
    for (const url of urls.slice(0, urls.length - MAX_LEARNED + 200)) {
      removeRuleIds.push(learned[url].id);
      delete learned[url];
    }
    changed = true;
  }

  if (changed) await chrome.storage.local.set({ learned, nextRuleId });
  if (active && (removeRuleIds.length || addRules.length)) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  }
  return out;
}

// O redimensionador não conseguiu entregar a imagem: volta a usar a original.
async function markBad(url) {
  const { learned = {} } = await chrome.storage.local.get('learned');
  const entry = learned[url];
  if (!entry || entry.bad) return { retry: false };
  entry.bad = true;
  await chrome.storage.local.set({ learned });
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [entry.id] });
  return { retry: true };
}

// ---------------------------------------------------------------- cache

async function clearCache() {
  await chrome.browsingData.removeCache({ since: 0 });
  const lastCacheClear = Date.now();
  await chrome.storage.local.set({ lastCacheClear });
  return { lastCacheClear };
}

async function syncAlarm() {
  const { cacheIntervalMin } = await getSettings();
  const current = await chrome.alarms.get(ALARM);
  if (!(cacheIntervalMin > 0)) {
    if (current) await chrome.alarms.clear(ALARM);
  } else if (!current || current.periodInMinutes !== cacheIntervalMin) {
    await chrome.alarms.create(ALARM, { periodInMinutes: cacheIntervalMin });
  }
}

// ---------------------------------------------------------------- eventos

chrome.runtime.onInstalled.addListener(() => {
  lock(syncRules);
  lock(syncAlarm);
});

chrome.runtime.onStartup.addListener(async () => {
  lock(syncRules);
  lock(syncAlarm);
  if ((await getSettings()).cacheOnStartup) await clearCache();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) clearCache();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  lock(async () => {
    await changeTemp(tabId, null);
    const { allowedTabs = [] } = await chrome.storage.session.get('allowedTabs');
    if (allowedTabs.includes(tabId)) await setTabAllowed(tabId, false);
  });
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'loading') return;
  // Nova página na aba: cancela liberações temporárias que ficaram pendentes.
  lock(() => changeTemp(tabId, null));
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
});

// Mensagens vindas das páginas (content script).
const pageHandlers = {
  async getState(msg, sender) {
    const s = await getSettings();
    const siteOff = isSiteDisabled(s, hostOf(sender.url)); // por frame, igual à regra de rede
    const { allowedTabs = [] } = await chrome.storage.session.get('allowedTabs');
    return {
      blocking: s.blockImages && !siteOff && !allowedTabs.includes(sender.tab?.id),
      resizeFix: s.resizeFix && !siteOff && !!proxyHost(s.proxyTemplate),
      proxyTemplate: s.proxyTemplate,
      respectDpr: s.respectDpr,
    };
  },
  tempAllow: (msg, sender) => lock(() => changeTemp(sender.tab?.id, 1)),
  tempRelease: (msg, sender) => lock(() => changeTemp(sender.tab?.id, -1)),
  learn: (msg) => lock(() => learn(Array.isArray(msg.items) ? msg.items.slice(0, 200) : [])),
  imageError: (msg) => lock(() => markBad(msg.url)),
  async headSize(msg) {
    if (!/^https?:/i.test(msg.url || '')) return {};
    try {
      const res = await fetch(msg.url, { method: 'HEAD', credentials: 'omit' });
      const size = Number(res.headers.get('content-length'));
      return res.ok && size > 0 ? { size } : {};
    } catch {
      return {};
    }
  },
  async stats(msg, sender) {
    if (sender.tab?.id == null) return;
    const n = Number(msg.blocked) || 0;
    await chrome.action.setBadgeBackgroundColor({ color: '#2f7d4f' });
    await chrome.action.setBadgeText({ tabId: sender.tab.id, text: n ? String(n > 999 ? '999+' : n) : '' });
  },
};

// Mensagens que só o popup da extensão pode enviar.
const popupHandlers = {
  async getInfo(msg) {
    const s = await getSettings();
    const { allowedTabs = [] } = await chrome.storage.session.get('allowedTabs');
    const { lastCacheClear = 0, learned = {} } = await chrome.storage.local.get(['lastCacheClear', 'learned']);
    const host = hostOf(msg.url);
    return {
      settings: s,
      defaults: DEFAULTS,
      host,
      siteOff: isSiteDisabled(s, host),
      tabAllowed: allowedTabs.includes(msg.tabId),
      lastCacheClear,
      learnedCount: Object.values(learned).filter((e) => !e.bad).length,
    };
  },
  setSettings: (msg) =>
    lock(async () => {
      const next = { ...(await getSettings()) };
      for (const key of Object.keys(DEFAULTS)) {
        if (key in (msg.patch || {}) && typeof msg.patch[key] === typeof DEFAULTS[key]) next[key] = msg.patch[key];
      }
      next.disabledSites = [...new Set(next.disabledSites.filter((d) => /^[a-z0-9.-]+$/i.test(d)))];
      next.cacheIntervalMin = Math.max(0, Math.round(next.cacheIntervalMin));
      await chrome.storage.local.set({ settings: next });
      await syncRules();
      await syncAlarm();
      return next;
    }),
  allowTab: (msg) => lock(() => setTabAllowed(msg.tabId, !!msg.on)),
  clearCache: () => clearCache(),
  forgetLearned: () =>
    lock(async () => {
      await chrome.storage.local.set({ learned: {} });
      await syncRules();
    }),
};

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  const type = msg?.type;
  const handler =
    (Object.hasOwn(pageHandlers, type) && pageHandlers[type]) ||
    (isExtensionPage(sender) && Object.hasOwn(popupHandlers, type) && popupHandlers[type]);
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(
      (result) => respond(result ?? {}),
      (err) => respond({ error: String(err) }),
    );
  return true;
});
