const $ = (id) => document.getElementById(id);
const PROVIDERS = { builtin: 'Chrome on-device AI', openai: 'Custom endpoint', none: 'Label check only (no AI)' };

(async () => {
  const s = await chrome.storage.sync.get({ enabled: true, hideSuggested: false, provider: 'builtin' });
  $('enabled').checked = s.enabled;
  $('hideSuggested').checked = s.hideSuggested;
  $('provider').textContent = 'Classifier: ' + (PROVIDERS[s.provider] || s.provider);

  for (const k of ['enabled', 'hideSuggested']) {
    $(k).addEventListener('change', () => chrome.storage.sync.set({ [k]: $(k).checked }));
  }
  $('opts').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/facebook\.com/.test(tab.url || '')) return;
  try {
    const st = await chrome.tabs.sendMessage(tab.id, { type: 'stats' });
    if (!st) return;
    $('stats').innerHTML = '';
    for (const [k, label] of [['hiddenAds', 'Ads hidden'], ['hiddenSuggested', 'Suggested hidden'],
      ['data', '…via feed data (instant)'], ['label', '…via “Sponsored” label'], ['skippedAI', 'Normal posts (no AI needed)'],
      ['aiCalls', 'AI calls'], ['scanned', 'Posts checked']]) {
      const row = document.createElement('div');
      row.innerHTML = '<span></span><b></b>';
      row.children[0].textContent = label;
      row.children[1].textContent = st[k];
      $('stats').appendChild(row);
    }
    // Health of the instant path: "edges,ads,organic,unknown" from page.js.
    const [edges, , , unknown] = (st.feedData || '').split(',').map(Number);
    const note = document.createElement('div');
    note.className = 'muted';
    if (st.dataMissed > 0 || (edges > 0 && unknown === edges)) {
      note.textContent = '⚠ Feed data no longer identifies ads; using the slower label check.';
    } else if (edges > 0) {
      note.textContent = `Feed data: reading ${edges} posts`;
    } else {
      note.textContent = 'Feed data: no feed on this page';
    }
    $('stats').appendChild(note);
  } catch (_) { /* content script not loaded yet; reload the tab */ }
})();
