"use strict";
// Plan QC in code (no AI). Reads the TEXT of a plan set (digital PDFs from the architect, not scans)
// and checks it against the STACK takeoff by rule.
//
//   analyzePlans(pages, takeoffItems) -> { sheets, callouts, facts, flags, unreadable, stats }
//     pages: [ { n: 1, lines: ["DEMO (E) DOOR", "A101", ...] } ]   one entry per PDF page;
//            lines are text runs (the browser splits on big gaps; pdftotext -layout output is split on 3+ spaces)
//     takeoffItems: parseStackCsv(...) output (item, qty, unit, plan, group)
//   facts uses the same format autoEstimate / the checker read (quantity_checks, job.ceiling_height_ft, ...)
//   flags: [ { key, level: "ask" | "warn", kind, message, sheet } ]  -> estimate.plan_flags for the checker
//
// What it can't do: read scanned sheets (no text), count symbols, or judge what a drawing means.
// Those are reported as "unreadable" or left as questions for a person.

const { groupFor } = require("./common");

const DEMO_VERB = /\b(DEMO(LISH)?|REMOVE|CUT\s*(&|AND)\s*(DEMO|REMOVE)|SAW\s*CUT|ABANDON|TEAR\s*OUT|R\s*&\s*R)\b/;
const LEGEND = /\b(LEGEND|INDICATES|DENOTES|TYPICAL\s+SYMBOL|SHEET\s+NOTES?\s*:?\s*$|GENERAL\s+NOTES)\b/;
const REMAIN = /\b(TO\s+REMAIN|REMAIN(S|ING)?\s+IN\s+PLACE|PROTECT\s+IN\s+PLACE|EXISTING\s+TO\s+REMAIN|\(E\)\s+[^,.;]{0,40}\bREMAIN)\b/;
const BY_OTHERS = /\b(BY\s+OTHERS|BY\s+OWNER|BY\s+TENANT|BY\s+G\.?C\.?|N\.?\s?I\.?\s?C\.?|NOT\s+IN\s+CONTRACT|O\.?F\.?C\.?I\.?|O\.?F\.?O\.?I\.?|UNDER\s+SEPARATE\s+(PERMIT|CONTRACT))\b/;
const NEW_WORK = /(\(N\)|\bNEW\b|\bPROPOSED\b)[^,.;]{0,30}\b(SLAB|MAT\s+SLAB|FOOTINGS?|FOUNDATION|GRADE\s+BEAM|PAD)\b|\bMAT\s+SLAB\b/;
const HAZMAT = /\b(ASBESTOS|ACM|LEAD[-\s]BASED|HAZARDOUS\s+MATERIALS?|AQMD|RULE\s+1403|MOLD)\b/;
const CONDITION = [
  [/\b(2ND|SECOND|3RD|THIRD|4TH)\s+(FLOOR|LEVEL|STORY)\b|\bLEVEL\s+[2-9]\b/, "floor", "Work is above the ground floor: plan for carry-down or a chute."],
  [/\bOCCUPIED\b|\bREMAIN\s+OPEN\b|\bOPEN\s+FOR\s+BUSINESS\b/, "occupied", "Space or building stays occupied during work."],
  [/\bNIGHT\s+WORK\b|\bAFTER\s+HOURS\b|\bWORK\s+HOURS\b/, "hours", "Work hours are restricted (night or after-hours work)."],
  [/\bNO\s+ELEVATOR\b|\bFREIGHT\s+ELEVATOR\b|\bSERVICE\s+ELEVATOR\b/, "elevator", "Elevator / freight access is called out."],
  [/\bDUST\s+(CONTROL|PROTECTION|BARRIER)\b|\bTEMPORARY\s+(PARTITION|BARRIER|WALL)\b|\bZIP\s*WALL\b/, "protection", "Dust protection or temporary barriers are required."],
];
const SHEET_CODE = /\b((?:AD|ID|FP|[ACDEGLMPST])[-.]?\d{1,3}(?:\.\d{1,2})?[A-Z]?)\b/g;
const KIND = [
  ["rcp", /\bREFLECTED\s+CEILING|\bR\.?C\.?P\.?\b|\bCEILING\s+PLAN\b/],
  ["demo", /\bDEMO(LITION)?\s+(FLOOR\s+|SITE\s+)?PLAN\b|\bDEMO(LITION)?\s+RCP\b/],
  ["site", /\bSITE\s+(DEMO(LITION)?\s+)?PLAN\b|\bGRADING\s+PLAN\b|\bTOPOGRAPHIC\b|\bHARDSCAPE\b/],
  ["cover", /\bCOVER\s+SHEET\b|\bTITLE\s+SHEET\b|\bPROJECT\s+(INFO|INFORMATION|DATA)\b|\bSHEET\s+INDEX\b|\bSCOPE\s+OF\s+WORK\b/],
];
const SYN = { mtl: "metal", clg: "ceiling", flr: "floor", flrs: "floor", gyp: "gypsum", gwb: "gypsum", wd: "wood", conc: "concrete",
  act: "ceiling", acoustical: "ceiling", acoustic: "ceiling", tbar: "ceiling", partition: "wall", partitions: "wall", cmu: "block",
  cabinetry: "cabinet", casework: "cabinet", millwork: "cabinet", counters: "counter", countertop: "counter", vct: "tile", lvt: "vinyl",
  carpeting: "carpet", baseboard: "base", lav: "sink", lavatory: "sink", wc: "toilet", lights: "light", lighting: "light", fixtures: "fixture" };
const STOP = new Set(["demo", "demolish", "demolition", "remove", "removal", "cut", "and", "the", "of", "to", "be", "all", "in", "at", "with",
  "per", "plan", "plans", "sheet", "see", "existing", "e", "n", "a", "an", "as", "for", "from", "on", "or", "required", "typ", "typical",
  "area", "approx", "approximately", "location", "locations", "shown", "dashed", "line", "lines", "full", "height", "entire", "properly",
  "saw", "abandon", "tear", "out", "r", "x", "sq", "ft", "sf", "lf", "ea", "ln"]);

const norm = (s) => String(s || "").toUpperCase().replace(/[’']/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
function tokens(s) {
  return String(s || "").toLowerCase().replace(/\([en]\)/g, " ").replace(/[^a-z0-9 ]+/g, " ").split(" ")
    .filter(Boolean).map((w) => SYN[w] || w).map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w))
    .filter((w) => !STOP.has(w) && !/^\d+$/.test(w));
}

function sheetOf(lines, n) {
  // the sheet number usually sits in the title block, near the end of the page text
  const hits = [];
  lines.forEach((l, i) => { for (const m of norm(l).matchAll(SHEET_CODE)) hits.push({ code: m[1].replace(/\.$/, ""), i, alone: norm(l) === m[1] }); });
  if (!hits.length) return `p.${n}`;
  const alone = hits.filter((h) => h.alone);
  const pick = (alone.length ? alone : hits).reduce((a, b) => (b.i >= a.i ? b : a));
  return pick.code;
}
function kindOf(text) { for (const [k, re] of KIND) if (re.test(text)) return k; return "other"; }

function parseFeetInches(s) {
  const m = String(s).match(/(\d{1,2})\s*'\s*-?\s*(\d{1,2})?\s*"?/);
  return m ? Math.round((Number(m[1]) + (m[2] ? Number(m[2]) / 12 : 0)) * 100) / 100 : null;
}

function analyzePlans(pages, takeoffItems = []) {
  const sheets = [], unreadable = [], calloutMap = new Map(), facts = { job: {}, quantity_checks: [], exclusions: [], questions: [], sources: {} };
  const flags = [], areas = [], conditions = new Map(), hazmat = new Map(), news = new Map(), others = new Map();
  let gridRemain = null, ceilingHt = null, ceilingMentioned = false, recompaction = null, basement = null;
  const devices = new Set();

  for (const p of pages) {
    const lines = (p.lines || []).map(norm).filter(Boolean);
    const all = lines.join("\n");
    if (all.replace(/\s/g, "").length < 25) { unreadable.push(p.n); continue; }
    const code = sheetOf(lines, p.n), kind = kindOf(all);
    const kre = (KIND.find(([k]) => k === kind) || [])[1];
    const titleLine = (kre && lines.slice().reverse().find((l) => kre.test(l))) || "";
    sheets.push({ n: p.n, code, kind, title: titleLine.slice(0, 60) });

    for (const l of lines) {
      if (BY_OTHERS.test(l)) others.set(l.slice(0, 120), code);
      if (HAZMAT.test(l)) hazmat.set(l.slice(0, 120), code);
      for (const [re, key, msg] of CONDITION) if (re.test(l) && !conditions.has(key)) conditions.set(key, { msg, code, text: l.slice(0, 80) });
      if (NEW_WORK.test(l) && !DEMO_VERB.test(l)) news.set(l.slice(0, 100), code);
      if (/\bCEILING|\bCLG\b|\bACT\b|\bT-?BAR\b/.test(l)) ceilingMentioned = true;
      if (/\bGRID\b/.test(l)) { if (REMAIN.test(l) || /GRID\s+(TO\s+)?REMAIN/.test(l)) gridRemain = gridRemain || { v: "remain", code }; else if (DEMO_VERB.test(l)) gridRemain = { v: "remove", code }; }
      const ch = l.match(/\b(?:CLG|CEILING)\s*(?:HT\.?|HEIGHT)?\s*[:=@]?\s*(\d{1,2}\s*'\s*-?\s*\d{0,2}\s*"?)/) || l.match(/(\d{1,2}\s*'\s*-?\s*\d{0,2}\s*"?)\s*A\.?F\.?F\.?[^\n]{0,15}\b(?:CLG|CEILING)\b/);
      if (ch && !ceilingHt) { const v = parseFeetInches(ch[1]); if (v && v >= 7 && v <= 40) ceilingHt = { v, code }; }
      for (const d of ["LIGHT", "DIFFUSER", "GRILLE", "RETURN", "SPEAKER", "SPRINKLER", "SMOKE DETECTOR", "CAMERA", "SENSOR", "EXIT SIGN"])
        if (new RegExp("\\b" + d + "S?\\b").test(l) && DEMO_VERB.test(l)) devices.add(d.toLowerCase());
      if (/\bRE-?COMPACT|\bCOMPACTED\s+(FILL|SOIL)|\b\d{1,2}\s*"?\s*(INCH\s+)?LIFTS\b|\b9[05]\s*%\s*(RELATIVE\s+)?COMPACTION\b/.test(l)) recompaction = recompaction || code;
      const bd = l.match(/\bBASEMENT\b/) && l.match(/(\d{1,2}(?:\.\d)?)\s*(?:'|FT|FEET)\s*(?:DEEP|BELOW|BGS)?/);
      if (bd && !basement) basement = { depth: Number(bd[1]), code };
      for (const m of l.matchAll(/(\d{1,3}(?:,\d{3})+|\d{2,7})(?:\.\d+)?\s*(?:S\.?F\.?|SQ\.?\s*FT\.?|SQUARE\s+FEET)\b/g)) {
        const sf = Number(m[1].replace(/,/g, ""));
        const label = /REMODEL|TENANT\s+IMPROVEMENT|\bT\.?I\.?\b|AREA\s+OF\s+WORK|WORK\s+AREA|SCOPE|DEMO(LITION)?\s+AREA/.test(l) ? "remodel"
          : /\bLOT\b|SITE\s+AREA|PARCEL/.test(l) ? "lot" : /SUITE|TENANT\s+SPACE|LEASE/.test(l) ? "suite" : /BUILDING|GROSS|FOOTPRINT|FLOOR\s+AREA/.test(l) ? "building" : null;
        if (label && sf >= 50) areas.push({ label, sf, code, text: l.slice(0, 80) });
      }
      // demo callouts
      for (const sn of l.split(/\.\s+(?=[A-Z(])/).map((x) => x.trim()).filter(Boolean)) {
        if (!DEMO_VERB.test(sn) || LEGEND.test(sn) || REMAIN.test(sn) || sn.length > 140 || /:\s*$/.test(sn) || KIND.some(([, re]) => re.test(sn)) || BY_OTHERS.test(sn)) continue;
        const key = tokens(sn).sort().join(" ");
        if (!key) continue;
        const c = calloutMap.get(key) || { text: sn.replace(/\.$/, ""), sheets: new Set(), count: 0 };
        c.count++; c.sheets.add(code); calloutMap.set(key, c);
      }
    }
  }

  // match callouts to the takeoff
  const tk = takeoffItems.map((t) => ({ ...t, tok: new Set(tokens(t.item + " " + (t.description || ""))), group: t.group || groupFor(t.item) }));
  const callouts = [...calloutMap.values()].map((c) => {
    const tok = tokens(c.text);
    const group = /\b(LIGHT|DIFFUSER|GRILLE|SPEAKER|SENSOR|CAMERA|EXIT\s+SIGN|SPRINKLER|DETECTOR|THERMOSTAT|OUTLET|CONDUIT)/.test(c.text) ? "mep_electrical_hvac" : groupFor(c.text.toLowerCase());
    const hit = tk.find((t) => tok.filter((w) => t.tok.has(w)).length >= 2)
      || tk.find((t) => group !== "other" && t.group === group)
      || tk.find((t) => tok.some((w) => w.length > 3 && t.tok.has(w)));
    return { text: c.text, sheets: [...c.sheets], count: c.count, group, matched: hit ? hit.item : null };
  });
  const flag = (kind, level, message, sheet, extra = {}) => {
    const key = "plan_" + kind + ":" + String(message).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);
    if (!flags.some((f) => f.key === key)) flags.push({ key, level, kind, message, sheet, ...extra });
  };

  if (pages.length && !sheets.length) {
    flag("unreadable", "ask", "The plan set has no readable text (scanned). Plan QC needs a person or the AI step.", "");
  } else if (unreadable.length) {
    flag("unreadable", "ask", `${unreadable.length} page${unreadable.length === 1 ? "" : "s"} had no readable text (scanned or image only): page ${unreadable.slice(0, 8).join(", ")}${unreadable.length > 8 ? ", ..." : ""}. Check those by eye.`, "");
  }
  for (const c of callouts) if (!c.matched && takeoffItems.length)
    flag("missing", "ask", `On the plans but not in the takeoff: "${c.text}" (${c.sheets.join(", ")}). Add it to scope or confirm it's covered.`, c.sheets[0], { callout: c.text });
  if (callouts.length >= 3) {
    const usedItems = new Set(callouts.map((c) => c.matched).filter(Boolean));
    for (const t of tk) if (!usedItems.has(t.item) && !["haul_containers", "labor_equipment", "other"].includes(t.group) && !callouts.some((c) => c.group === t.group))
      flag("takeoff_only", "warn", `In the takeoff but no demo callout found on the plans: "${t.item}". Confirm it's in scope.`, "");
  }
  for (const [text, code] of news) flag("new_work", "warn", `New work on the plans: "${text}" (${code}). That's not demo; keep it out of scope.`, code);
  for (const [text, code] of others) { facts.exclusions.push((text.charAt(0) + text.slice(1).toLowerCase()).replace(/\((e|n)\)/g, (m) => m.toUpperCase()).replace(/\.$/, "")); flag("by_others", "ask", `By others / not in contract: "${text}" (${code}). Add it to the exclusions?`, code); }
  for (const [text, code] of hazmat) flag("hazmat", "ask", `Hazardous materials note: "${text}" (${code}). Confirm testing/abatement is excluded or priced.`, code);
  for (const [key, c] of conditions) {
    flag("condition", "ask", `${c.msg} "${c.text}" (${c.code}).`, c.code);
    if (key === "floor") { const lv = c.text.match(/\b(2|3|4)(ND|RD|TH)?\b|SECOND|THIRD/); facts.job.floor_level = lv ? (/SECOND|2/.test(lv[0]) ? 2 : /THIRD|3/.test(lv[0]) ? 3 : 4) : 2; facts.sources["job.floor_level"] = c.code; }
  }

  // ceilings
  const tkCeiling = tk.filter((t) => t.group === "ceilings");
  const hasRcp = sheets.some((s) => s.kind === "rcp");
  if (gridRemain) { facts.ceiling = { grid: gridRemain.v }; facts.sources["ceiling.grid"] = gridRemain.code; }
  if (devices.size) { facts.ceiling = facts.ceiling || {}; facts.ceiling.device_types = [...devices]; flag("devices", "ask", `Ceiling devices to remove on the plans (${[...devices].join(", ")}). Count them; the code can't count symbols.`, gridRemain ? gridRemain.code : ""); }
  if (ceilingHt) { facts.job.ceiling_height_ft = ceilingHt.v; facts.sources["job.ceiling_height_ft"] = ceilingHt.code; }
  if (tkCeiling.length && !hasRcp) flag("no_rcp", "ask", "The takeoff has ceiling work but no reflected ceiling plan was found in the set. Check the ceiling scope.", "");
  if (!tkCeiling.length && hasRcp && callouts.some((c) => c.group === "ceilings")) flag("ceiling_missing", "ask", "The ceiling plan has demo callouts but the takeoff has no ceiling lines.", sheets.find((s) => s.kind === "rcp").code);
  if ((tkCeiling.length || ceilingMentioned) && !ceilingHt && hasRcp) flag("ceiling_height", "ask", "No ceiling height found on the plans. Needed to size the lift.", "");

  // areas -> quantity checks
  const remodel = areas.filter((a) => a.label === "remodel" || a.label === "suite").sort((a, b) => b.sf - a.sf)[0];
  if (remodel) {
    facts.sources.area = `${remodel.code}: ${remodel.text}`;
    for (const g of ["flooring", "ceilings"]) {
      const sf = tk.filter((t) => t.group === g && t.unit === "SF").reduce((s, t) => s + Number(t.qty), 0);
      if (sf > 0) facts.quantity_checks.push({ item: g === "flooring" ? "Flooring" : "Ceiling", takeoff_qty: Math.round(sf * 100) / 100, plan_qty: remodel.sf, unit: "SF", source: `${remodel.code} ${remodel.label} area` });
    }
  }
  const lot = areas.find((a) => a.label === "lot");
  if (lot) { facts.lot_sf = lot.sf; facts.sources.lot = `${lot.code}: ${lot.text}`; }
  if (recompaction) { facts.recompaction_required = true; facts.sources.recompaction = recompaction; }
  if (basement) { facts.excavation = { depth_ft: basement.depth }; facts.sources["excavation.depth_ft"] = basement.code; }

  facts.questions = flags.filter((f) => f.level === "ask").map((f) => f.message);
  return {
    sheets, callouts, facts, flags, unreadable,
    stats: { pages: pages.length, readable: sheets.length, callouts: callouts.length, matched: callouts.filter((c) => c.matched).length },
  };
}

// pdftotext -layout output (pages split by form feed) -> pages for analyzePlans
function pagesFromPdftotext(text) {
  return String(text).split("\f").map((pg, i) => ({ n: i + 1, lines: pg.split("\n").flatMap((l) => l.split(/\s{3,}/)).map((s) => s.trim()).filter(Boolean) }))
    .filter((p, i, a) => !(i === a.length - 1 && !p.lines.length));
}

module.exports = { analyzePlans, pagesFromPdftotext, tokens };
