// FB AI Ad Blocker: page-world script (runs in Facebook's own JS context).
//
// Facebook's server tells the page which feed items are ads: every feed edge
// handed to React carries a "sponsored data" field that is an object for ads and
// null for everything else. That data exists the moment a post mounts, long
// before the readable "Ad" label is filled in, and none of the DOM obfuscation
// touches it. So we read it straight from React's component tree and stamp the
// verdict on the post's element; content.js (isolated world) does the hiding.
//
// Facebook's React build keeps no fiber pointers on DOM nodes, only on the root
// container, so we walk down from the root and stop at each feed item. With that
// pruning a pass visits a few thousand fibers and takes well under a millisecond,
// which is cheap enough to run on every DOM mutation, i.e. before the new post
// is painted.
(() => {
  'use strict';
  if (window.__fbabPage) return;

  const ATTR = 'data-fbab-verdict';
  const EDGE_PROP = 'feedEdge';

  // The field is a GraphQL alias that Facebook scrambles now and then
  // (sponsored_data -> th_dat_spo -> pso_tad_rens). Besides the names seen so
  // far, accept any key that is made only of letters from "sponsored_data".
  const KNOWN_AD_KEYS = new Set(['sponsored_data', 'th_dat_spo', 'pso_tad_rens']);
  const LETTER_POOL = {};
  for (const ch of 'sponsoreddata') LETTER_POOL[ch] = (LETTER_POOL[ch] || 0) + 1;
  const keyCache = new Map();
  function isAdDataKey(key) {
    let hit = keyCache.get(key);
    if (hit !== undefined) return hit;
    hit = KNOWN_AD_KEYS.has(key);
    if (!hit && !key.startsWith('__')) {
      const letters = key.replace(/_/g, '').toLowerCase();
      if (letters.length >= 8 && letters.length <= 13) {
        const used = {};
        hit = true;
        for (const ch of letters) {
          used[ch] = (used[ch] || 0) + 1;
          if (used[ch] > (LETTER_POOL[ch] || 0)) { hit = false; break; }
        }
      }
    }
    keyCache.set(key, hit);
    return hit;
  }

  // 'ad' | 'organic' | 'unknown'. "organic" is only claimed when the sponsored
  // field is present and empty; if Facebook renames it beyond recognition we say
  // "unknown" and content.js falls back to reading the rendered label.
  function verdictFor(edge) {
    if (!edge || typeof edge !== 'object') return 'unknown';
    for (const k in edge) {
      const v = edge[k];
      if (v && typeof v === 'object' && v.cat === 'SPONSORED') return 'ad';
    }
    const node = edge.node;
    if (!node || typeof node !== 'object') return 'unknown';
    let sawField = false;
    for (const k in node) {
      if (!isAdDataKey(k)) continue;
      sawField = true;
      if (node[k]) return 'ad';
    }
    return sawField ? 'organic' : 'unknown';
  }

  // ------------------------------------------------------------ React access
  let container = null;
  let containerKey = null;
  function findContainer() {
    if (container && container.isConnected) return true;
    container = null;
    const candidates = [...document.querySelectorAll('[id^="mount_"]')];
    if (document.body) candidates.push(...document.body.children);
    for (const el of candidates) {
      const key = Object.getOwnPropertyNames(el).find((k) => k.startsWith('__reactContainer$'));
      if (key) { container = el; containerKey = key; return true; }
    }
    return false;
  }
  function currentRootFiber() {
    if (!findContainer()) return null;
    const f = container[containerKey];
    return (f && f.stateNode && f.stateNode.current) || f || null;
  }

  // The outermost DOM elements rendered by a fiber.
  function hostElements(fiber) {
    const out = [];
    const queue = [fiber.child];
    while (queue.length && out.length < 4) {
      const f = queue.shift();
      if (!f) continue;
      if (f.sibling) queue.push(f.sibling);
      if (typeof f.type === 'string') {
        if (f.stateNode instanceof Element) out.push(f.stateNode);
      } else if (f.child) {
        queue.push(f.child);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ sweep
  const stats = { sweeps: 0, edges: 0, ads: 0, organic: 0, unknown: 0, lastMs: 0 };
  const edgeVerdicts = new WeakMap();

  function sweep() {
    const t0 = performance.now();
    const root = currentRootFiber();
    if (!root) return 0;
    let edges = 0, ads = 0, organic = 0, unknown = 0;
    const stack = [root];
    while (stack.length) {
      const f = stack.pop();
      if (f.sibling) stack.push(f.sibling);
      const p = f.memoizedProps;
      if (p !== null && typeof p === 'object' && p[EDGE_PROP] !== undefined) {
        const edge = p[EDGE_PROP];
        if (edge && typeof edge === 'object') {
          edges++;
          let v = edgeVerdicts.get(edge);
          if (v === undefined) { v = verdictFor(edge); edgeVerdicts.set(edge, v); }
          if (v === 'ad') ads++; else if (v === 'organic') organic++; else unknown++;
          for (const el of hostElements(f)) {
            if (el.getAttribute(ATTR) !== v) el.setAttribute(ATTR, v);
          }
        }
        continue; // never descend into a post: that is where most of the tree lives
      }
      if (f.child) stack.push(f.child);
    }
    stats.sweeps++;
    stats.edges = edges; stats.ads = ads; stats.organic = organic; stats.unknown = unknown;
    stats.lastMs = performance.now() - t0;
    // Health summary for the popup (content.js cannot see page-world variables).
    const summary = `${edges},${ads},${organic},${unknown}`;
    const html = document.documentElement;
    if (html && html.getAttribute('data-fbab-data') !== summary) html.setAttribute('data-fbab-data', summary);
    return stats.lastMs;
  }

  // Run inside the mutation callback, so a verdict lands in the same frame the
  // post was added. On pages without a feed nothing gets pruned and a pass costs
  // a few ms; there we back off so the walk stays under ~5% of the main thread.
  let nextAllowed = 0;
  let trailing = null;
  function onMutation() {
    const now = performance.now();
    if (now < nextAllowed) {
      if (!trailing) trailing = setTimeout(() => { trailing = null; onMutation(); }, nextAllowed - now + 1);
      return;
    }
    let ms = 0;
    try { ms = sweep(); } catch (e) { ms = 50; /* unexpected tree shape: retry slowly */ }
    nextAllowed = ms > 1 ? performance.now() + ms * 20 : 0;
  }

  new MutationObserver(onMutation).observe(document, { childList: true, subtree: true });
  window.__fbabPage = { sweep, stats, verdictFor, isAdDataKey };
  onMutation();
})();
