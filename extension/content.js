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

  const stats = { scanned: 0, hiddenAds: 0, hiddenSuggested: 0, aiCalls: 0, label: 0, skippedAI: 0 };
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

  // Facebook (2026) draws the line under the author name ("2 hours ago" / "Ad")
  // as an SVG glyph image and puts the readable text in a hidden element that the
  // link points to via aria-labelledby. Read those, but only in the header area so
  // comment timestamps further down don't count.
  function ariaHints(root) {
    const out = [];
    const top = root.getBoundingClientRect().top;
    for (const el of root.querySelectorAll('[aria-labelledby]')) {
      const r = el.getBoundingClientRect();
      if (r.height < 1 || r.top - top > HEADER_HEIGHT_PX) continue;
      for (const id of el.getAttribute('aria-labelledby').split(/\s+/)) {
        const t = document.getElementById(id);
        const txt = t && t.textContent && t.textContent.trim();
        if (txt && txt.length <= 60) out.push(txt);
      }
      if (out.length >= 8) break;
    }
    return out;
  }

  // Short ad labels. Too ambiguous to match inside a line, so they only count
  // when a header line or an aria label is exactly this word.
  const AD_EXACT = new Set(['ad', 'ads', 'anzeige', 'publicité', 'anuncio', 'annuncio', 'advertentie', 'annonce',
    'reklam', 'reklama', 'реклама', 'mainos', 'hirdetés', 'διαφήμιση', 'quảng cáo', 'iklan', 'annons', 'annonse',
    '広告', '광고', '广告', '廣告', 'פרסומת', 'إعلان', 'विज्ञापन', 'โฆษณา', 'publicidade', 'reclame'].map(norm));

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
      if (AD_EXACT.has(sq.replace(/[·•|∙⋅・\-:]+$/u, ''))) return true;
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

  // ---- Cheap pre-AI triage. Organic posts show a timestamp where ads show
  // "Sponsored"; ads often carry a call-to-action button. Only posts that lack a
  // timestamp or have a CTA go to the (slow) model.
  const TIMESTAMP_RES = [
    /(^|[\s·•])\d{1,3}\s?(s|m|h|d|w|y|sec|min|mins|hr|hrs|wk|wks|yr|yrs)(?![\p{L}])/iu, // 3h, 15m, 2d, 1w
    /\b(just now|yesterday|today)\b/i,
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i, // October 2
    /\b\d{1,2}\.?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i, // 2 October
    /\b\d{1,2}:\d{2}\b/, // 4:12 PM
    /\b(\d+|an?|one)\s+(second|minute|hour|day|week|month|year)s?\s+ago\b/i, // 2 hours ago (aria label)
  ];
  function hasTimestamp(headerText, hints = []) {
    return headerText.split('\n').concat(hints)
      .some((line) => line.length <= 80 && TIMESTAMP_RES.some((re) => re.test(line)));
  }
  const LABEL_GRACE_MS = 2000;
  const GLYPH_AD_MAX_RATIO = 2.0;
  const GLYPH_TIMESTAMP_MIN_RATIO = 3.0;
  let narrowTimestampSeen = false;

  // The SVG glyph image in the "Ad" / "2 hours ago" slot under the author name.
  function metaGlyph(unit) {
    const top = unit.getBoundingClientRect().top;
    for (const span of unit.querySelectorAll('a span[aria-labelledby]')) {
      const use = span.querySelector('svg use');
      if (!use) continue;
      const r = use.getBoundingClientRect();
      if (r.height < 6 || r.width < 1 || r.top - top > HEADER_HEIGHT_PX) continue;
      return { ratio: r.width / r.height, span };
    }
    return null;
  }

  // Readable text behind the glyph, read without layout (works while hidden).
  function metaLabelText(unit) {
    const span = unit.querySelector('a span[aria-labelledby]');
    if (!span) return '';
    const t = document.getElementById(span.getAttribute('aria-labelledby').split(/\s+/)[0]);
    return (t && t.textContent || '').trim();
  }

  // Undo a glyph-based hide if the label later turns out to be a timestamp.
  function recheckGlyphHides() {
    for (const unit of document.querySelectorAll('[data-fbab-reason="glyph"]')) {
      if (unit.getAttribute('data-fbab') === 'revealed') continue;
      const txt = metaLabelText(unit);
      if (!txt) continue;
      if (hasTimestamp('', [txt])) {
        narrowTimestampSeen = true;
        stats.hiddenAds--;
        unit.removeAttribute('data-fbab');
        unit.removeAttribute('data-fbab-reason');
        unit.removeAttribute('data-fbab-label');
        state.delete(unit);
        log('glyph rule was wrong; restored post and disabled the width rule', txt);
      } else if (hasSponsoredLabel('', [txt])) {
        unit.setAttribute('data-fbab-reason', 'label'); // confirmed by the readable label
      }
    }
  }
  // Reels / People-you-may-know / suggested-groups carousels: no timestamp by design.
  const CAROUSEL_LABEL_RE = /^(reels|previous items|next items|people you may know|suggested groups|stories)$|^reel by /i;
  function isCarousel(unit) {
    for (const el of unit.querySelectorAll('[aria-label]')) {
      if (CAROUSEL_LABEL_RE.test(el.getAttribute('aria-label').trim())) return true;
    }
    return false;
  }
  const SUGGESTED_RE =/\b(suggested for you|people you may know|suggested groups|reels and short videos|follow|join)\b/i;

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
  function askAI(features, unit) {
    return new Promise((resolve) => {
      aiQueue.push({ features, unit, resolve });
      pumpAI();
    });
  }
  // Distance from the viewport (0 = on screen). Used to serve what the user is
  // looking at first and to drop work for posts they've scrolled far past.
  function viewportDistance(unit) {
    const r = unit.getBoundingClientRect();
    const vh = window.innerHeight || 800;
    if (r.height === 0) return Infinity;
    if (r.bottom < 0) return -r.bottom;
    if (r.top > vh) return r.top - vh;
    return 0;
  }
  function nextAIJob() {
    let best = -1, bestD = Infinity;
    for (let i = aiQueue.length - 1; i >= 0; i--) {
      const job = aiQueue[i];
      const d = job.unit.isConnected && !job.unit.hasAttribute('data-fbab') ? viewportDistance(job.unit) : Infinity;
      if (d > (window.innerHeight || 800) * 3) { // decided, gone, or far away: drop
        aiQueue.splice(i, 1);
        job.resolve({ label: 'unknown', skipped: true });
        if (best > i) best--;
        continue;
      }
      if (d < bestD) { bestD = d; best = i; }
    }
    return best < 0 ? null : aiQueue.splice(best, 1)[0];
  }
  function pumpAI() {
    // On-device model: one at a time (CPU-bound; parallel sessions untested for stability).
    const maxInFlight = settings.provider === 'builtin' ? 1 : 2;
    while (aiInFlight < maxInFlight && aiQueue.length) {
      const job = nextAIJob();
      if (!job) break;
      const { features, resolve } = job;
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

    // 1b. Glyph-shape fast path. The line under the author is an SVG glyph image
    // that is drawn immediately, while its readable aria label is filled in lazily
    // (often seconds later). "Ad" draws as a roughly square glyph (17x15 px);
    // timestamps ("2 days ago") are 4x wider than tall or more.
    const glyph = metaGlyph(unit);
    if (glyph && glyph.ratio < GLYPH_AD_MAX_RATIO) {
      if (hasTimestamp(header.text, hints)) {
        narrowTimestampSeen = true; // short timestamps exist here: width rule is unsafe
      } else if (!narrowTimestampSeen) {
        stats.label++;
        hide(unit, 'ad', 'glyph');
        return;
      }
    }

    // 2. Cheap triage: most of the feed is decided here without the model.
    const buttons = buttonLabels(unit);
    const headerLines = header.text.split('\n').slice(0, 3).join('\n');
    const carousel = isCarousel(unit);
    if (settings.hideSuggested && (SUGGESTED_RE.test(headerLines) || carousel)) {
      hide(unit, 'suggested', 'label');
      return;
    }
    // A timestamp where an ad would say "Ad" means a normal post, even if it has a
    // "Learn more" button (link previews carry those).
    // A wide glyph in the label slot is a timestamp ("2 days ago"). If it were a
    // long ad label instead, the readable-label check above hides it once Facebook
    // fills the label in, so the worst case is a delay, never a false hide.
    const wideGlyph = glyph && glyph.ratio >= GLYPH_TIMESTAMP_MIN_RATIO;
    if (hasTimestamp(header.text, hints) || carousel || wideGlyph) {
      stats.skippedAI++;
      if (settings.debug) unit.setAttribute('data-fbab-debug', 'organic');
      return;
    }
    // Facebook fills the hidden "Ad" / "2 hours ago" label lazily as the post nears
    // the viewport. Give it a moment before paying for an AI call.
    if (!st.firstUnsure) st.firstUnsure = performance.now();
    if (performance.now() - st.firstUnsure < LABEL_GRACE_MS) {
      st.sig = null; // force re-evaluation
      setTimeout(() => scheduleScan(0), 400);
      return;
    }

    // 3. AI, only for suspicious posts (no timestamp, or a call-to-action button).
    if (!hasChrome || settings.provider === 'none') {
      if (settings.debug) unit.setAttribute('data-fbab-debug', 'organic');
      return;
    }
    if (settings.debug) unit.setAttribute('data-fbab-debug', 'pending');
    const body = renderedText(unit, 700, 400).text.slice(header.text.length, header.text.length + 500);
    const features = {
      header: header.text.slice(0, 300),
      body: body.trim(),
      buttons,
    };
    const res = await askAI(features, unit);
    if (res.skipped) { st.sig = null; return; } // dropped from queue; re-evaluate if it comes back into view
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
    recheckGlyphHides();
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
  window.__fbab = { renderedText, hasSponsoredLabel, hasTimestamp, stats, scan, settings: () => settings };

  loadSettings().then(scan);
})();
