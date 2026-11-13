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
  try {
    const j = JSON.parse(text.trim().replace(/^```(?:json)?|```$/g, ''));
    if (j && ['ad', 'suggested', 'organic'].includes(j.label)) return j.label;
  } catch (_) { /* fall through */ }
  const m = String(text).toLowerCase().match(/\b(ad|suggested|organic)\b/);
  return m ? m[1] : 'unknown';
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

async function fbabBuiltinSession(onProgress) {
  if (fbabBaseSession) return fbabBaseSession;
  fbabBaseSession = await LanguageModel.create({
    ...FBAB_LANG_OPTS,
    temperature: 0.1,
    topK: 1,
    initialPrompts: [{ role: 'system', content: FBAB_SYSTEM_PROMPT }],
    monitor(m) {
      if (onProgress) m.addEventListener('downloadprogress', (e) => onProgress(e.loaded));
    },
  });
  return fbabBaseSession;
}

async function fbabClassifyBuiltin(features) {
  const avail = await fbabBuiltinAvailability();
  if (avail !== 'available') return { label: 'unknown', error: 'on-device model ' + avail };
  const base = await fbabBuiltinSession();
  // Clone so each classification starts from the bare system prompt and the
  // context window does not fill up over a long scrolling session.
  const s = await base.clone();
  try {
    const out = await s.prompt(fbabUserPrompt(features), { responseConstraint: FBAB_SCHEMA });
    return { label: fbabParseLabel(out), raw: out };
  } finally {
    s.destroy();
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
      max_tokens: 20,
      messages: [
        { role: 'system', content: FBAB_SYSTEM_PROMPT },
        { role: 'user', content: fbabUserPrompt(features) },
      ],
    }),
  });
  if (!res.ok) return { label: 'unknown', error: 'HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200) };
  const j = await res.json();
  const out = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  return { label: fbabParseLabel(out), raw: out };
}
