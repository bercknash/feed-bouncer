chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.target !== 'offscreen') return false;
  if (msg.type === 'classify') {
    fbabClassifyBuiltin(msg.features)
      .then(reply)
      .catch((e) => reply({ label: 'unknown', error: String(e && e.message || e) }));
    return true;
  }
  return false;
});
