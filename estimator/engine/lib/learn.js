"use strict";
// Training: learn A2Z's scope wording and cost line items from past proposals and
// job costing sheets. Plain code, no AI, no file access (lib/learnFiles.js reads
// .docx / .xlsx; the page reads PDFs with pdf.js and passes the text lines here).
//
//   proposalFromLines(lines)      -> proposal record { scopes: [{ name, bullets, total }], total, ... }
//   costSheetFromCells(get)       -> cost sheet record from Job Costing Worksheet V3 { lines: [{ section, category, description, qty, rate }], ... }
//   costSheetFromGrid(rows)       -> the same from any other layout (older templates, Google Sheets, CSV)
//   costSheetFromSheets(sheets)   -> the best reading of a whole workbook
//   learnModel(records)           -> model { phrases, scopeNames, exclusions, lineItems, jobs, counts }
//   applyLearned(est, model)      -> rewrites drafted scope lines and cost lines in A2Z's learned wording,
//                                    returns { changed, flags } (flags are CHECK items)
//   learnedJobs(model)            -> extra comps for findComps (library job shape)
const C = require("./common");

const norm = (s) => String(s == null ? "" : s).replace(/[ \t]/g, " ").replace(/[‘’]/g, "'").replace(/[“”]/g, "\"").replace(/\s+/g, " ").trim();
const MONEY = /\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?/;
const moneyVal = (s) => { const m = String(s).match(MONEY); return m ? Number(m[1].replace(/,/g, "") + (m[2] ? "." + m[2] : "")) : null; };
const BULLET = /^\s*(?:[•·▪●◦\-*–]|\d{1,2}[.)])\s+/;

// ---------------------------------------------------------------- proposals
const LABELS = /^(ESTIMATE\s*#?|DATE|CUSTOMER|JOB LOCATION|ESTIMATOR|SCOPE OF WORK|NOTES|EXCLUSIONS|TOTAL|SIGNATURE|SIGANATURE)\b/i;
function headerValue(lines, re) {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    const rest = norm(lines[i].slice(m.index + m[0].length)).replace(/^[:#\s]+/, "");
    if (rest) return rest;
    const next = (lines[i + 1] || "").trim();
    if (next && !LABELS.test(next)) return next;
  }
  return "";
}

const isScopeName = (l) => {
  const t = l.replace(/:$/, "");
  if (t.length < 3 || t.length > 70 || /\$|\d{3,}/.test(t) || BULLET.test(l)) return false;
  const letters = t.replace(/[^A-Za-z]/g, "");
  return letters.length >= 3 && letters === letters.toUpperCase() && !/^(NOTES|EXCLUSIONS|SCOPE OF WORK|PROPOSAL|ESTIMATOR|CUSTOMER|JOB LOCATION|DATE)\b/.test(t);
};

function proposalFromLines(rawLines, meta = {}) {
  const lines = rawLines.flatMap((l) => String(l).split(/\n/)).map(norm).filter(Boolean);
  const rec = {
    kind: "proposal", file: meta.file || "",
    estimate_number: headerValue(lines, /ESTIMATE\s*#?\s*:?/i).split(/\s+/)[0] || "",
    date: headerValue(lines, /^DATE\s*:/i),
    customer: headerValue(lines, /^CUSTOMER\s*:/i),
    job_address: "", estimator: headerValue(lines, /^ESTIMATOR\s*:/i),
    scopes: [], total: null, exclusions_extra: "",
  };
  const li = lines.findIndex((l) => /^JOB LOCATION\s*:?/i.test(l));
  if (li >= 0) {
    const parts = [norm(lines[li].replace(/^JOB LOCATION\s*:?/i, ""))];
    for (let k = li + 1; k < Math.min(li + 3, lines.length) && !LABELS.test(lines[k]) && !/^A2Z\b/i.test(lines[k]); k++) parts.push(lines[k]);
    rec.job_address = parts.filter(Boolean).join(" ").trim();
  }
  // scope body: after "...to do the following:" (or "Scope of Work") up to NOTES / EXCLUSIONS
  let start = lines.findIndex((l) => /the following:?\s*$/i.test(l));
  if (start < 0) start = lines.findIndex((l) => /^scope of work\b/i.test(l));
  let end = lines.findIndex((l, i) => i > start && /^(NOTES|EXCLUSIONS)\b/i.test(l));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end);
  const hasGlyphs = body.some((l) => BULLET.test(l));
  const totalNames = new Set(body.map((l) => (l.match(/^(.*?)\s*\bTOTAL\s*:?\s*\$?\s*[\d,]+(?:\.\d{2})?\s*$/i) || [])[1]).filter(Boolean).map((x) => x.trim().toUpperCase()));
  let cur = null;
  const push = () => { if (cur && (cur.bullets.length || cur.total != null)) rec.scopes.push(cur); };
  for (const l of body) {
    const tm = l.match(/^(.*?)\bTOTAL\s*:?\s*(\$?\s*[\d,]+(?:\.\d{2})?)\s*$/i);
    if (tm && cur) { cur.total = moneyVal(tm[2]); continue; }
    if (/^\$?\s*[\d,]+(\.\d{2})?$/.test(l) && /[\d]{3,}|,/.test(l) && cur) { cur.total = moneyVal(l); continue; }
    if (isScopeName(l) || totalNames.has(l.replace(/:$/, "").toUpperCase()) || (!cur && body.length > 1 && /^[A-Z][A-Za-z/&\- ]{2,40}$/.test(l) && l.split(" ").length <= 4)) { push(); cur = { name: l.replace(/:$/, ""), bullets: [], total: null, alternate: /ALTERNATE/i.test(l) }; continue; }
    if (!cur) cur = { name: "", bullets: [], total: null, alternate: false };
    const text = l.replace(BULLET, "").trim();
    if (!text) continue;
    if (hasGlyphs && !BULLET.test(l) && cur.bullets.length) cur.bullets[cur.bullets.length - 1] += (/-$/.test(cur.bullets[cur.bullets.length - 1]) ? "" : " ") + text;
    else cur.bullets.push(text);
  }
  push();
  // grand total
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^(?:GRAND\s+)?TOTAL\s*:?\s*(\$?\s*[\d,]+(?:\.\d{2})?)\s*$/i);
    if (m) { rec.total = moneyVal(m[1]); break; }
  }
  if (rec.total == null) { const s = rec.scopes.filter((x) => !x.alternate && x.total != null); if (s.length) rec.total = s.reduce((t, x) => t + x.total, 0); }
  // job-specific exclusions: text after the standard list
  const ei = lines.findIndex((l) => /^EXCLUSIONS\s*:/i.test(l));
  if (ei >= 0) {
    let t = lines[ei].replace(/^EXCLUSIONS\s*:\s*/i, "");
    for (let k = ei + 1; k < lines.length && !/^(Proposal (&|and) price|Total\s*:|_{5,}|ESTIMATE|CUSTOMER|JOB LOCATION|A2Z CONSTRUCTION)/i.test(lines[k]) && k < ei + 6; k++) t += (/-$/.test(t) ? "" : " ") + lines[k];
    const cut = t.search(/Any scope not listed within this proposal\.?/i);
    rec.exclusions_extra = norm(cut >= 0 ? t.slice(cut).replace(/Any scope not listed within this proposal\.?/i, "") : "");
  }
  return rec;
}

// ---------------------------------------------------------------- cost sheets
const SECTIONS = { INTERIOR: "Interior", EXTERIOR: "Exterior", GRADING: "Grading" };
const CATS = new Set(["Labor", "Hotel", "Hauling", "Equipment", "Fuel", "Misc"]);
// get(ref) -> cell value (string | number | null). Reads by the labels in column A, so older
// worksheet versions with moved rows still read right.
function costSheetFromCells(get, meta = {}) {
  const rec = { kind: "costsheet", file: meta.file || "", job_name: String(get("C2") || get("B2") || ""), date: String(get("C3") || get("B3") || ""), lines: [], total_cost: null, markup: null };
  let section = null, seen = 0;
  for (let r = 1; r <= 120; r++) {
    const a = norm(get(`A${r}`)).replace(/:$/, "");
    if (!a) continue;
    const head = a.toUpperCase();
    if (SECTIONS[head]) { section = SECTIONS[head]; seen++; continue; }
    if (/^TOTAL JOB COST/i.test(a)) rec.total_cost = Number(get(`E${r}`)) || null;
    if (/^Markup/i.test(a)) rec.markup = Number(get(`E${r}`)) || null;
    const cat = a.charAt(0).toUpperCase() + a.slice(1).toLowerCase();
    if (!section || !CATS.has(cat)) continue;
    const description = norm(get(`B${r}`)), qty = Number(get(`C${r}`)), rate = Number(get(`D${r}`));
    if (!description && !qty && !rate) continue;
    rec.lines.push({ section, category: cat, description, qty: isFinite(qty) ? qty : 0, rate: isFinite(rate) ? rate : 0 });
  }
  if (!seen) throw new Error("This doesn't look like a Job Costing Worksheet (no INTERIOR / EXTERIOR / GRADING sections in column A).");
  if (rec.total_cost == null) rec.total_cost = rec.lines.reduce((t, l) => t + l.qty * l.rate, 0);
  return rec;
}

// Any other cost sheet layout (older A2Z templates, Google Sheets exports, CSV):
// rows = [[cell, cell, ...], ...] for one sheet. Finds the description / qty / rate / total
// columns from a header row when there is one, otherwise from the numbers themselves, and
// works out each line's type from its wording.
const CAT_WORDS = [
  ["Hotel", /\b(hotel|lodging|motel|per diem)\b/i],
  ["Fuel", /^\W*(fuel|gas|diesel)\b/i],
  ["Hauling", /\b(haul\w*|loads?|dump\w*|truck\w*|trucking|containers?|bins?|roll ?offs?|disposal|tipping|low ?boy|super ?10|transfer|debris removal)\b/i],
  ["Labor", /\b(labor|labour|laborers?|workers?|guys|men|man|crew|man ?days?|worker ?days?|hours?|hrs|hr|operators?|supervisor|foreman|superintendent|down ?time)\b/i],
  ["Equipment", /\b(equip\w*|lifts?|excavators?|skid ?steers?|bobcat|loaders?|scrapers?|saws?|breakers?|rental|forklift|compactors?|mini ?ex|tractor|dozer|backhoe|generators?|jack ?hammers?|chipping|delivery|pick ?up|scissor|boom|grinder)\b/i],
  ["Fuel", /\b(fuel|gas|diesel)\b/i],
];
function categoryOf(text) {
  const t = String(text || "");
  for (const [cat, re] of CAT_WORDS) if (re.test(t)) return cat;
  return "Misc";
}
const CAT_NAMES = { labor: "Labor", labour: "Labor", hotel: "Hotel", lodging: "Hotel", hauling: "Hauling", haul: "Hauling", trucking: "Hauling", dump: "Hauling", disposal: "Hauling", equipment: "Equipment", rental: "Equipment", fuel: "Fuel", misc: "Misc", miscellaneous: "Misc", material: "Misc", materials: "Misc", other: "Misc", subcontract: "Misc", sub: "Misc" };
function sectionOf(text) {
  const t = String(text || "").toLowerCase();
  if (/grad|excavat|earth|soil|dirt/.test(t)) return "Grading";
  if (/exterior|site|hardscape|concrete|flatwork|asphalt|paving|outside/.test(t)) return "Exterior";
  if (/interior|inside|demo|ti\b|tenant/.test(t)) return "Interior";
  return null;
}
const cellText = (v) => (v == null ? "" : String(v)).replace(/\s+/g, " ").trim();
function cellNum(v) {
  if (typeof v === "number") return isFinite(v) ? v : null;
  const t = cellText(v);
  if (!t) return null;
  const m = t.match(/^\(?-?\$?\s*-?\d[\d,]*(\.\d+)?\)?%?$/);
  if (!m) return null;
  let n = Number(t.replace(/[$,()%\s]/g, ""));
  if (/^\(.*\)$/.test(t)) n = -n;
  if (/%$/.test(t)) n = n / 100;
  return isFinite(n) ? n : null;
}
const SKIP_ROW = /\b(sub ?total|total|markup|mark up|profit|overhead|margin|grand|tax|contingency|price to customer|bid price|contract price|sell(ing)? price|commission)\b/i;
const HEAD = {
  desc: /\b(desc(ription)?|item|items|scope|task|work|line item|details?|notes?)\b/i,
  cat: /\b(categor(y|ies)|type|trade|class|cost code|code)\b/i,
  qty: /\b(qty|quan(tity)?|count|units|days|hours|hrs|loads|no\.?|#)\b/i,
  unit: /^\s*(unit|uom|u\/m|per)\s*$/i,
  rate: /\b(rate|unit (cost|price)|cost ?\/ ?unit|price each|each|per unit|cost each|unit \$|\$ ?\/)\b/i,
  total: /\b(total|amount|ext(ended)?|line total|sum|cost)\b/i,
};
function findHeader(row) {
  const cols = {};
  row.forEach((v, i) => {
    const t = cellText(v);
    if (!t || t.length > 40 || cellNum(v) != null) return;
    // "Description" beats "Item": an Item column next to a Description column is the line's label / type
    if (/^desc(ription)?\b/i.test(t)) { if (cols.desc != null && cols.cat == null) cols.cat = cols.desc; cols.desc = i; return; }
    for (const k of ["unit", "rate", "qty", "cat", "desc", "total"]) if (cols[k] == null && HEAD[k].test(t) && !Object.values(cols).includes(i)) { cols[k] = i; break; }
  });
  const hits = ["qty", "rate", "total"].filter((k) => cols[k] != null).length;
  return cols.desc != null && hits >= 1 ? cols : null;
}

function costSheetFromGrid(rows, meta = {}) {
  const rec = { kind: "costsheet", file: meta.file || "", sheet: meta.sheet || "", layout: "other", job_name: "", date: "", lines: [], total_cost: null, markup: null, final_price: null };
  // job name / date from labels near the top
  for (const row of rows.slice(0, 10)) row.forEach((v, i) => {
    const t = cellText(v);
    const next = () => { for (let k = i + 1; k < row.length; k++) { const x = cellText(row[k]); if (x) return x; } return ""; };
    if (!rec.job_name && /^(job( name)?|project( name)?|job address|address|location|site)\s*:?$/i.test(t)) rec.job_name = next();
    if (!rec.date && /^date\s*:?$/i.test(t)) rec.date = next();
  });
  let cols = null, section = null;
  for (const row of rows) {
    const texts = row.map(cellText);
    const filled = texts.filter(Boolean);
    if (!filled.length) continue;
    const h = findHeader(row);
    if (h) { cols = h; continue; }
    const nums = row.map(cellNum);
    const numIdx = nums.map((n, i) => (n != null && texts[i] ? i : -1)).filter((i) => i >= 0);
    const textIdx = texts.map((t, i) => (t && nums[i] == null ? i : -1)).filter((i) => i >= 0);
    const label = textIdx.length ? texts[textIdx[0]] : "";
    // totals and markup
    if (SKIP_ROW.test(label)) {
      const val = numIdx.length ? nums[numIdx[numIdx.length - 1]] : null;
      if (val != null) {
        if (/markup|mark up/i.test(label)) rec.markup = val > 5 ? val / 100 : val;
        else if (/total (job )?cost|cost total|total costs?$/i.test(label)) rec.total_cost = val;
        else if (/price|bid|contract|customer|grand total/i.test(label)) rec.final_price = val;
      }
      continue;
    }
    // a section heading: one short text cell, no numbers
    if (!numIdx.length && textIdx.length === 1 && label.length <= 40) { const sec = sectionOf(label); if (sec) { section = sec; continue; } }
    let description = "", category = null, qty = null, rate = null, total = null;
    if (cols) {
      description = texts[cols.desc] || "";
      if (cols.cat != null && texts[cols.cat]) {
        const c = CAT_NAMES[texts[cols.cat].toLowerCase().replace(/[^a-z]/g, "")];
        if (c) category = c; else if (!description) description = texts[cols.cat]; else description = texts[cols.cat] + " - " + description;
      }
      // a category label in another text column (e.g. "Labor" in column A with no header)
      if (!category) for (const i of textIdx) { const c = CAT_NAMES[texts[i].toLowerCase().replace(/[^a-z]/g, "")]; if (c && i !== cols.desc) { category = c; break; } }
      qty = cols.qty != null ? nums[cols.qty] : null;
      rate = cols.rate != null ? nums[cols.rate] : null;
      total = cols.total != null ? nums[cols.total] : null;
      if (!description) { const other = textIdx.find((i) => i !== cols.unit && i !== cols.cat && !CAT_NAMES[texts[i].toLowerCase().replace(/[^a-z]/g, "")]); description = other != null ? texts[other] : category || ""; }
    } else {
      if (!textIdx.length) continue;
      const cat = textIdx.map((i) => CAT_NAMES[texts[i].toLowerCase().replace(/[^a-z]/g, "")]).find(Boolean);
      if (cat) category = cat;
      description = textIdx.map((i) => texts[i]).filter((t) => !CAT_NAMES[t.toLowerCase().replace(/[^a-z]/g, "")]).join(" ") || (cat || "");
      const n = numIdx.map((i) => nums[i]).filter((x) => x > 0);
      if (n.length >= 3 && Math.abs(n[0] * n[1] - n[n.length - 1]) <= Math.max(1, n[n.length - 1] * 0.01)) { qty = n[0]; rate = n[1]; total = n[n.length - 1]; }
      else if (n.length === 2) { qty = n[0]; rate = n[1]; }
      else if (n.length) total = n[n.length - 1];
    }
    if (!description && !category) continue;
    // dollar amounts written into the description ("6 guys 2 weeks at $85/hr $40,800")
    if (qty == null && rate == null && total == null) {
      const dollars = [...description.matchAll(/\$\s?(\d[\d,]*(?:\.\d{2})?)/g)].map((m) => Number(m[1].replace(/,/g, "")));
      if (dollars.length) total = dollars[dollars.length - 1];
    }
    if (qty == null && rate == null && total == null) continue;
    if (qty != null && rate != null) { /* as is */ }
    else if (total != null && qty != null && qty > 0) rate = Math.round((total / qty) * 100) / 100;
    else if (total != null && rate != null && rate > 0) qty = Math.round((total / rate) * 100) / 100;
    else if (total != null) { qty = 1; rate = total; }
    else if (rate != null) qty = 1;
    else continue;
    if (!(qty > 0) || !(rate > 0)) continue;
    rec.lines.push({ section: section || "Interior", category: category || categoryOf(description), description, qty, rate });
  }
  if (rec.total_cost == null && rec.lines.length) rec.total_cost = rec.lines.reduce((t, l) => t + l.qty * l.rate, 0);
  if (rec.markup == null && rec.final_price && rec.total_cost) rec.markup = Math.round((rec.final_price / rec.total_cost - 1) * 10000) / 10000;
  return rec;
}

// Best reading of a workbook: the Job Costing Worksheet V3 by its labels when it is one,
// otherwise the sheet with the most cost lines read the loose way.
// sheets: [{ name, rows, get }] (get(ref) for the V3 reader)
function costSheetFromSheets(sheets, meta = {}) {
  const tries = [];
  for (const sh of sheets) {
    if (/raw takeoff|takeoffs?$|reference|comp job|instructions|lists?$|dropdown/i.test(sh.name)) continue;
    if (sh.get) { try { const r = costSheetFromCells(sh.get, { ...meta }); if (r.lines.length) { r.layout = "v3"; r.sheet = sh.name; tries.push(r); continue; } } catch (e) { /* not V3 */ } }
    const r = costSheetFromGrid(sh.rows, { ...meta, sheet: sh.name });
    if (r.lines.length) tries.push(r);
  }
  if (!tries.length) throw new Error("No cost lines found. Expected rows with a description and a quantity, rate or total.");
  tries.sort((a, b) => (b.layout === "v3") - (a.layout === "v3") || b.lines.length - a.lines.length);
  return tries[0];
}

// ---------------------------------------------------------------- phrase parsing
const QTY_RE = /\(?\s*(?:approx(?:\.|imately)?|apprx\.?|~)\s*([\d,]+(?:\.\d+)?)\s*(SF|SQ\.?\s*FT\.?|SQFT|S\.F\.|LF|LIN\.?\s*FT\.?|L\.F\.|EA|EACH|CY|C\.Y\.|SY|LS|TONS?)\b\.?/i;
const SHEET_RE = /,?\s*\(?\s*per (?:plans?|sheets?|drawings?)\s*([A-Z0-9][A-Z0-9.\-]*(?:\s*(?:,|&|and)\s*[A-Z0-9][A-Z0-9.\-]*)*)?\s*\)?/i;
const VERBS = /^(properly\s+)?(saw\s*cut,?\s*(?:break\s*(?:and|&)\s*haul|and remove|& remove)|cut\s*(?:and|&)\s*(?:demo(?:lish)?|remove|cap)|demo(?:lish|lition of)?|remove(?:\s+and\s+dispose\s+of)?|removal of|haul(?:\s+off|\s+away)?|dispose of|tear\s*(?:out|off)|strip|scrape|grind|excavate|grade|rough grade|fine grade|export|import|clear(?:\s+and\s+grub)?|break(?:\s+and\s+haul)?|abate|cap|disconnect|salvage|protect|install|provide|furnish|moisture condition(?:\s+and\s+recompact)?|recompact|compact)\b/i;
const STOP = new Set(["the", "a", "an", "of", "and", "&", "to", "in", "at", "on", "for", "with", "all", "any", "existing", "e", "per", "plans", "plan", "approx", "approximately", "as", "is", "be", "from", "by", "only", "area", "areas", "properly", "entire", "entirety", "including", "include", "required", "needed", "new"]);
const stem = (w) => w.replace(/(ies)$/, "y").replace(/(es|s)$/, "").replace(/ing$/, "");
const tokens = (s) => [...new Set(String(s).toLowerCase().replace(/\(e\)/g, " ").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w) && !/^\d+$/.test(w)).map(stem))];
const UNIT = (u) => { const x = String(u || "").toUpperCase().replace(/[^A-Z]/g, ""); return /^(SF|SQFT)$/.test(x) ? "SF" : /^(LF|LINFT)$/.test(x) ? "LF" : /^(EA|EACH)$/.test(x) ? "EA" : x === "CY" ? "CY" : x === "SY" ? "SY" : x === "LS" ? "LS" : x.startsWith("TON") ? "TON" : x; };

function parseLine(line) {
  const t = norm(line).replace(BULLET, "");
  const q = t.match(QTY_RE);
  const s = t.match(SHEET_RE);
  let core = t.replace(QTY_RE, " ").replace(SHEET_RE, " ").replace(/\(\s*[,;]?\s*\)/g, " ");
  let depth = 0; core = [...core].filter((ch) => { if (ch === "(") depth++; else if (ch === ")") { if (!depth) return false; depth--; } return true; }).join("");
  core = core.replace(/\(\s*[,;]?\s*$/, "").replace(/\s+,/g, ",").replace(/\s+/g, " ").replace(/[\s,;(]+$/, "").trim();
  const vm = core.match(VERBS);
  const verb = vm ? vm[0].replace(/^properly\s+/i, "").toLowerCase() : "";
  const object = vm ? core.slice(vm[0].length).trim() : core;
  return { text: t, core, verb, object, tokens: tokens(object), qty: q ? Number(q[1].replace(/,/g, "")) : null, unit: q ? UNIT(q[2]) : "", sheets: s && s[1] ? s[1].trim() : "" };
}

const jaccard = (a, b) => { if (!a.length || !b.length) return 0; const B = new Set(b); const i = a.filter((x) => B.has(x)).length; return i / (a.length + b.length - i); };

// ---------------------------------------------------------------- learning
function learnModel(records) {
  const phrases = new Map(), names = new Map(), excl = new Map(), items = new Map(), jobs = [];
  const bump = (m, k, v) => { const e = m.get(k) || { ...v, count: 0 }; e.count++; m.set(k, e); return e; };
  let proposals = 0, costsheets = 0;
  for (const r of records || []) {
    if (r.kind === "proposal") {
      proposals++;
      const takeoff = [];
      for (const s of r.scopes || []) {
        if (s.name) bump(names, s.name.toUpperCase(), { name: s.name.toUpperCase(), kind: /GRAD|EXCAV|EARTH/i.test(s.name) ? "grading" : /DEMO/i.test(s.name) ? "demo" : "other" });
        for (const b of s.bullets || []) {
          const p = parseLine(b);
          if (!p.core || p.core.length < 6 || !p.tokens.length) continue;
          const key = p.core.toLowerCase();
          const e = bump(phrases, key, { core: p.core, verb: p.verb, object: p.object, tokens: p.tokens, unit: p.unit, withQty: false, withSheets: false });
          if (p.qty != null) { e.withQty = true; e.unit = e.unit || p.unit; takeoff.push({ item: p.object || p.core, qty: p.qty, unit: p.unit }); }
          if (p.sheets) e.withSheets = true;
        }
      }
      for (const x of String(r.exclusions_extra || "").split(/[,;]|\.\s/).map((x) => norm(x).replace(/\.$/, "")).filter((x) => x.length > 3)) bump(excl, x.toLowerCase(), { text: x });
      if (r.total) jobs.push({ id: "trained:" + (r.estimate_number || r.file || jobs.length), name: (r.job_address || r.file || r.estimate_number || "Trained proposal").toUpperCase(), customer: r.customer || "",
        date: r.date || "", sentTotal: r.total, priceSource: "training upload", outcome: "unknown",
        scopeTotals: (r.scopes || []).filter((s) => s.total != null).map((s) => [s.name, s.total]),
        scopeText: (r.scopes || []).map((s) => [s.name, ...(s.bullets || [])].join("\n")).join("\n\n"), takeoff });
    } else if (r.kind === "costsheet") {
      costsheets++;
      const seenHere = new Set();
      for (const l of r.lines || []) {
        if (!l.description) continue;
        const key = l.category + "|" + l.description.toLowerCase().replace(/\s+/g, " ");
        const e = items.get(key) || { category: l.category, description: l.description, tokens: tokens(l.description), count: 0, sheets: 0, rates: [], sections: {} };
        e.count++;
        if (!seenHere.has(key)) { e.sheets++; seenHere.add(key); }
        if (l.rate > 0) e.rates.push(l.rate);
        e.sections[l.section] = (e.sections[l.section] || 0) + 1;
        items.set(key, e);
      }
    }
  }
  const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const lineItems = [...items.values()].map((e) => ({ ...e, rateMedian: median(e.rates), rates: e.rates.slice(-20) })).sort((a, b) => b.count - a.count);
  return {
    version: 1, updated: new Date().toISOString(), counts: { proposals, costsheets },
    phrases: [...phrases.values()].sort((a, b) => b.count - a.count).slice(0, 2000),
    scopeNames: [...names.values()].sort((a, b) => b.count - a.count),
    exclusions: [...excl.values()].sort((a, b) => b.count - a.count).slice(0, 200),
    lineItems: lineItems.slice(0, 1000),
    jobs,
  };
}

function learnedJobs(model) {
  return ((model && model.jobs) || []).map((j) => ({ ...j, takeoff: (j.takeoff || []).map((t) => ({ ...t, unit: C.normUnit(t.unit), group: C.groupFor(t.item) })) }));
}

// ---------------------------------------------------------------- applying
const MIN_SIM = 0.5;
function bestPhrase(model, p) {
  let best = null;
  for (const ph of model.phrases || []) {
    if (p.unit && ph.unit && ph.unit !== p.unit) continue;
    const sim = jaccard(p.tokens, ph.tokens);
    if (sim < MIN_SIM) continue;
    const score = sim + Math.min(ph.count, 10) * 0.01 + (p.unit && ph.unit === p.unit ? 0.02 : 0);
    if (!best || score > best.score) best = { ph, sim, score };
  }
  return best;
}
const fmtQty = (q) => Number(q).toLocaleString("en-US", { maximumFractionDigits: q < 10 ? 2 : 0 });
function rewrite(ph, p) {
  const parts = [];
  if (p.qty != null) parts.push(`approx. ${fmtQty(p.qty)} ${p.unit}`);
  if (p.sheets) parts.push(`per plans ${p.sheets}`);
  let core = ph.core.charAt(0).toUpperCase() + ph.core.slice(1);
  if (/^(remove|demolish|demo|saw cut|cut|haul|tear|strip|scrape|grind|break|disconnect|cap|salvage)\b/i.test(core) && /^Properly\b/.test(p.text)) core = "Properly " + core.charAt(0).toLowerCase() + core.slice(1);
  return parts.length ? `${core} (${parts.join(", ")})` : core;
}

function applyLearned(est, model, { minSheets = 3 } = {}) {
  const changed = [], flags = [];
  if (!model || (!(model.phrases || []).length && !(model.lineItems || []).length)) return { changed, flags };
  // scope wording
  for (const s of est.scopes || []) {
    if (!s.lines) continue;
    s.lines = s.lines.map((line) => {
      const p = parseLine(line);
      if (!p.tokens.length) return line;
      const hit = bestPhrase(model, p);
      if (!hit || hit.ph.core.toLowerCase() === p.core.toLowerCase()) return line;
      const out = rewrite(hit.ph, p);
      if (out !== line) changed.push({ kind: "scope", from: line, to: out, basis: `worded like ${hit.ph.count} past proposal line${hit.ph.count === 1 ? "" : "s"}` });
      return out;
    });
    // scope name: the most common learned name of the same kind
    const kind = /GRAD|EXCAV/i.test(s.name || "") ? "grading" : /DEMO/i.test(s.name || "") ? "demo" : null;
    const nm = kind && (model.scopeNames || []).find((n) => n.kind === kind && n.count >= 2);
    if (nm && nm.name !== String(s.name).toUpperCase()) { changed.push({ kind: "scope_name", from: s.name, to: nm.name, basis: `${nm.count} past proposals` }); s.name = nm.name; }
  }
  // cost line items: equipment / misc / fuel wording + rate sanity
  const sheets = (model.counts && model.counts.costsheets) || 0;
  const present = [];
  for (const sec of est.sections || []) for (const l of sec.lines || []) {
    present.push(l);
    if (!["Equipment", "Misc", "Fuel", "Hotel"].includes(l.category)) continue;
    const tk = tokens(l.description);
    let best = null;
    for (const it of model.lineItems || []) {
      if (it.category !== l.category) continue;
      const sim = jaccard(tk, it.tokens);
      if (sim >= 0.6 && (!best || sim + it.count * 0.01 > best.s)) best = { it, s: sim + it.count * 0.01 };
    }
    if (!best) continue;
    if (best.it.description !== l.description) { changed.push({ kind: "line", from: l.description, to: best.it.description, basis: `${best.it.count} past cost sheet line${best.it.count === 1 ? "" : "s"}` }); l.description = best.it.description; }
    const med = best.it.rateMedian;
    if (med && best.it.rates.length >= 3 && Number(l.rate) > 0 && Math.abs(Number(l.rate) - med) / med > 0.25)
      flags.push({ key: "learned_rate:" + best.it.description.toLowerCase(), level: "warn", message: `${best.it.description} is $${Number(l.rate).toLocaleString("en-US")}; past cost sheets used about $${Math.round(med).toLocaleString("en-US")} (${best.it.rates.length} sheets).` });
  }
  // items that most past cost sheets include
  if (sheets >= minSheets) {
    for (const it of model.lineItems || []) {
      if (!["Misc", "Equipment", "Fuel"].includes(it.category) || it.sheets / sheets < 0.5) continue;
      if (present.some((l) => l.category === it.category && jaccard(tokens(l.description), it.tokens) >= 0.5)) continue;
      flags.push({ key: "learned_common:" + it.description.toLowerCase(), level: "warn", message: `${it.sheets} of ${sheets} past cost sheets include "${it.description}" (${it.category}). Add it if this job needs it.` });
    }
  }
  return { changed, flags };
}

module.exports = { proposalFromLines, costSheetFromCells, costSheetFromGrid, costSheetFromSheets, categoryOf, learnModel, learnedJobs, applyLearned, parseLine, tokens };
