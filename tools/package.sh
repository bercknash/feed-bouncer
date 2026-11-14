#!/usr/bin/env bash
# Builds the zip to upload to the Chrome Web Store: the contents of extension/, nothing else.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$root/extension/manifest.json")"
out="$root/dist/feed-ad-hider-$version.zip"
mkdir -p "$root/dist"
rm -f "$out"
(cd "$root/extension" && zip -qr -X "$out" . -x '.*')
echo "$out"
unzip -l "$out"
