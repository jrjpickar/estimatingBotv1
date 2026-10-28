import json, re, sys
src, out = sys.argv[1], sys.argv[2]
s = open(src).read()
def rep(a, b, count=1):
    global s
    assert a in s, a[:60]
    s = s.replace(a, b, count)
# skeleton -> artifact page
s = re.sub(r'<!doctype html>\s*<html lang="en">\s*<head>\s*<meta charset="utf-8">\s*<meta name="viewport"[^>]*>\s*', '', s)
rep('<title>A2Z Estimating Bot</title>', '<title>A2Z Estimating Bot</title>\n<meta name="claude:viewport-fit-sides" content="cover">')
rep('</head>\n<body>\n', '')
rep('</body>\n</html>', '')
rep('header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 16px;background:var(--head);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}',
    'header{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-block:12px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));background:var(--head);border-bottom:1px solid var(--line);position:sticky;top:env(safe-area-inset-top,0px);z-index:5}\nbody::before{content:"";position:fixed;inset:0 0 auto;height:env(safe-area-inset-top,0px);z-index:10;background:var(--headsolid)}\n.sandbox{background:var(--accent-soft);color:var(--ink);border-bottom:1px solid var(--line);font-size:13px;padding-block:8px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));display:flex;gap:10px;align-items:center;flex-wrap:wrap}\n.sandbox b{font-weight:650}\n#jsonOut{margin-top:8px;font:12px/1.4 ui-monospace,Menlo,monospace;min-height:160px}')
rep('main{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:16px;padding:16px;max-width:1400px;margin:0 auto}',
    'body{background:var(--bg);color:var(--ink)}\nmain{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:16px;padding-block:16px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));max-width:1400px;margin:0 auto}')
rep('@media(max-width:600px){main{padding:16px 16px}', '@media(max-width:600px){')
rep('aside{position:sticky;top:64px;align-self:start}', 'aside{position:sticky;top:calc(64px + env(safe-area-inset-top,0px));align-self:start;min-width:0}')
# header controls: examples + copy JSON instead of download; inline confirm for New
rep('''  <button id="btnTheme" title="Switch theme">Colorful theme</button>
  <button id="btnNew">New</button>
  <button id="btnImport">Open estimate.json</button>
  <button id="btnExport" class="primary">Save estimate.json</button>''',
'''  <button id="btnTheme" title="Switch theme">Colorful theme</button>
  <label for="exPick" class="hint" style="display:inline">Example</label>
  <select id="exPick" class="ex"><option value="">Pick one...</option></select>
  <button id="btnNew">New blank</button>
  <button id="btnImport">Open estimate.json</button>
  <button id="btnExport" class="primary">Copy estimate JSON</button>''')
rep('<main>', '''<div class="sandbox"><b>Sandbox.</b> Drop a STACK CSV, or try the checker on the training examples. Edits stay in this browser only. Example figures come from training sessions, not confirmed bids.</div>
<main>''')
rep('''<div id="issues"></div><div class="answered" id="answered"></div></section>''',
    '''<div id="issues"></div><div class="answered" id="answered"></div></section>
  <section class="card" id="jsonCard" hidden><h2>Estimate JSON<span class="sp"></span><button class="link" id="closeJson">Close</button></h2><p class="hint" id="jsonMsg"></p><textarea id="jsonOut" readonly></textarea></section>''')
ex = json.load(open(sys.argv[3]))
rep('const RATES = ', 'const EXAMPLES = ' + json.dumps(ex) + ';\nconst RATES = ')
rep('''  else if (b.id === "btnNew") { if (!confirm("Clear this estimate?")) return; est = blank(); COMPS = null; renderForm(); }''',
'''  else if (b.id === "btnNew") {
    if (b.dataset.arm !== "1") { b.dataset.arm = "1"; b.textContent = "Click again to clear"; setTimeout(() => { b.dataset.arm = ""; b.textContent = "New blank"; }, 3000); return; }
    b.dataset.arm = ""; b.textContent = "New blank"; est = blank(); COMPS = null; document.getElementById("exPick").value = ""; renderForm();
  }
  else if (b.id === "closeJson") { document.getElementById("jsonCard").hidden = true; return; }''')
rep('''  else if (b.id === "btnExport") {
    const name = (est.job.name || "estimate").replace(/[^A-Za-z0-9 _-]+/g, "").trim() || "estimate";
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(est, null, 1)], { type: "application/json" }));
    a.download = name + ".estimate.json"; a.click(); return;
  }''',
'''  else if (b.id === "btnExport") {
    const text = JSON.stringify(est, null, 1), card = document.getElementById("jsonCard"), ta = document.getElementById("jsonOut"), msg = document.getElementById("jsonMsg");
    ta.value = text; card.hidden = false;
    const fallback = () => { msg.textContent = "Select all and copy. Paste it into a file named estimate.json to use it with the plugin."; ta.focus(); ta.select(); };
    try { navigator.clipboard.writeText(text).then(() => { msg.textContent = "Copied. Paste it into a file named estimate.json to use it with the plugin."; }, fallback); } catch (e) { fallback(); }
    card.scrollIntoView({ block: "nearest" }); return;
  }''')
rep('''  try { est = normalize(JSON.parse(await f.text())); renderForm(); run(); } catch (e) { alert("That file isn't a valid estimate.json"); }''',
'''  try { est = normalize(JSON.parse(await f.text())); renderForm(); run(); } catch (e) { const st = document.getElementById("status"); st.className = "status bad"; st.textContent = "That file isn't a valid estimate.json. Pick a file saved from this page or the plugin."; }''')
rep('''function load() {
  try { const s = localStorage.getItem(STORE); if (s) return normalize(JSON.parse(s)); } catch (e) {}
  return blank();
}''', '''function load() {
  try { const s = localStorage.getItem(STORE); if (s) return normalize(JSON.parse(s)); } catch (e) {}
  return normalize(JSON.parse(JSON.stringify(EXAMPLES[0].estimate)));
}''')
rep('renderForm(); run();\n</script>', '''const pick = document.getElementById("exPick");
pick.innerHTML += EXAMPLES.map((x, i) => `<option value="${i}">${esc(x.label)}</option>`).join("");
pick.addEventListener("change", () => { if (pick.value === "") return; est = normalize(JSON.parse(JSON.stringify(EXAMPLES[+pick.value].estimate))); COMPS = null; renderForm(); run(); });
renderForm(); run();
</script>''')
s = s.replace('const STORE = "a2z-checker-draft";', 'const STORE = "a2z-checker-sandbox";')
open(out, 'w').write(s)
print("ok", len(s))
