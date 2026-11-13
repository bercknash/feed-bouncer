const $ = (id) => document.getElementById(id);
const SYNC_DEFAULTS = { provider: 'builtin', baseUrl: '', model: '', hideSuggested: false, showPlaceholder: true, debug: false };

const SAMPLES = [
  { expect: 'ad', features: { header: 'Acme Running Co.\nSponsored · 🌐', body: 'Our lightest shoe ever. 40% off this weekend only.', buttons: ['Shop now', 'Like', 'Comment', 'Share'] } },
  { expect: 'ad', features: { header: 'BudgetBuddy App', body: 'Stop overspending. Join 2M people who track every dollar.\nBUDGETBUDDY.COM\nTry it free for 30 days', buttons: ['Install now', 'Like', 'Comment'] } },
  { expect: 'organic', features: { header: 'Jane Doe\n3h · 🌐', body: 'Finally finished the deck! Thanks Dad for the help 🙂', buttons: ['Like', 'Comment', 'Share'] } },
  { expect: 'suggested', features: { header: 'Suggested for you\nGarden Hacks Daily · Follow\n2d · 🌐', body: '10 plants that thrive in shade', buttons: ['Follow', 'Like', 'Comment'] } },
];

function show(msg) { $('status').textContent = msg; }
function out(text) { $('out').hidden = false; $('out').textContent = text; }

function syncProviderFields() { $('openaiFields').hidden = $('provider').value !== 'openai'; }

async function load() {
  const s = await chrome.storage.sync.get(SYNC_DEFAULTS);
  const l = await chrome.storage.local.get({ apiKey: '' });
  for (const k of ['provider', 'baseUrl', 'model']) $(k).value = s[k];
  for (const k of ['hideSuggested', 'showPlaceholder', 'debug']) $(k).checked = s[k];
  $('apiKey').value = l.apiKey;
  syncProviderFields();
}

async function save() {
  const provider = $('provider').value;
  const baseUrl = $('baseUrl').value.trim();
  if (provider === 'openai' && baseUrl) {
    // Need host permission to call the endpoint from the service worker.
    let origin;
    try { origin = new URL(baseUrl).origin + '/*'; } catch (_) { show('Invalid base URL'); return false; }
    const ok = await chrome.permissions.request({ origins: [origin] });
    if (!ok) { show('Permission to reach ' + origin + ' was denied.'); return false; }
  }
  await chrome.storage.sync.set({
    provider, baseUrl, model: $('model').value.trim(),
    hideSuggested: $('hideSuggested').checked,
    showPlaceholder: $('showPlaceholder').checked,
    debug: $('debug').checked,
  });
  await chrome.storage.local.set({ apiKey: $('apiKey').value });
  await chrome.runtime.sendMessage({ type: 'clearCache' });
  show('Saved.');
  return true;
}

async function test() {
  if (!(await save())) return;
  const provider = $('provider').value;
  if (provider === 'none') { out('AI is off. Only the “Sponsored” label check runs.'); return; }

  if (provider === 'builtin') {
    // Creating the session here (with a user gesture) is what triggers the model download.
    const avail = await fbabBuiltinAvailability();
    out('On-device model availability: ' + avail);
    if (avail === 'unsupported') {
      out('This Chrome does not expose the Prompt API (LanguageModel).\nNeeds Chrome 138+ on desktop with enough disk/GPU or RAM. See chrome://on-device-internals');
      return;
    }
    if (avail === 'unavailable') {
      out('The on-device model is unavailable on this device (hardware requirements not met). Pick a custom endpoint instead.');
      return;
    }
    if (avail !== 'available') {
      show('Downloading model… this can take a few minutes the first time.');
      await fbabBuiltinSession((p) => show('Downloading model… ' + Math.round(p * 100) + '%'));
    }
  }

  show('Running test posts…');
  const lines = [];
  let correct = 0;
  for (const s of SAMPLES) {
    const t0 = performance.now();
    const res = await chrome.runtime.sendMessage({ type: 'classify', features: s.features });
    const ms = Math.round(performance.now() - t0);
    const ok = res.label === s.expect;
    if (ok) correct++;
    lines.push(`${ok ? '✔' : '✘'} expected ${s.expect.padEnd(9)} got ${String(res.label).padEnd(9)} ${ms}ms  ${s.features.header.split('\n')[0]}${res.error ? '  ERROR: ' + res.error : ''}`);
  }
  out(lines.join('\n'));
  show(`${correct}/${SAMPLES.length} correct`);
}

$('provider').addEventListener('change', syncProviderFields);
$('save').addEventListener('click', save);
$('test').addEventListener('click', () => test().catch((e) => out('Error: ' + (e && e.message || e))));
load();
