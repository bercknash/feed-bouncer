#!/usr/bin/env bash
# Runs the content script against the mock feed in headless Chrome and prints results.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
chrome="${CHROME:-$(command -v google-chrome || command -v chromium || command -v chromium-browser)}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
"$chrome" --headless=new --disable-gpu --no-first-run --user-data-dir="$tmp" \
  --allow-file-access-from-files --virtual-time-budget=5000 --window-size=800,3000 \
  --dump-dom "file://$here/mock-feed.html" 2>/dev/null \
  | sed -n '/<pre id="results">/,/<\/pre>/p' | sed -e 's/<[^>]*>//g' -e 's/&quot;/"/g' -e 's/&amp;/\&/g'
