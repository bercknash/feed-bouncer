// Service worker: receives classification requests from the content script and
// routes them to the configured LLM provider, with a small cache.
importScripts('llm.js');

const CACHE_MAX = 3000;
const cache = new Map(); // key -> label (insertion-ordered => cheap LRU)

function cacheKey(f) {
  return JSON.stringify([f.header, f.body, f.buttons]);
}
function remember(key, label) {
  if (label === 'unknown') return;
  cache.delete(key);
  cache.set(key, label);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

async function getConfig() {
  const sync = await chrome.storage.sync.get({ provider: 'builtin', baseUrl: '', model: '' });
  const local = await chrome.storage.local.get({ apiKey: '' }); // keys never sync
  return { ...sync, ...local };
}

// --- Offscreen fallback: some Chrome builds expose LanguageModel to extension
// pages but not to the service worker. In that case we run it in an offscreen doc.
let creatingOffscreen = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['DOM_PARSER'],
      justification: 'Run the on-device language model to classify feed posts.',
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function classifyBuiltin(features) {
  if (fbabHasBuiltin()) return fbabClassifyBuiltin(features);
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: 'offscreen', type: 'classify', features });
}

async function classify(features) {
  const key = cacheKey(features);
  if (cache.has(key)) return { label: cache.get(key), cached: true };
  const cfg = await getConfig();
  let res;
  try {
    if (cfg.provider === 'builtin') res = await classifyBuiltin(features);
    else if (cfg.provider === 'openai') res = await fbabClassifyOpenAI(features, cfg);
    else res = { label: 'unknown', error: 'AI disabled' };
  } catch (e) {
    res = { label: 'unknown', error: String(e && e.message || e) };
  }
  if (res && res.error) console.warn('[fbab] classify error:', res.error);
  remember(key, res.label);
  return res;
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.target === 'offscreen') return false;
  if (msg.type === 'classify') {
    classify(msg.features).then(reply);
    return true; // async reply
  }
  if (msg.type === 'clearCache') {
    cache.clear();
    reply({ ok: true });
    return false;
  }
  return false;
});
