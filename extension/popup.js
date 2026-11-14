const $ = (id) => document.getElementById(id);

function addRow(label, value) {
  const row = document.createElement('div');
  const name = document.createElement('span');
  const val = document.createElement('b');
  name.textContent = label;
  val.textContent = value;
  row.append(name, val);
  $('stats').appendChild(row);
}

(async () => {
  const s = await chrome.storage.sync.get({ enabled: true, hideSuggested: false });
  for (const k of ['enabled', 'hideSuggested']) {
    $(k).checked = s[k];
    $(k).addEventListener('change', () => chrome.storage.sync.set({ [k]: $(k).checked }));
  }
  $('opts').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

  // Works without the "tabs" permission: a tab that isn't running our content
  // script (anything but Facebook) simply rejects the message.
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const st = await chrome.tabs.sendMessage(tab.id, { type: 'stats' });
    if (!st) return;
    $('stats').textContent = '';
    addRow('Ads hidden', st.hiddenAds);
    addRow('…from feed data (instant)', st.data);
    addRow('…from the “Sponsored” label', st.label);
    addRow('Suggested hidden', st.hiddenSuggested);

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
  } catch (_) { /* not a Facebook tab, or the tab predates the install: reload it */ }
})();
