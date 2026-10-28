"use strict";
// Auto mode: STACK takeoff (+ plan facts + draft crew/haul/equipment quantities) -> a full draft estimate.
// Pure code. The only judgment it takes in is `facts` (read from the plans) and `inputs`
// (draft quantities for labor, loads and equipment); everything else is rules.
//
// autoEstimate({ items, facts, inputs, job, defaults, rates }) -> estimate (ready for checkEstimate / computeEstimate)
// reviewSheet(priced, checks, comps, facts) -> markdown review sheet for the estimator
//
// facts (all optional, every value should carry the sheet it came from in `sources`):
//   { job: { name, location, customer, access, ceiling_height_ft, floor_level },
//     ceiling: { grid: "remain" | "remove", devices: { lights: 12, diffusers: 6, ... } },
//     recompaction_required: true, excavation: { footprint_sf, depth_ft, volume_cy, loads },
//     quantity_checks: [ { item, takeoff_qty, plan_qty, unit, source } ],
//     exclusions: [ "..." ], notes: [ "..." ], questions: [ "..." ], sources: { "job.access": "A101", ... } }
// inputs: { lines: [ { section, category, description, qty, rate?, per?, basis } ] }
//   rate is filled from A2Z standards / the rate sheet when left out.

const { money0 } = require("./common");

const DEFAULTS = { markup: 1.3 };

// Order the crew works an interior demo (training notes): millwork, flooring, doors/walls, ceiling, then the rest.
const ORDER = ["furniture_contents", "millwork_casework", "plumbing_fixtures", "flooring", "doors", "walls_partitions", "windows_storefront",
  "ceilings", "mep_electrical_hvac", "signage_specialties", "other", "roofing", "exterior_finishes", "whole_structure",
  "concrete_sawcut_slab", "hardscape_site", "block_wall_fence"];
const GRADING = new Set(["grading_excavation", "erosion_control"]);
const SKIP = new Set(["haul_containers", "labor_equipment"]);
const EXTERIOR = new Set(["roofing", "exterior_finishes", "whole_structure", "concrete_sawcut_slab", "hardscape_site", "block_wall_fence"]);
const VERB = { walls_partitions: "demolish", whole_structure: "demolish", block_wall_fence: "demolish", roofing: "remove", grading_excavation: "" };

const fmtQty = (q) => Number(q).toLocaleString("en-US", { maximumFractionDigits: q < 10 ? 2 : 0 });
const sheetCode = (plan) => { const m = String(plan || "").match(/^\s*([A-Z]{1,3}[-.]?\d{1,3}(\.\d+)?[A-Z]?)\b/); return m ? m[1] : ""; };

function cleanName(name) {
  return String(name).trim()
    .replace(/^(cut\s*(and|&)\s*)?(demo(lish)?|remove|removal of|r\s*&\s*r|take out|tear out)\s+/i, "")
    .replace(/\s+/g, " ").toLowerCase();
}

function scopeLine(it) {
  const g = it.group, sheets = [...it.sheets].filter(Boolean);
  const where = sheets.length ? `, per plans ${sheets.join(", ")}` : "";
  if (GRADING.has(g)) return `${cap(cleanName(it.item))} (approx. ${fmtQty(it.qty)} ${it.unit}${where})`;
  const verb = /saw ?cut/i.test(it.item) ? "saw cut, break and haul" : VERB[g] || "remove";
  return `Properly ${verb} ${cleanName(it.item).replace(/^saw ?cut,?\s*(break\s*(and|&)\s*haul\s*)?/i, "")} (approx. ${fmtQty(it.qty)} ${it.unit}${where})`;
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function draftScopes(items, facts = {}) {
  // merge repeated STACK lines (same name + unit)
  const merged = new Map();
  for (const it of items) {
    if (SKIP.has(it.group)) continue;
    const k = it.item.toLowerCase() + "|" + it.unit;
    const m = merged.get(k) || { ...it, qty: 0, sheets: new Set() };
    m.qty += it.qty; m.sheets.add(sheetCode(it.plan));
    merged.set(k, m);
  }
  const all = [...merged.values()];
  const demo = all.filter((i) => !GRADING.has(i.group)).sort((a, b) => rank(a.group) - rank(b.group));
  const grade = all.filter((i) => GRADING.has(i.group));
  const scopes = [];
  if (demo.length) {
    const lines = [];
    for (const it of demo) {
      let line = scopeLine(it);
      if (it.group === "ceilings" && facts.ceiling && facts.ceiling.grid === "remain" && !/grid/i.test(line)) line += ", leave existing ceiling grid in place";
      lines.push(line);
      if (it.group === "ceilings" && facts.ceiling && facts.ceiling.grid === "remove" && !demo.some((d) => /grid/i.test(d.item))) lines.push("Properly remove ceiling grid");
      if (it.group === "ceilings" && facts.ceiling && facts.ceiling.devices && !lines.some((l) => /devices/.test(l))) {
        const d = Object.entries(facts.ceiling.devices).filter(([, n]) => Number(n) > 0).map(([k, n]) => `(${n}) ${k.replace(/_/g, " ")}`);
        if (d.length) lines.push(`Properly remove ceiling devices: ${d.join(", ")}`);
      }
    }
    scopes.push({ name: "Demolition", lines, _sections: ["Interior", "Exterior"] });
  }
  if (grade.length || (facts.excavation && Number(facts.excavation.depth_ft) > 0)) {
    const lines = grade.map(scopeLine);
    if (facts.recompaction_required) lines.push("Moisture condition and recompact soils in maximum 12\" lifts (per soils report)");
    scopes.push({ name: "GRADING/EXCAVATION", lines, _sections: ["Grading"] });
  }
  return { scopes, sectionOf: (it) => (GRADING.has(it.group) ? "Grading" : EXTERIOR.has(it.group) ? "Exterior" : "Interior") };
}
const rank = (g) => { const i = ORDER.indexOf(g); return i < 0 ? ORDER.indexOf("other") : i; };

// Fill rates from A2Z standards and the rate sheet; mark every line as a draft unless confirmed.
function draftLines(inputs, rates) {
  const sheet = (rates && rates.rate_sheet) || [];
  const std = (rates && rates.standard) || {};
  const crewDay = (std.crew_day_4man && std.crew_day_4man.rate) || 1600;
  const workerDay = (std.worker_day && std.worker_day.rate) || 400;
  const load = (std.truck_load_all_in && std.truck_load_all_in.rate) || 850;
  const by = {};
  const problems = [];
  for (const raw of (inputs && inputs.lines) || []) {
    const l = { ...raw };
    const d = String(l.description || "").toLowerCase();
    if (l.rate == null || l.rate === "") {
      if (l.category === "Labor") l.rate = /crew/.test(d) ? crewDay : workerDay;
      else if (l.category === "Hauling" && !/sub/.test(d)) l.rate = load;
      else if (l.category === "Equipment") {
        const per = l.per || "Day";
        const hit = sheet.filter((r) => r.per === per && d.includes(r.item.toLowerCase().split(" - ")[0].slice(0, 18)))[0]
          || sheet.filter((r) => r.per === per).find((r) => r.item.toLowerCase().split(/[ (]/).filter((w) => w.length > 2).every((w) => d.includes(w)));
        if (hit) { l.rate = hit.rate; l.basis = (l.basis ? l.basis + "; " : "") + `rate sheet: ${hit.item} per ${hit.per}`; }
      }
    }
    if (l.rate == null || l.rate === "") problems.push(`No rate for "${l.description}". Add one.`);
    const section = l.section || "Interior";
    delete l.section; delete l.per;
    if (!l.confirmed) l.draft = true;
    (by[section] = by[section] || []).push(l);
  }
  const sections = ["Interior", "Exterior", "Grading"].filter((s) => by[s]).map((s) => ({ name: s, lines: by[s] }));
  return { sections, problems };
}

function autoEstimate({ items, facts = {}, inputs = {}, job = {}, defaults = DEFAULTS, rates = null, markup = null }) {
  const { scopes } = draftScopes(items, facts);
  const { sections, problems } = draftLines(inputs, rates);
  const m = markup != null ? Number(markup) : Number(defaults.markup);
  const est = {
    job: { ...(facts.job || {}), ...job },
    sections,
    markup: m,
    scopes,
    exclusions: undefined,
    quantity_checks: facts.quantity_checks || [],
    excavation: facts.excavation || {},
    has_takeoff: items.length > 0,
    confirmed: [],
    auto: { mode: "draft", markup_source: markup != null ? "this job" : "default", problems, from_plans: facts.sources || {}, questions: facts.questions || [] },
  };
  if (facts.exclusions && facts.exclusions.length) est.extra_exclusions = facts.exclusions;
  if (facts.plan_flags && facts.plan_flags.length) est.plan_flags = facts.plan_flags;
  if (facts.notes && facts.notes.length) est.extra_notes = facts.notes;
  // price per scope at the markup, whole dollars, so the scope totals add up exactly.
  // pricing_auto keeps it that way as cost lines change (reprice), until someone types a bid or scope total.
  scopes.forEach((s) => { s.sections = s._sections; });
  est.pricing_auto = true;
  reprice(est);
  scopes.forEach((s) => delete s._sections);
  return est;
}

// Re-split the bid from the current cost lines and markup, while pricing_auto is on.
// Single scope: final = cost x (1 + markup), whole dollars. Several scopes: each scope priced from the
// sections it covers (scope.sections; unclaimed costs go to the first scope), final = their sum.
// Mutates and returns the estimate. A no-op once pricing_auto is false (someone set prices by hand).
function reprice(est) {
  if (!est || !est.pricing_auto) return est;
  const m = Number(est.markup);
  if (!isFinite(m)) return est;
  const sections = est.sections || [];
  const cost = (names) => sections.filter((s) => names.includes(s.name)).reduce((t, s) => t + (s.lines || []).reduce((u, l) => u + (Number(l.qty) || 0) * (Number(l.rate) || 0), 0), 0);
  const all = ["Interior", "Exterior", "Grading"];
  const base = (est.scopes || []).filter((s) => !s.alternate);
  if (!sections.length || !base.length) { delete est.final_price; return est; }
  if (base.length === 1) {
    base[0].price = null;
    est.final_price = Math.round(cost(all) * (1 + m));
  } else {
    const secOf = (s, i) => (Array.isArray(s.sections) && s.sections.length ? s.sections : i === 0 ? ["Interior", "Exterior"] : ["Grading"]);
    const claimed = new Set(base.flatMap((s, i) => secOf(s, i)));
    const orphan = cost(all.filter((n) => !claimed.has(n)));
    base.forEach((s, i) => { s.price = Math.round((cost(secOf(s, i)) + (i === 0 ? orphan : 0)) * (1 + m)); });
    est.final_price = base.reduce((t, s) => t + s.price, 0);
  }
  est.pricing_note = `${Math.round(m * 100)}% markup on cost, rounded to whole dollars${base.length > 1 ? " per scope" : ""} (priced automatically).`;
  return est;
}


function reviewSheet(priced, chk, comps, facts = {}) {
  const L = [];
  const job = priced.job || {};
  const m2 = (v) => "$" + Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  L.push(`# DRAFT estimate: ${job.name || job.location || "New job"}`, "");
  L.push(`Auto-drafted from the STACK takeoff${Object.keys(facts).length ? " and plan set" : ""}. Nothing here is approved. Review, answer the questions, then build the proposal.`, "");
  L.push("## Price", "");
  if (priced.total_cost != null) {
    L.push(`| | |`, `|---|---|`, `| Estimated cost | ${m2(priced.total_cost)} |`, `| Markup (on cost) | ${Math.round(priced.markup * 100)}% (${(priced.auto || {}).markup_source || "set"}) |`,
      `| **Proposed bid** | **${m2(priced.final_price)}** |`, `| Margin | ${Math.round(priced.margin * 100)}% |`);
    for (const s of priced.scopes || []) if (s.price != null) L.push(`| ${s.name} | ${m2(s.price)} |`);
  } else L.push("Not priced yet: no cost lines.");
  if (comps && comps.comps && comps.comps.length) {
    const top = comps.comps.slice(0, 3);
    const prices = top.map((c) => c.sentTotal).sort((a, b) => a - b);
    const med = prices[Math.floor(prices.length / 2)];
    L.push("", `Closest past jobs: ${top.map((c) => `${c.name} ${money0(c.sentTotal)} (${c.outcome}, match ${c.score.toFixed(2)})`).join("; ")}.`);
    if (priced.final_price) {
      const r = priced.final_price / med;
      L.push(`Bid is ${r >= 1 ? Math.round((r - 1) * 100) + "% above" : Math.round((1 - r) * 100) + "% below"} the median of the top 3 (${money0(med)}). Comps are a sanity check, not the price.`);
    }
  }
  L.push("", "## Scope included", "");
  for (const s of priced.scopes || []) { L.push(`**${s.name}**`); for (const l of s.lines || []) L.push(`- ${l}`); L.push(""); }
  L.push("## Cost lines (labor, equipment, hauling, other)", "", "| Section | Category | Description | Qty | Rate | Extended | Basis |", "|---|---|---|---|---|---|---|");
  for (const s of priced.sections || []) for (const l of s.lines) L.push(`| ${s.name} | ${l.category} | ${l.description} | ${l.qty} | ${m2(l.rate)} | ${m2(l.extended)} | ${l.draft ? "DRAFT: " : ""}${l.basis || ""} |`);
  const src = (priced.auto || {}).from_plans || {};
  if (Object.keys(src).length) { L.push("", "## Taken from the plans (confirm)", ""); for (const [k, v] of Object.entries(src)) L.push(`- ${k}: ${v}`); }
  const qs = (priced.auto || {}).questions || [];
  const fix = chk.issues.filter((i) => i.level === "block"), ask = chk.issues.filter((i) => i.level === "ask"), warn = chk.issues.filter((i) => i.level === "warn");
  L.push("", "## Needs a person", "");
  if (!fix.length && !ask.length && !warn.length && !qs.length) L.push("Nothing open. Ready for the estimator's OK.");
  for (const i of fix) L.push(`- **FIX** ${i.message}`);
  for (const i of ask) L.push(`- **QUESTION** ${i.message}`);
  for (const q of qs) L.push(`- **QUESTION (plans)** ${q}`);
  for (const i of warn) L.push(`- **CHECK** ${i.message}`);
  if ((priced.extra_exclusions || []).length) { L.push("", "## Suggested exclusions (from plans)", ""); for (const x of priced.extra_exclusions) L.push(`- ${x}`); }
  return L.join("\n");
}

module.exports = { reprice, autoEstimate, draftScopes, draftLines, reviewSheet, DEFAULTS, cleanName };
