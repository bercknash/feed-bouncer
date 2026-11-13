// Shared classifier logic. Loaded by the service worker (importScripts) and by
// offscreen.html (<script>), so it must not use ES module syntax.

const FBAB_SYSTEM_PROMPT = `You label items from a Facebook news feed. You are given the text of ONE feed item exactly as it appears on screen (header lines, start of the body, and button labels).

Labels:
- "ad": paid advertising. Strong signals: a "Sponsored" label (any language) under the page name where a normal post shows its timestamp; call-to-action buttons like "Shop now", "Learn more", "Sign up", "Install now", "Get offer", "Book now", "Send message", "Apply now", "Get quote", "Download", "Order now"; a brand/business pitching a product, sale, app or service, often with a link-preview domain.
- "suggested": not paid, but injected by Facebook from accounts the user does not follow: "Suggested for you", "Follow" or "Join" buttons in the header, "People you may know", "Reels", "Suggested groups".
- "organic": a normal post from a friend, page or group the user already follows. Normal posts show a timestamp such as "3h", "15m", "Yesterday at 4:12 PM", "October 2" next to the author.

A missing timestamp plus a call-to-action button almost always means "ad".
Reply with JSON only: {"label": "ad" | "suggested" | "organic"}`;

const FBAB_SCHEMA = {
  type: 'object',
  properties: { label: { type: 'string', enum: ['ad', 'suggested', 'organic'] } },
  required: ['label'],
  additionalProperties: false,
};

function fbabUserPrompt(f) {
  return [
    'HEADER:',
    f.header || '(none)',
    '',
    'BODY (start):',
    f.body || '(none)',
    '',
    'BUTTONS: ' + (f.buttons && f.buttons.length ? f.buttons.join(' | ') : '(none)'),
  ].join('\n');
}

function fbabParseLabel(text) {
  if (!text) return 'unknown';
  // Reasoning models (qwen3, deepseek-r1...) may emit <think>...</think> first.
  text = String(text).replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').trim();
  try {
    const j = JSON.parse(text.replace(/^```(?:json)?|```$/g, '').trim());
    if (j && ['ad', 'suggested', 'organic'].includes(j.label)) return j.label;
  } catch (_) { /* fall through */ }
  const lm = text.match(/"label"\s*:\s*"(ad|suggested|organic)"/i);
  if (lm) return lm[1].toLowerCase();
  // Otherwise trust the last label word: the final answer comes after any reasoning.
  const all = text.toLowerCase().match(/\b(ad|suggested|organic)\b/g);
  return all ? all[all.length - 1] : 'unknown';
}

// ---------------------------------------------------------- Chrome on-device
const FBAB_LANG_OPTS = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};
let fbabBaseSession = null;

function fbabHasBuiltin() {
  return typeof self.LanguageModel !== 'undefined';
}

async function fbabBuiltinAvailability() {
  if (!fbabHasBuiltin()) return 'unsupported';
  return LanguageModel.availability(FBAB_LANG_OPTS);
}

// Used by the options page to trigger (and show progress of) the model download.
async function fbabBuiltinSession(onProgress) {
  if (fbabBaseSession) return fbabBaseSession;
  fbabBaseSession = await LanguageModel.create({
    ...FBAB_LANG_OPTS,
    monitor(m) {
      if (onProgress) m.addEventListener('downloadprogress', (e) => onProgress(e.loaded));
    },
  });
  return fbabBaseSession;
}

// One fresh session per classification. We deliberately do NOT clone() a base
// session: on Chrome 157's CPU backend (OnDeviceModelForceCpuBackend), prompting
// a clone crashes the model service (SIGSEGV) on the 2nd-3rd use. A fresh session
// costs about 1 s more per post but has been stable. Results are cached, and most ads
// are caught by the "Sponsored" label check without reaching the model.
async function fbabPromptFresh(features) {
  const s = await LanguageModel.create({
    ...FBAB_LANG_OPTS,
    initialPrompts: [{ role: 'system', content: FBAB_SYSTEM_PROMPT }],
  });
  try {
    const out = await s.prompt(fbabUserPrompt(features), { responseConstraint: FBAB_SCHEMA });
    return { label: fbabParseLabel(out), raw: out };
  } finally {
    s.destroy();
  }
}

async function fbabClassifyBuiltin(features) {
  const avail = await fbabBuiltinAvailability();
  if (avail !== 'available') return { label: 'unknown', error: 'on-device model ' + avail };
  try {
    return await fbabPromptFresh(features);
  } catch (e) {
    // The model service may have just restarted; one retry.
    console.warn('[fbab] on-device prompt failed, retrying once:', e);
    await new Promise((r) => setTimeout(r, 500));
    return fbabPromptFresh(features);
  }
}

// ---------------------------------------------------- OpenAI-compatible API
// Works with OpenAI, OpenRouter, Ollama (http://localhost:11434/v1), LM Studio,
// Groq, Meta's Llama API, etc. Anything exposing POST {base}/chat/completions.
async function fbabClassifyOpenAI(features, cfg) {
  const base = (cfg.baseUrl || '').replace(/\/+$/, '');
  if (!base || !cfg.model) return { label: 'unknown', error: 'endpoint not configured' };
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = 'Bearer ' + cfg.apiKey;
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      max_tokens: 400, // headroom for models that reason before answering
      response_format: cfg.jsonMode === false ? undefined : { type: 'json_object' },
      messages: [
        { role: 'system', content: FBAB_SYSTEM_PROMPT },
        { role: 'user', content: fbabUserPrompt(features) },
      ],
    }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    // Some servers reject response_format; retry once without it.
    if (res.status === 400 && cfg.jsonMode !== false && /response_format|json/i.test(body)) {
      return fbabClassifyOpenAI(features, { ...cfg, jsonMode: false });
    }
    let hint = '';
    if (res.status === 403 && /localhost|127\.0\.0\.1/.test(base)) {
      hint = ' (Ollama is rejecting the extension origin: restart it with OLLAMA_ORIGINS="chrome-extension://*")';
    }
    return { label: 'unknown', error: 'HTTP ' + res.status + ' ' + body + hint };
  }
  const j = await res.json();
  const out = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  return { label: fbabParseLabel(out), raw: out };
}
