// FB AI Ad Blocker: content script.
//
// Strategy: Facebook obfuscates the *DOM* (decoy letters, hidden spans, CSS
// reordering, SVG <use> indirection) but the *rendered* page is clean, because a
// human has to be able to read "Sponsored". So we reconstruct the text as it is
// actually laid out on screen (per-glyph rects, hidden glyphs dropped, sorted by
// position) and decide from that:
//   1. fast path: a "Sponsored" label in the post header  -> ad, no AI needed
//   2. otherwise: send the rendered header/body/buttons to an LLM classifier
(() => {
  'use strict';
  if (window.__fbabLoaded) return;
  window.__fbabLoaded = true;

  const hasChrome = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;

  const DEFAULTS = {
    enabled: true,
    provider: 'builtin', // 'builtin' | 'openai' | 'none'
    hideSuggested: false,
    showPlaceholder: true,
    debug: false,
  };
  let settings = { ...DEFAULTS };

  // "Sponsored" in the languages Facebook uses most. Matched only against the
  // post *header*, so ordinary body text that mentions the word is not affected.
  const SPONSORED_WORDS = [
    'Sponsored', 'Gesponsert', 'Sponsorisé', 'Sponsorisée', 'Patrocinado', 'Patrocinada',
    'Publicidad', 'Sponsorizzato', 'Sponsorizzata', 'Gesponsord', 'Sponsorowane',
    'Sponsrad', 'Sponset', 'Sponsoreret', 'Sponzorováno', 'Sponzorované', 'Szponzorált',
    'Sponsorizat', 'Sponsorlu', 'Disponsori', 'Bersponsor', 'Được tài trợ', 'Реклама',
    'Спонзорирано', 'Спонсорирано', 'Χορηγούμενη', 'ממומן', 'مُموَّل', 'ممول',
    'प्रायोजित', 'ได้รับการสนับสนุน', '広告', '赞助内容', '贊助', '광고', 'Sponsoroitu',
    'Kostunud', 'Remiama', 'Apmaksāta reklāma', 'Sponzorirano',
  ];
  const norm = (s) => s.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  const SPONSORED_NORM = SPONSORED_WORDS.map(norm);
  const SPONSORED_TIDY = SPONSORED_WORDS.map((w) => w.normalize('NFKC').toLowerCase());
  const HEADER_HEIGHT_PX = 110; // the author line + "Sponsored · 🌐" line

  const stats = { scanned: 0, hiddenAds: 0, hiddenSuggested: 0, aiCalls: 0, label: 0 };
  const state = new WeakMap(); // unit -> { sig, verdict }

  const log = (...a) => settings.debug && console.log('[fbab]', ...a);

  // ---------------------------------------------------------------- settings
  async function loadSettings() {
    if (!hasChrome) return;
    try {
      const s = await chrome.storage.sync.get(DEFAULTS);
      settings = { ...DEFAULTS, ...s };
    } catch (e) { /* extension reloaded; keep defaults */ }
  }
  if (hasChrome) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue;
      // Re-evaluate everything under new settings.
      document.querySelectorAll('[data-fbab],[data-fbab-debug]').forEach((el) => {
        el.removeAttribute('data-fbab');
        el.removeAttribute('data-fbab-debug');
        state.delete(el);
      });
      scheduleScan();
    });
    chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
      if (msg && msg.type === 'stats') reply({ ...stats, url: location.href });
    });
  }

  // ------------------------------------------------------- finding feed units
  // A "unit" is the element we hide: the direct child of a role=feed container,
  // or the outermost article when there is no feed (groups, permalinks, etc.).
  function findUnits() {
    const units = new Set();
    for (const feed of document.querySelectorAll('[role="feed"]')) {
      for (const child of feed.children) units.add(child);
    }
    for (const art of document.querySelectorAll('[role="article"], [aria-posinset], [data-pagelet^="FeedUnit"]')) {
      if (art.closest('[role="feed"]')) continue; // already covered by feed child
      if (art.parentElement && art.parentElement.closest('[role="article"]')) continue; // comment
      units.add(art);
    }
    // Right column "Sponsored" block.
    for (const comp of document.querySelectorAll('[role="complementary"]')) {
      for (const block of comp.querySelectorAll(':scope div > span > div, :scope [data-pagelet]')) {
        if (block.querySelector('a[href*="/ads/"]') || /sponsor/i.test(block.textContent.slice(0, 40))) {
          units.add(block);
        }
      }
    }
    return units;
  }

  // --------------------------------------------- rendered-text reconstruction
  const visCache = new Map();
  function isVisible(el) {
    let v = visCache.get(el);
    if (v !== undefined) return v;
    if (el.checkVisibility) {
      v = el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    } else {
      const cs = getComputedStyle(el);
      v = cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0;
    }
    if (v) {
      const cs = getComputedStyle(el);
      if (parseFloat(cs.fontSize) < 2) v = false;
      else if (cs.color === 'transparent' || /rgba\(.*,\s*0\)$/.test(cs.color)) v = false;
    }
    visCache.set(el, v);
    return v;
  }

  // Is the rect visually clipped away by an overflow:hidden ancestor between el and root?
  const clipCache = new Map();
  function clipRectFor(el, root) {
    if (clipCache.has(el)) return clipCache.get(el);
    let rect = null;
    for (let a = el; a && a !== root.parentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflow !== 'visible' || cs.clipPath !== 'none' || cs.clip !== 'auto') {
        const r = a.getBoundingClientRect();
        rect = rect ? intersect(rect, r) : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      }
    }
    clipCache.set(el, rect);
    return rect;
  }
  function intersect(a, b) {
    return {
      left: Math.max(a.left, b.left), top: Math.max(a.top, b.top),
      right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom),
    };
  }
  function overlaps(r, c) {
    return r.right > c.left + 0.5 && r.left < c.right - 0.5 && r.bottom > c.top + 0.5 && r.top < c.bottom - 0.5;
  }

  /**
   * Text of `root` as a human sees it, optionally only the top `maxY` px.
   * Returns { text, pieces } where text has lines joined by "\n".
   */
  function renderedText(root, maxY = Infinity, maxNodes = 600) {
    const box = root.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) return { text: '', pieces: [] };
    const area = { left: box.left, top: box.top, right: box.right, bottom: Math.min(box.bottom, box.top + maxY) };
    const pieces = [];
    const range = document.createRange();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node, count = 0;

    const accept = (r, el) => {
      if (r.width < 0.5 || r.height < 0.5) return false;
      if (!overlaps(r, area)) return false;
      const clip = clipRectFor(el, root);
      if (clip && !overlaps(r, clip)) return false;
      return true;
    };

    while ((node = walker.nextNode()) && count++ < maxNodes) {
      const text = node.nodeValue;
      if (!text || !text.trim()) continue;
      const el = node.parentElement;
      if (!el || !isVisible(el)) continue;
      if (el.closest('defs, symbol, script, style, template')) continue;

      if (text.length <= 12) {
        // Short nodes are where obfuscation lives: measure every glyph.
        let i = 0;
        for (const ch of text) { // iterate by code point so emoji stay whole
          const start = i;
          i += ch.length;
          if (!ch.trim()) continue;
          range.setStart(node, start);
          range.setEnd(node, i);
          const r = range.getBoundingClientRect();
          if (accept(r, el)) pieces.push({ t: ch, x: r.left, y: r.top, w: r.width, h: r.height });
        }
      } else {
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) {
          if (accept(r, el)) { pieces.push({ t: text.trim(), x: r.left, y: r.top, w: r.width, h: r.height }); break; }
        }
      }
    }

    // SVG <use href="#id"> pointing at a <text> defined elsewhere.
    for (const use of root.querySelectorAll('svg use')) {
      const href = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
      if (!href.startsWith('#')) continue;
      const target = document.getElementById(href.slice(1));
      const t = target && target.textContent.trim();
      if (!t) continue;
      const svg = use.ownerSVGElement || use;
      if (!isVisible(svg)) continue;
      const r = use.getBoundingClientRect();
      const rr = r.width > 0.5 ? r : svg.getBoundingClientRect();
      if (accept(rr, svg)) pieces.push({ t, x: rr.left, y: rr.top, w: rr.width, h: rr.height });
    }

    return { text: layout(pieces), pieces };
  }

  // Group pieces into lines by vertical position, sort by x, insert spaces at gaps.
  function layout(pieces) {
    if (!pieces.length) return '';
    pieces.sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2));
    const lines = [];
    for (const p of pieces) {
      // Same line if the vertical extents overlap by at least half the smaller height.
      const line = lines.find((l) => {
        const ov = Math.min(l.bottom, p.y + p.h) - Math.max(l.top, p.y);
        return ov >= 0.5 * Math.min(l.bottom - l.top, p.h);
      });
      if (line) {
        line.items.push(p);
        line.top = Math.min(line.top, p.y);
        line.bottom = Math.max(line.bottom, p.y + p.h);
        line.cy = (line.top + line.bottom) / 2;
      } else {
        lines.push({ top: p.y, bottom: p.y + p.h, cy: p.y + p.h / 2, items: [p] });
      }
    }
    lines.sort((a, b) => a.cy - b.cy);
    return lines.map((l) => {
      l.items.sort((a, b) => a.x - b.x);
      let s = '', prevRight = null;
      for (const p of l.items) {
        if (prevRight !== null && p.x - prevRight > p.h * 0.2) s += ' ';
        s += p.t;
        prevRight = p.x + p.w;
      }
      return s;
    }).join('\n');
  }

  // Accessible-name hints Facebook sometimes uses for the label.
  function ariaHints(root) {
    const out = [];
    for (const el of root.querySelectorAll('[aria-labelledby]')) {
      for (const id of el.getAttribute('aria-labelledby').split(/\s+/)) {
        const t = document.getElementById(id);
        if (t && t.textContent) out.push(t.textContent.trim());
      }
      if (out.length > 20) break;
    }
    return out;
  }

  function buttonLabels(root) {
    const out = new Set();
    for (const b of root.querySelectorAll('[role="button"], a[role="link"], button')) {
      if (out.size >= 12) break;
      const r = b.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || !isVisible(b)) continue;
      const t = (b.getAttribute('aria-label') || b.innerText || '').trim().replace(/\s+/g, ' ');
      if (t && t.length <= 40) out.add(t);
    }
    return [...out];
  }

  // True when a header line *is* a sponsored label, e.g. "Sponsored · 🌐",
  // "S p o n s o r e d", "Acme Shoes · Sponsored". Not when the word is part of
  // a sentence ("Sponsored by my mom lol").
  const isLetter = (ch) => !!ch && /\p{L}/u.test(ch);
  function hasSponsoredLabel(headerText, hints) {
    for (const line of headerText.split('\n').concat(hints)) {
      const sq = norm(line); // whitespace removed: defeats per-letter spacing
      if (!sq) continue;
      const t = line.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
      for (let i = 0; i < SPONSORED_NORM.length; i++) {
        const w = SPONSORED_NORM[i];
        // Line starts with the label and continues with a non-letter ("·", globe icon...).
        if (sq.startsWith(w) && !isLetter(sq[w.length])) return true;
        // Label at the end of a line, after a separator: "Acme · Sponsored".
        const wt = SPONSORED_TIDY[i];
        const idx = t.lastIndexOf(wt);
        if (idx > 0 && !isLetter(t[idx - 1]) && !/[\p{L}\p{N}]/u.test(t.slice(idx + wt.length))) {
          const before = t.slice(0, idx).trimEnd();
          if (/[·•|∙⋅・-]$/u.test(before)) return true;
        }
      }
    }
    return false;
  }

  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  }

  // ---------------------------------------------------------------- deciding
  function hide(unit, label, reason) {
    if (label === 'ad') stats.hiddenAds++; else stats.hiddenSuggested++;
    unit.setAttribute('data-fbab-label', label === 'ad' ? 'Ad' : 'Suggested post');
    unit.setAttribute('data-fbab-reason', reason);
    unit.setAttribute('data-fbab', settings.showPlaceholder ? 'collapsed' : 'hidden');
    unit.removeAttribute('data-fbab-debug');
    log('hid', label, reason, unit);
  }

  let aiInFlight = 0;
  const aiQueue = [];
  function askAI(features) {
    return new Promise((resolve) => {
      aiQueue.push({ features, resolve });
      pumpAI();
    });
  }
  function pumpAI() {
    // On-device model: one at a time (CPU-bound; parallel sessions untested for stability).
    const maxInFlight = settings.provider === 'builtin' ? 1 : 2;
    while (aiInFlight < maxInFlight && aiQueue.length) {
      const { features, resolve } = aiQueue.shift();
      aiInFlight++;
      stats.aiCalls++;
      chrome.runtime.sendMessage({ type: 'classify', features })
        .then((res) => resolve(res || { label: 'unknown' }))
        .catch((e) => { log('ai error', e); resolve({ label: 'unknown', error: String(e) }); })
        .finally(() => { aiInFlight--; pumpAI(); });
    }
  }

  async function evaluate(unit) {
    if (unit.hasAttribute('data-fbab')) return; // already decided
    const header = renderedText(unit, HEADER_HEIGHT_PX);
    if (!header.text) return; // not rendered yet / placeholder skeleton
    const hints = ariaHints(unit);
    const sig = hash(header.text + '|' + hints.join('|'));
    const st = state.get(unit) || {};
    if (st.sig === sig) return; // nothing changed since last look
    st.sig = sig;
    state.set(unit, st);
    stats.scanned++;

    // 1. Deterministic fast path.
    if (hasSponsoredLabel(header.text, hints) || unit.querySelector('a[href*="/ads/about"]')) {
      stats.label++;
      hide(unit, 'ad', 'label');
      return;
    }

    // 2. AI.
    if (!hasChrome || settings.provider === 'none') {
      if (settings.debug) unit.setAttribute('data-fbab-debug', 'organic');
      return;
    }
    if (settings.debug) unit.setAttribute('data-fbab-debug', 'pending');
    const body = renderedText(unit, 700, 400).text.slice(header.text.length, header.text.length + 500);
    const features = {
      header: header.text.slice(0, 300),
      body: body.trim(),
      buttons: buttonLabels(unit),
    };
    const res = await askAI(features);
    if (state.get(unit) !== st || st.sig !== sig || unit.hasAttribute('data-fbab')) return; // stale
    log('ai', res.label, features);
    if (res.label === 'ad') hide(unit, 'ad', 'AI');
    else if (res.label === 'suggested' && settings.hideSuggested) hide(unit, 'suggested', 'AI');
    else if (settings.debug) unit.setAttribute('data-fbab-debug', 'organic');
  }

  // ----------------------------------------------------------------- driver
  let scanTimer = null;
  function scheduleScan(delay = 250) {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, delay);
  }

  function scan() {
    if (!settings.enabled) return;
    visCache.clear();
    clipCache.clear();
    const vh = window.innerHeight || 800;
    for (const unit of findUnits()) {
      if (unit.hasAttribute('data-fbab')) continue;
      const r = unit.getBoundingClientRect();
      // Only look at units near the viewport; the feed is virtualized anyway.
      if (r.bottom < -vh || r.top > vh * 3) continue;
      evaluate(unit).catch((e) => log('evaluate failed', e));
    }
  }

  // Click a collapsed placeholder to reveal it.
  document.addEventListener('click', (e) => {
    const el = e.target;
    if (el instanceof Element && el.getAttribute('data-fbab') === 'collapsed') {
      e.preventDefault();
      e.stopPropagation();
      el.setAttribute('data-fbab', 'revealed');
    }
  }, true);

  new MutationObserver(() => scheduleScan()).observe(document.documentElement, {
    childList: true, subtree: true, characterData: true,
  });
  window.addEventListener('scroll', () => scheduleScan(400), { passive: true });

  // Exposed for the offline test harness and for poking at from DevTools.
  window.__fbab = { renderedText, hasSponsoredLabel, stats, scan, settings: () => settings };

  loadSettings().then(scan);
})();
