// Leve — content script (roda em todas as páginas, em document_start)
//
//   * Com "escolher imagens" ligado, o download das imagens já está bloqueado pela rede
//     (declarativeNetRequest). Aqui cada <img> vira um espaço reservado clicável; ao
//     clicar, só aquela imagem é baixada.
//   * Mede as imagens carregadas para achar as "sem resize" (arquivo maior do que o
//     tamanho exibido) e avisa o service worker, que passa a pedi-las já redimensionadas.

(() => {
  const PH_PREFIX = 'data:image/svg+xml,%3Csvg%20data-leve';
  const DEFAULT_W = 160;
  const DEFAULT_H = 90;

  let state = null;
  const saved = new WeakMap(); // img bloqueada -> atributos originais
  const loadedSrc = new WeakMap(); // img liberada -> valor de src que nós colocamos
  const proxied = new WeakMap(); // img carregada pelo redimensionador -> {orig, w, retried}
  const optimized = new WeakSet(); // imgs que a rede já entregou redimensionadas
  const reported = new WeakMap(); // img -> última URL medida
  const sizeAsked = new WeakSet();
  const errorTried = new WeakSet();
  const phCache = new Map();

  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => undefined);
    } catch {
      return Promise.resolve(undefined); // extensão recarregada/removida
    }
  }

  const abs = (url) => {
    try {
      return new URL(url, document.baseURI).href;
    } catch {
      return '';
    }
  };

  const dpr = () => (state?.respectDpr ? Math.min(window.devicePixelRatio || 1, 3) : 1);

  const proxyUrl = (url, w) =>
    state.proxyTemplate.replace('{url}', () => encodeURIComponent(url)).replace('{w}', () => String(w));

  // Imagens que o redimensionador consegue tratar (endereço público, sem SVG/GIF animado).
  function resizable(url) {
    if (!/^https?:\/\/[\x21-\x7e]+$/.test(url) || url.length > 1500) return false;
    try {
      const u = new URL(url);
      return !/\.(svg|gif)$/i.test(u.pathname) && u.hostname !== new URL(proxyUrl('x', 1)).hostname;
    } catch {
      return false;
    }
  }

  const hasAlternatives = (img) => img.hasAttribute('srcset') || img.parentElement?.tagName === 'PICTURE';

  // ------------------------------------------------------------ espaço reservado

  function attrSize(img, name) {
    const n = parseInt(img.getAttribute(name), 10);
    return n > 0 ? Math.min(n, 4000) : 0;
  }

  function placeholderSize(img) {
    const w = attrSize(img, 'width');
    const h = attrSize(img, 'height');
    if (w && h) return [w, h];
    if (w) return [w, Math.round((w * DEFAULT_H) / DEFAULT_W)];
    if (h) return [Math.round((h * DEFAULT_W) / DEFAULT_H), h];
    return [DEFAULT_W, DEFAULT_H];
  }

  function placeholder(w, h) {
    const key = `${w}x${h}`;
    let uri = phCache.get(key);
    if (!uri) {
      const svg =
        `<svg data-leve="1" xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
        '<style>text{font:12px system-ui,sans-serif;fill:#4d5a51}.i{transform:translate(-11px,-21px)}' +
        '@media (max-width:139px),(max-height:47px){text{display:none}.i{transform:translate(-11px,-8px)}}' +
        '@media (max-width:27px),(max-height:21px){.i{display:none}}</style>' +
        '<rect width="100%" height="100%" fill="#eef2ee" stroke="#a9b8ac" stroke-width="2" stroke-dasharray="6 4"/>' +
        '<svg x="50%" y="50%" overflow="visible">' +
        '<g class="i" fill="none" stroke="#4d5a51" stroke-width="1.6" stroke-linejoin="round">' +
        '<rect x="1" y="1" width="20" height="15" rx="2"/><circle cx="7" cy="6" r="1.6"/>' +
        '<path d="M1 13l5.5-4.5 4 3 4-4.5L21 12"/></g>' +
        '<text y="15" text-anchor="middle">Clique para carregar</text></svg></svg>';
      uri = 'data:image/svg+xml,' + encodeURIComponent(svg);
      phCache.set(key, uri);
    }
    return uri;
  }

  const isPlaceholder = (img) => (img.getAttribute('src') || '').startsWith(PH_PREFIX);

  // Troca a imagem pelo espaço reservado, guardando os atributos originais.
  function block(img) {
    const src = img.getAttribute('src');
    const srcset = img.getAttribute('srcset');
    if (img.dataset.leve === 'loaded' || img.dataset.leve === 'loading') {
      if (src === loadedSrc.get(img)) return;
      // A página trocou a imagem deste elemento: volta a pedir a escolha do usuário.
      proxied.delete(img);
      optimized.delete(img);
    }
    const ours = (src || '').startsWith(PH_PREFIX);
    if (ours && srcset === null) return;
    if (srcset === null && (!src || /^(data|blob|about|chrome-extension):/i.test(src))) return;

    const s = saved.get(img) || { src: null, srcset: null, sources: [], title: img.getAttribute('title') };
    if (!ours) s.src = src;
    if (srcset !== null) s.srcset = srcset;
    if (img.parentElement?.tagName === 'PICTURE') {
      for (const source of img.parentElement.querySelectorAll('source[srcset]')) {
        s.sources.push([source, source.getAttribute('srcset')]);
        source.removeAttribute('srcset');
      }
    }
    saved.set(img, s);
    sizeAsked.delete(img);
    img.dataset.leve = 'blocked';
    img.removeAttribute('srcset');
    img.setAttribute('src', placeholder(...placeholderSize(img)));
    scheduleBadge();
  }

  function restore(img, s) {
    for (const [source, value] of s.sources) source.setAttribute('srcset', value);
    loadedSrc.set(img, s.src);
    if (s.srcset !== null) img.setAttribute('srcset', s.srcset);
    if (s.src !== null) img.setAttribute('src', s.src);
    else img.removeAttribute('src');
  }

  // Libera as imagens da aba só enquanto esta imagem carrega (cobre redirecionamentos,
  // srcset e <picture> sem precisar adivinhar a URL final).
  async function withImagesAllowed(img, start) {
    await send({ type: 'tempAllow' });
    await new Promise((resolve) => {
      const done = () => {
        img.removeEventListener('load', done);
        img.removeEventListener('error', done);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 15000);
      img.addEventListener('load', done);
      img.addEventListener('error', done);
      start();
    });
    send({ type: 'tempRelease' });
  }

  // Largura (em pixels reais) que a página reserva para a imagem, se der para saber
  // antes do download. 0 = o tamanho depende da própria imagem.
  function knownWidth(img) {
    const cw = img.clientWidth;
    if (cw < 2) return 0;
    if (!attrSize(img, 'width') && cw === placeholderSize(img)[0]) return 0;
    return Math.ceil(cw * dpr());
  }

  function setProxied(img, orig, w, retried) {
    const url = proxyUrl(orig, w);
    proxied.set(img, { orig, w, retried });
    loadedSrc.set(img, url);
    img.setAttribute('src', url);
  }

  async function load(img) {
    const s = saved.get(img);
    if (!s) return;
    saved.delete(img);
    img.dataset.leve = 'loading';
    if (s.title === null) img.removeAttribute('title');
    else img.setAttribute('title', s.title);
    scheduleBadge();

    const orig = s.src ? abs(s.src) : '';
    const w = state.resizeFix && s.srcset === null && !s.sources.length && resizable(orig) ? knownWidth(img) : 0;
    if (w) {
      // Baixa direto no tamanho em que vai ser exibida.
      setProxied(img, orig, w, false);
    } else {
      await withImagesAllowed(img, () => restore(img, s));
    }
    if (img.dataset.leve === 'loading') img.dataset.leve = 'loaded';
  }

  // ------------------------------------------------------------ imagens sem resize

  function measure(img) {
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    const cw = img.clientWidth;
    const ch = img.clientHeight;
    if (!img.complete || nw < 2 || nh < 2 || cw < 2 || ch < 2) return null;
    // Escala necessária para preencher a área exibida sem perder nitidez.
    const needW = Math.ceil(nw * Math.max(cw / nw, ch / nh) * dpr());
    return { nw, nh, cw, ch, needW };
  }

  let queue = [];
  let queueTimer = 0;

  function inspect(img) {
    if (!state || img.dataset.leve === 'blocked' || isPlaceholder(img)) return;
    const m = measure(img);
    if (!m) return;

    const p = proxied.get(img);
    if (p) {
      // Pedimos pequena demais (o tamanho exibido mudou depois do carregamento): corrige uma vez.
      if (!p.retried && m.needW > m.nw * 1.1) setProxied(img, p.orig, m.needW, true);
      return;
    }
    if (!state.resizeFix || hasAlternatives(img)) return;
    const url = img.currentSrc;
    if (!resizable(url) || reported.get(img) === url) return;
    reported.set(img, url);
    queue.push({ img, url, nw: m.nw, w: m.needW });
    clearTimeout(queueTimer);
    queueTimer = setTimeout(flush, 300);
  }

  async function flush() {
    const batch = queue;
    queue = [];
    const res = await send({ type: 'learn', items: batch.map(({ url, nw, w }) => ({ url, nw, w })) });
    if (!res || res.error) return;
    for (const { img, url, nw, w } of batch) {
      const r = res[url];
      if (!r || img.currentSrc !== url) continue;
      if (r.optimized) optimized.add(img);
      // A versão redimensionada ficou pequena para este uso: pede uma maior.
      if (r.upgradeTo && nw < w && img.dataset.leve !== 'blocked') setProxied(img, url, r.upgradeTo, true);
    }
  }

  function onError(img) {
    if (!state) return;
    const p = proxied.get(img);
    if (p) {
      // O redimensionador falhou: cai para a imagem original.
      proxied.delete(img);
      send({ type: 'imageError', url: p.orig });
      const original = () => {
        loadedSrc.set(img, p.orig);
        img.setAttribute('src', p.orig);
      };
      if (state.blocking) withImagesAllowed(img, original);
      else original();
      return;
    }
    if (!state.resizeFix || state.blocking || errorTried.has(img) || !resizable(img.currentSrc)) return;
    errorTried.add(img);
    const url = img.currentSrc;
    send({ type: 'imageError', url }).then((r) => {
      if (r?.retry && img.currentSrc === url) img.setAttribute('src', url);
    });
  }

  // ------------------------------------------------------------ estatísticas

  function collect() {
    const out = { blocked: 0, chosen: 0, oversized: 0, optimized: 0, images: 0 };
    for (const img of document.images) {
      const st = img.dataset.leve;
      if (st === 'blocked') {
        out.blocked++;
        continue;
      }
      if (st === 'loaded' || st === 'loading') out.chosen++;
      const m = measure(img);
      if (!m) continue;
      out.images++;
      if (proxied.has(img) || optimized.has(img)) out.optimized++;
      else if (m.needW < m.nw * 0.9) out.oversized++;
    }
    return out;
  }

  let badgeTimer = 0;
  function scheduleBadge() {
    if (window !== window.top) return;
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => {
      send({ type: 'stats', blocked: document.querySelectorAll('img[data-leve="blocked"]').length });
    }, 400);
  }

  // ------------------------------------------------------------ inicialização

  function startBlocking() {
    const scan = (root) => {
      for (const img of root.querySelectorAll('img')) block(img);
    };
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes') {
          if (m.target.tagName === 'IMG') block(m.target);
          continue;
        }
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.tagName === 'IMG') block(node);
          else if (node.firstElementChild) scan(node);
        }
      }
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset'] });
    scan(document);

    // Clique no espaço reservado: baixa a imagem (sem seguir o link em volta dela).
    const onClick = (event) => {
      const img = event.target;
      if (img?.tagName !== 'IMG' || img.dataset.leve !== 'blocked') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === 'click') load(img);
    };
    for (const type of ['click', 'auxclick']) window.addEventListener(type, onClick, true);

    // Ao passar o mouse, mostra quanto a imagem pesa para ajudar na escolha.
    window.addEventListener(
      'mouseover',
      async (event) => {
        const img = event.target;
        if (img?.tagName !== 'IMG' || img.dataset.leve !== 'blocked' || sizeAsked.has(img)) return;
        sizeAsked.add(img);
        const url = abs(saved.get(img)?.src || '');
        img.setAttribute('title', 'Clique para carregar esta imagem');
        if (!/^https?:/.test(url)) return;
        const r = await send({ type: 'headSize', url });
        if (r?.size && img.dataset.leve === 'blocked') {
          const kb = r.size / 1024;
          const text = kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(kb))} kB`;
          img.setAttribute('title', `Clique para carregar esta imagem (${text})`);
        }
      },
      true,
    );
  }

  async function init() {
    state = await send({ type: 'getState' });
    if (!state || state.error) {
      state = null;
      return;
    }
    if (state.blocking) startBlocking();

    window.addEventListener('load', (e) => e.target?.tagName === 'IMG' && inspect(e.target), true);
    window.addEventListener('error', (e) => e.target?.tagName === 'IMG' && onError(e.target), true);
    const inspectAll = () => {
      for (const img of document.images) inspect(img);
    };
    if (document.readyState === 'complete') inspectAll();
    else window.addEventListener('load', inspectAll);
    scheduleBadge();
  }

  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg?.type === 'getStats' && window === window.top) respond({ active: !!state, ...collect() });
  });

  init();
})();
