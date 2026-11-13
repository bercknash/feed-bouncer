#!/usr/bin/env bash
# Runs the extension scripts against the mock pages in headless Chrome and prints results.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
chrome="${CHROME:-$(command -v google-chrome || command -v chromium || command -v chromium-browser)}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
for page in mock-feed.html mock-data.html; do
  echo "== $page"
  "$chrome" --headless=new --disable-gpu --no-first-run --user-data-dir="$tmp" \
    --allow-file-access-from-files --virtual-time-budget=6000 --window-size=800,3000 \
    --dump-dom "file://$here/$page" 2>/dev/null \
    | sed -n '/<pre id="results">/,/<\/pre>/p' | sed -e 's/<[^>]*>//g' -e 's/&quot;/"/g' -e 's/&amp;/\&/g'
done
