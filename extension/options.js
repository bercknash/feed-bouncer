const DEFAULTS = { enabled: true, hideSuggested: false, showPlaceholder: true, debug: false };

(async () => {
  const s = await chrome.storage.sync.get(DEFAULTS);
  for (const k of Object.keys(DEFAULTS)) {
    const box = document.getElementById(k);
    box.checked = s[k];
    box.addEventListener('change', () => chrome.storage.sync.set({ [k]: box.checked }));
  }
})();
