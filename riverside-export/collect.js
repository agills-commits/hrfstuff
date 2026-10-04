/* Riverside export collector. Paste this whole file into the DevTools console
 * on https://riverside.fm/dashboard (or riverside.com) while logged in.
 *
 * It does three things, same pattern as the Loom collector:
 *   1. Hooks fetch, XMLHttpRequest, anchor clicks and window.open so every
 *      media or transcript URL the app touches is recorded, together with the
 *      page you were on when it happened (studio, recording, title).
 *   2. Keeps the raw JSON the app receives from Riverside hosts, so the auto
 *      walker can be written from a real capture later.
 *   3. Stores everything in localStorage so it survives page navigation
 *      inside the single-page app. A hard reload drops the hooks, so re-paste
 *      after a reload. Stored data is kept.
 *
 * Commands once pasted:
 *   __rs.status()   counts of what has been captured so far
 *   __rs.list()     table of captured media/transcript URLs
 *   __rs.dump()     downloads riverside-manifest.json (feed it to download.mjs)
 *   __rs.captures() downloads riverside-captures.json (raw JSON, for debugging)
 *   __rs.scan()     re-scan the current page's links and media elements
 *   __rs.clear()    wipe stored data
 *
 * Workflow: open each studio, open each recording, click Download, pick the
 * 4K (or highest) composed video, then download the transcript. Every click
 * is recorded. Cancel the browser's own download dialog if you like; the URL
 * is already captured. When done, run __rs.dump().
 */
(() => {
  'use strict';
  if (window.__rs && window.__rs.__installed) {
    console.log('[rs] collector already installed. __rs.status() for counts.');
    return;
  }

  const KEY_ITEMS = 'rs.export.items.v1';
  const KEY_CAPS = 'rs.export.captures.v1';
  const MAX_CAPTURE_BYTES = 400 * 1024;
  const MAX_CAPTURES = 400;

  const MEDIA_RE = /\.(mp4|mov|webm|mkv|m4a|wav|mp3|aac|flac|srt|vtt|txt|json)(\?|#|$)/i;
  const HOST_HINTS = /(riverside\.(fm|com)|storage\.googleapis\.com|firebasestorage|cloudfront\.net|amazonaws\.com|mux\.com|wasabisys|backblaze|b2\.|akamai)/i;
  const RIVERSIDE_HOST = /riverside\.(fm|com)/i;
  const EXCLUDE_RE = /(\.js|\.css|\.png|\.jpg|\.jpeg|\.gif|\.svg|\.ico|\.woff2?|\.ttf|hotjar|segment|intercom|sentry|google-analytics|googletagmanager|mixpanel|amplitude|launchdarkly|stripe)/i;

  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('[rs] storage full, trimming captures', e); trimCaptures(true); } };

  let items = load(KEY_ITEMS, []);
  let captures = load(KEY_CAPS, []);
  const seen = new Set(items.map(i => i.url));

  function trimCaptures(hard) {
    const keep = hard ? Math.floor(MAX_CAPTURES / 4) : MAX_CAPTURES;
    if (captures.length > keep) captures = captures.slice(captures.length - keep);
    try { localStorage.setItem(KEY_CAPS, JSON.stringify(captures)); } catch { captures = []; }
  }

  function pageContext() {
    const path = location.pathname;
    const title = (document.title || '').replace(/\s*[|·-]\s*Riverside.*$/i, '').trim();
    const h1 = document.querySelector('h1');
    const crumbs = [...document.querySelectorAll('nav a, [class*="breadcrumb"] a, [class*="Breadcrumb"] a')]
      .map(a => a.textContent.trim()).filter(Boolean);
    const ids = {};
    const m1 = path.match(/studios?\/([^/]+)/i); if (m1) ids.studioId = m1[1];
    const m2 = path.match(/recordings?\/([^/]+)/i); if (m2) ids.recordingId = m2[1];
    const m3 = path.match(/projects?\/([^/]+)/i); if (m3) ids.projectId = m3[1];
    const m4 = path.match(/sessions?\/([^/]+)/i); if (m4) ids.sessionId = m4[1];
    return {
      pageUrl: location.href,
      pageTitle: title,
      heading: h1 ? h1.textContent.trim() : '',
      breadcrumbs: crumbs.slice(0, 6),
      ...ids,
    };
  }

  function classify(url) {
    const u = url.toLowerCase();
    const q = u.split('?')[0];
    if (/\.(srt|vtt)(\?|#|$)/.test(q) || /transcript|caption|subtitle/.test(u)) {
      if (/\.txt(\?|#|$)/.test(q)) return { kind: 'transcript', ext: 'txt' };
      if (/\.vtt(\?|#|$)/.test(q)) return { kind: 'transcript', ext: 'vtt' };
      if (/\.json(\?|#|$)/.test(q)) return { kind: 'transcript', ext: 'json' };
      return { kind: 'transcript', ext: 'srt' };
    }
    if (/\.txt(\?|#|$)/.test(q)) return { kind: 'transcript', ext: 'txt' };
    if (/\.(wav|mp3|m4a|aac|flac)(\?|#|$)/.test(q)) return { kind: 'audio', ext: q.match(/\.(\w+)$/)[1] };
    if (/\.(mp4|mov|webm|mkv)(\?|#|$)/.test(q)) return { kind: 'video', ext: q.match(/\.(\w+)$/)[1] };
    if (/\.json(\?|#|$)/.test(q)) return { kind: 'other', ext: 'json' };
    return { kind: 'other', ext: '' };
  }

  function qualityOf(url) {
    const m = url.match(/(2160p?|4k|1080p?|720p?|480p?|360p?)/i);
    return m ? m[1].toLowerCase().replace(/p$/, 'p') : '';
  }

  function nameHint(url) {
    try {
      const u = new URL(url, location.href);
      const q = u.searchParams;
      for (const k of ['filename', 'file_name', 'name', 'response-content-disposition']) {
        const v = q.get(k);
        if (v) {
          const m = v.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i);
          return decodeURIComponent(m ? m[1] : v);
        }
      }
      return decodeURIComponent(u.pathname.split('/').pop() || '');
    } catch { return ''; }
  }

  function isInteresting(url) {
    if (!url || typeof url !== 'string') return false;
    if (!/^https?:/i.test(url)) return false;
    if (EXCLUDE_RE.test(url)) return false;
    return MEDIA_RE.test(url) || (HOST_HINTS.test(url) && /download|media|recording|track|export|transcript/i.test(url));
  }

  function record(url, source, extra) {
    if (!isInteresting(url) || seen.has(url)) return;
    seen.add(url);
    const c = classify(url);
    const item = {
      url,
      kind: c.kind,
      ext: c.ext,
      quality: qualityOf(url),
      nameHint: nameHint(url),
      source,
      capturedAt: new Date().toISOString(),
      ...pageContext(),
      ...(extra || {}),
    };
    items.push(item);
    save(KEY_ITEMS, items);
    console.log(`[rs] +${c.kind}${item.quality ? ' ' + item.quality : ''} via ${source}: ${item.nameHint || url.slice(0, 90)}`);
  }

  function walkJson(obj, url, depth) {
    if (depth > 12 || obj == null) return;
    if (typeof obj === 'string') { if (isInteresting(obj)) record(obj, 'json:' + url.split('?')[0].slice(-60)); return; }
    if (Array.isArray(obj)) { for (const v of obj) walkJson(v, url, depth + 1); return; }
    if (typeof obj === 'object') for (const k in obj) walkJson(obj[k], url, depth + 1);
  }

  function capture(url, status, text) {
    let abs = url;
    try { abs = new URL(url, location.href).href; } catch { /* keep as is */ }
    const sameOrigin = abs.startsWith(location.origin + '/');
    if (!RIVERSIDE_HOST.test(abs) && !sameOrigin && !/graphql|api\./i.test(abs)) return;
    if (EXCLUDE_RE.test(abs)) return;
    url = abs;
    let body = text;
    if (body.length > MAX_CAPTURE_BYTES) body = body.slice(0, MAX_CAPTURE_BYTES) + '\n/* truncated */';
    captures.push({ url, status, at: new Date().toISOString(), page: location.href, body });
    if (captures.length > MAX_CAPTURES) trimCaptures(false); else save(KEY_CAPS, captures);
  }

  function handleResponseText(url, status, text, contentType) {
    if (!text) return;
    if (/json|graphql/i.test(contentType || '') || /^[\s]*[{[]/.test(text)) {
      try { walkJson(JSON.parse(text), url, 0); } catch { /* not json */ }
      capture(url, status, text);
    }
  }

  // fetch hook
  const origFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    record(url, 'fetch');
    const res = await origFetch(input, init);
    try {
      const ct = res.headers.get('content-type') || '';
      if (/json|graphql|text/i.test(ct) && !/octet|video|audio/i.test(ct)) {
        res.clone().text().then(t => handleResponseText(url, res.status, t, ct)).catch(() => {});
      }
    } catch { /* ignore */ }
    return res;
  };

  // XHR hook
  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) { this.__rsUrl = String(url); record(this.__rsUrl, 'xhr'); return XO.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', () => {
      try {
        const ct = this.getResponseHeader('content-type') || '';
        if (this.responseType === '' || this.responseType === 'text') handleResponseText(this.__rsUrl, this.status, this.responseText, ct);
        else if (this.responseType === 'json' && this.response) handleResponseText(this.__rsUrl, this.status, JSON.stringify(this.response), 'application/json');
      } catch { /* ignore */ }
    });
    return XS.apply(this, arguments);
  };

  // anchor clicks (dynamic <a download href=...> is the usual download path)
  const AC = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.href && !this.href.startsWith('blob:')) record(this.href, 'anchor', { downloadName: this.getAttribute('download') || '' });
    if (this.href && this.href.startsWith('blob:')) console.warn('[rs] blob download seen; URL not capturable. Note the file name:', this.getAttribute('download'));
    return AC.apply(this, arguments);
  };
  document.addEventListener('click', e => {
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (a && a.href) record(a.href, 'anchor-click', { downloadName: a.getAttribute('download') || '' });
  }, true);

  // window.open and location.assign
  const WO = window.open.bind(window);
  window.open = function (url) { if (url) record(String(url), 'window.open'); return WO.apply(window, arguments); };

  // performance entries catch anything the hooks missed (e.g. <video src>)
  try {
    const po = new PerformanceObserver(list => { for (const e of list.getEntries()) record(e.name, 'perf:' + e.initiatorType); });
    po.observe({ entryTypes: ['resource'] });
    for (const e of performance.getEntriesByType('resource')) record(e.name, 'perf:' + e.initiatorType);
  } catch { /* ignore */ }

  // DOM scan: links and media elements already on the page, plus anything added later
  function scanDom(root) {
    const q = 'a[href], video[src], audio[src], source[src], track[src]';
    for (const el of (root.querySelectorAll ? root.querySelectorAll(q) : [])) {
      const u = el.href || el.src || el.getAttribute('href') || el.getAttribute('src');
      if (u) record(u, 'dom', { downloadName: el.getAttribute && el.getAttribute('download') || '' });
    }
  }
  scanDom(document);
  try {
    new MutationObserver(muts => { for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) scanDom(n); })
      .observe(document.documentElement, { childList: true, subtree: true });
  } catch { /* ignore */ }

  function downloadText(name, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    AC.call(a);
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  window.__rs = {
    __installed: true,
    status() {
      const by = {};
      for (const i of items) by[i.kind] = (by[i.kind] || 0) + 1;
      console.table({ ...by, captures: captures.length });
      return { items: items.length, by, captures: captures.length };
    },
    list() {
      console.table(items.map(i => ({ kind: i.kind, quality: i.quality, name: i.nameHint || i.downloadName, page: i.pageTitle || i.heading, source: i.source })));
      return items;
    },
    dump() {
      const manifest = { generatedAt: new Date().toISOString(), origin: location.origin, items };
      downloadText('riverside-manifest.json', JSON.stringify(manifest, null, 2));
      console.log(`[rs] wrote riverside-manifest.json with ${items.length} items`);
      return manifest;
    },
    captures() {
      downloadText('riverside-captures.json', JSON.stringify({ generatedAt: new Date().toISOString(), captures }, null, 2));
      console.log(`[rs] wrote riverside-captures.json with ${captures.length} responses`);
    },
    scan() { scanDom(document); return this.status(); },
    clear() {
      items = []; captures = []; seen.clear();
      localStorage.removeItem(KEY_ITEMS); localStorage.removeItem(KEY_CAPS);
      console.log('[rs] cleared');
    },
  };

  console.log(`[rs] collector installed. ${items.length} items and ${captures.length} captures already stored. Browse studios, open recordings, click Download (pick 4K) and Transcript. Then __rs.dump().`);
})();
