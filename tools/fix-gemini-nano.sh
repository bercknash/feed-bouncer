#!/usr/bin/env bash
# Re-enable Chrome's built-in Gemini Nano after GPU-backend crashes disabled it.
#
# Diagnosis (Chrome 157, Intel Lunar Lake / Arc 140V, Debian):
#   - optimization_guide.on_device.model_crash_count reached 5 -> Chrome reports
#     LanguageModel.availability() === "unavailable".
#   - Crash dumps show the on_device_model_execution service CHECK-failing with
#     "ChromeML(GPU)-error_msg: Failed to initialize Dawn's proc tables."
#
# Fix: force the CPU inference backend (feature OnDeviceModelForceCpuBackend,
# present in this Chrome build) and reset the crash counter.
#
# Chrome must be fully quit first: it only reads "Local State" at startup and
# rewrites it on exit.
set -euo pipefail

FEATURE=OnDeviceModelForceCpuBackend
PROFILE_DIR="${CHROME_CONFIG_DIR:-$HOME/.config/google-chrome}"
LOCAL_STATE="$PROFILE_DIR/Local State"
DESKTOP_SYS=/usr/share/applications/google-chrome.desktop
DESKTOP_USER="$HOME/.local/share/applications/google-chrome.desktop"
STAMP=$(date +%Y%m%d-%H%M%S)

if pgrep -x chrome >/dev/null; then
  echo "Chrome is still running. Quit it completely (Ctrl+Q, and check for background apps in the tray), then re-run." >&2
  exit 1
fi

# 1. Reset the crash counter.
cp -p "$LOCAL_STATE" "$LOCAL_STATE.bak-fbab-$STAMP"
python3 -I - "$LOCAL_STATE" <<'PY'
import json, sys
p = sys.argv[1]
s = json.load(open(p))
od = s.setdefault("optimization_guide", {}).setdefault("on_device", {})
print(f"model_crash_count: {od.get('model_crash_count')} -> 0")
od["model_crash_count"] = 0
json.dump(s, open(p, "w"), separators=(",", ":"))
PY

# 2. Add the feature to every Exec line of the user's launcher, merging with any
#    existing --enable-features (Chrome honours only the last one given).
if [[ ! -f "$DESKTOP_USER" ]]; then
  mkdir -p "$(dirname "$DESKTOP_USER")"
  cp "$DESKTOP_SYS" "$DESKTOP_USER"
fi
if grep -q "$FEATURE" "$DESKTOP_USER"; then
  echo "Launcher already has $FEATURE"
else
  cp -p "$DESKTOP_USER" "$DESKTOP_USER.bak-fbab-$STAMP"
  python3 -I - "$DESKTOP_USER" "$FEATURE" <<'PY'
import re, sys
p, feat = sys.argv[1], sys.argv[2]
out = []
for line in open(p):
    if line.startswith("Exec="):
        if "--enable-features=" in line:
            line = re.sub(r"--enable-features=(\S+)", lambda m: f"--enable-features={m.group(1)},{feat}", line, count=1)
        else:
            line = re.sub(r"^(Exec=\S+)", rf"\1 --enable-features={feat}", line, count=1)
    out.append(line)
open(p, "w").writelines(out)
PY
  echo "Updated launcher:"
  grep -n '^Exec' "$DESKTOP_USER"
  command -v update-desktop-database >/dev/null && update-desktop-database "$(dirname "$DESKTOP_USER")" 2>/dev/null || true
fi

# 3. Start Chrome the same way the launcher does.
EXEC=$(grep -m1 '^Exec=' "$DESKTOP_USER" | sed -e 's/^Exec=//' -e 's/ *%[uU]//')
echo "Starting: $EXEC"
# shellcheck disable=SC2086
nohup $EXEC >/dev/null 2>&1 &
disown
cat <<EOF

Next:
  1. Open chrome://on-device-internals: "Model Status" should be ready and the backend should say CPU.
  2. Open the FB AI Ad Blocker settings, choose "Chrome on-device AI", and click "Test classifier".
To undo: restore the .bak-fbab-$STAMP files next to "$LOCAL_STATE" and "$DESKTOP_USER".
EOF
