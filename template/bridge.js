/*
 * Pocket page bridge, generalised from CapyPocket's injections.
 *
 * Native evaluates this file as `(<file>)(init)` at document start, in every frame, inside an
 * isolated WKContentWorld, so page scripts can neither see `__pocket` nor reach the message
 * handler. Later native state changes call `window.__pocket.update(state)` in the top frame.
 *
 * It never reads page text, form values or credentials. The only thing that crosses back to
 * native is two sampled hex colours and one boolean.
 */
(function (init) {
  'use strict';
  if (window.__pocket) { window.__pocket.update(init); return true; }

  const STYLE_ID = 'pocket-bridge-style';
  const USER_STYLE_ID = 'pocket-user-style';
  const isTop = window === window.top;
  const config = {
    mode: init.mode === 'zoom' || init.mode === 'off' ? init.mode : 'text',
    lockZoom: init.lockZoom !== false,
    edges: init.edges === 'full' || init.edges === 'inset' ? init.edges : 'auto',
    hosts: Array.isArray(init.hosts) ? init.hosts.map(String) : [],
    userCSS: typeof init.userCSS === 'string' ? init.userCSS : '',
  };
  const state = { textScale: 1, safeTop: 0, safeBottom: 0, safeLeft: 0, safeRight: 0 };
  const internal = config.hosts.some((host) => location.hostname === host || location.hostname.endsWith('.' + host));

  const merge = (next) => {
    if (!next) return;
    if (Number.isFinite(next.textScale) && next.textScale > 0) state.textScale = Math.round(next.textScale * 100) / 100;
    for (const key of ['safeTop', 'safeBottom', 'safeLeft', 'safeRight']) {
      if (Number.isFinite(next[key])) state[key] = Math.max(0, next[key]);
    }
  };

  const ensureStyle = (id, css) => {
    let style = document.getElementById(id);
    if (!style) {
      style = document.createElement('style');
      style.id = id;
      (document.head || document.documentElement).appendChild(style);
    }
    if (style.textContent !== css) style.textContent = css;
  };

  // Dynamic Type. text-size-adjust multiplies every computed font size, whatever unit the site
  // used, without touching font families, the root font size or page zoom, so drafts, layout
  // breakpoints and rem-based spacing stay as the site intended.
  const renderStyle = () => {
    if (!document.documentElement) return;
    const percent = Math.round(state.textScale * 100);
    let css = ':root { --pocket-text-scale: ' + state.textScale + ';';
    if (isTop) css += ' --pocket-safe-top: ' + state.safeTop + 'px; --pocket-safe-bottom: ' + state.safeBottom + 'px; --pocket-safe-left: ' + state.safeLeft + 'px; --pocket-safe-right: ' + state.safeRight + 'px;';
    css += ' }';
    if (config.mode === 'text') css += ' html, body, body * { -webkit-text-size-adjust: ' + percent + '% !important; text-size-adjust: ' + percent + '% !important; }';
    ensureStyle(STYLE_ID, css);
    if (isTop && internal && config.userCSS) ensureStyle(USER_STYLE_ID, config.userCSS);
  };

  merge(init);
  renderStyle();
  if (!isTop) { window.__pocket = { update: (next) => { merge(next); renderStyle(); return true; } }; return true; }

  // Viewport guard. maximum-scale=1 suppresses the focus zoom iOS applies to inputs under 16px
  // (which smaller Text Sizes reintroduce). The site's other viewport settings are preserved,
  // and replacements made later by the page are repaired.
  const forceCover = config.edges === 'full' && internal;
  const guardViewport = () => {
    if (!document.head || (!config.lockZoom && !forceCover)) return;
    let metas = Array.from(document.querySelectorAll('meta[name="viewport"]'));
    if (!metas.length) {
      if (!forceCover) return;
      const meta = document.createElement('meta');
      meta.name = 'viewport';
      meta.content = 'viewport-fit=cover';
      document.head.appendChild(meta);
      metas = [meta];
    }
    for (const meta of metas) {
      const drop = [];
      const add = [];
      if (config.lockZoom) { drop.push('maximum-scale'); add.push('maximum-scale=1'); }
      if (forceCover) { drop.push('viewport-fit'); add.push('viewport-fit=cover'); }
      const parts = (meta.content || '').split(',').map((part) => part.trim()).filter((part) => part && !drop.includes(part.split('=')[0].trim().toLowerCase()));
      const content = parts.concat(add).join(', ');
      if (meta.content !== content) meta.content = content;
    }
  };

  const declaresCover = () => Array.from(document.querySelectorAll('meta[name="viewport"]')).some((meta) => /viewport-fit\s*=\s*cover/i.test(meta.content || ''));

  // Edge colours. A one-pixel canvas converts any CSS colour (oklch, color-mix, alpha) to sRGB
  // and composites transparent ancestors, so native can paint the safe areas to match the page.
  let last = '';
  let pending = false;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const colorAt = (y) => {
    let node = document.elementFromPoint(Math.floor(innerWidth / 2), y);
    const layers = [];
    while (node) { layers.push(getComputedStyle(node).backgroundColor); node = node.parentElement; }
    const fallback = matchMedia('(prefers-color-scheme: dark)').matches && getComputedStyle(document.documentElement).colorScheme.includes('dark') ? '#000000' : '#ffffff';
    if (!context) return fallback;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = fallback;
    context.fillRect(0, 0, 1, 1);
    for (const color of layers.reverse()) { context.fillStyle = color; context.fillRect(0, 0, 1, 1); }
    return '#' + Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3).map((value) => value.toString(16).padStart(2, '0')).join('');
  };
  const sample = () => {
    pending = false;
    if (!document.body) return;
    renderStyle();
    const viewport = window.visualViewport;
    const top = viewport ? viewport.offsetTop : 0;
    const height = viewport ? viewport.height : innerHeight;
    const edge = config.edges === 'full' ? internal : config.edges === 'auto' && declaresCover();
    const message = JSON.stringify({ type: 'pocket-chrome', top: colorAt(top + 2), bottom: colorAt(Math.min(innerHeight - 2, top + height - 2)), edge });
    if (message === last) return;
    last = message;
    try { window.webkit.messageHandlers.pocket.postMessage(message); } catch (error) { /* not running inside Pocket */ }
  };
  const schedule = () => { if (!pending) { pending = true; setTimeout(sample, 150); } };

  window.__pocket = { update: (next) => { merge(next); renderStyle(); schedule(); return true; } };
  new MutationObserver(() => { guardViewport(); schedule(); }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'name', 'content', 'data-theme'] });
  addEventListener('scroll', schedule, true);
  addEventListener('resize', schedule);
  addEventListener('pageshow', schedule);
  addEventListener('popstate', schedule);
  addEventListener('transitionend', schedule, true);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', schedule);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', schedule);
  guardViewport();
  sample();
  return true;
})
