#!/usr/bin/env python3
"""Syntax-check every extension script by compiling it in headless Chrome (no Node needed)."""
import json, os, pathlib, re, shutil, subprocess, sys, tempfile

ext = pathlib.Path(__file__).resolve().parent.parent / "extension"
json.loads((ext / "manifest.json").read_text())
print("manifest.json ok")

checks = []
for f in sorted(ext.glob("*.js")):
    src = f.read_text()
    checks.append(f'try{{new Function({json.dumps(src)});r.push("{f.name} ok")}}catch(e){{r.push("{f.name} FAIL "+e)}}')
page = "<pre id=o></pre><script>const r=[];" + "\n".join(checks) + ';document.getElementById("o").textContent=r.join("\\n")</script>'

tmp = tempfile.mkdtemp()
try:
    p = os.path.join(tmp, "parse.html")
    open(p, "w").write(page)
    chrome = os.environ.get("CHROME") or shutil.which("google-chrome") or shutil.which("chromium")
    out = subprocess.run([chrome, "--headless=new", "--disable-gpu", f"--user-data-dir={tmp}/prof",
                          "--dump-dom", "file://" + p], capture_output=True, text=True).stdout
    res = re.search(r"<pre id=\"o\">(.*?)</pre>", out, re.S).group(1)
    print(res)
    sys.exit(1 if "FAIL" in res else 0)
finally:
    shutil.rmtree(tmp, ignore_errors=True)
