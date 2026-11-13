"use strict";
// Autopilot: STACK takeoff (+ plan text) -> a complete draft estimate with NO person and NO AI in the loop.
//   autopilot({ items, pages, library, rates, defaults, production, job, markup })
//     -> { estimate, comps, planCheck }
// Crew-days, loads and equipment come from data/production.json (starter numbers, editable) and the rate sheet.
// Every drafted line is marked draft with its basis, so the checker asks the estimator to confirm it.
// Comps are an automatic sanity check: a bid far from the closest past jobs is flagged.

const { autoEstimate, draftScopes, splitSheets, itemKey } = require("./auto");
const { applyLearned, learnedJobs } = require("./learn");
const { analyzePlans } = require("./plans");
const { findComps } = require("./comps");

const GRADING = new Set(["grading_excavation", "erosion_control"]);
const EXTERIOR = new Set(["roofing", "exterior_finishes", "whole_structure", "concrete_sawcut_slab", "hardscape_site", "block_wall_fence"]);
const SKIP = new Set(["haul_containers", "labor_equipment"]);
const sectionOf = (g) => (GRADING.has(g) ? "Grading" : EXTERIOR.has(g) ? "Exterior" : "Interior");
const r2 = (x) => Math.round(x * 100) / 100;
const fmt = (x) => Number(x).toLocaleString("en-US", { maximumFractionDigits: 0 });

function liftFor(ht) {
  if (!ht || ht <= 12) return "Scissor Lift 15 ft Electric";
  if (ht <= 15) return "Scissor Lift 19 ft Electric";
  if (ht <= 22) return "Scissor Lift 26 ft Electric";
  return "Scissor Lift 32 ft Electric";
}

// A plan keynote as an A2Z scope line: the verb kept, sheet code only in the
// closing parentheses. "SAWCUT AND REMOVE (E) DRIVEWAY" -> "Properly saw cut,
// break and haul (E) driveway per plans (C1)"; grading keynotes keep their wording.
const UPPER_WORDS = /\b(act|vct|lvt|cmu|hvac|rtu|gwb|mep|ac|fci|ofci)\b/g;
function calloutLine(callout, sheet) {
  const t = String(callout || "").trim();
  const low = (x) => x.toLowerCase().replace(/\((e|n)\)/g, (m) => m.toUpperCase()).replace(UPPER_WORDS, (m) => m.toUpperCase()).trim();
  let verb, rest;
  const GR = /^(OVER[-\s]?EXCAVATE|EXCAVATE|CLEAR\s*(?:&|AND)\s*GRUB|EXPORT|ROUGH\s+GRADE|SCARIFY|RE-?COMPACT)\b/i;
  if (GR.test(t)) { const sp = splitSheets(t, sheet); const x = low(sp.name); return `${x.charAt(0).toUpperCase() + x.slice(1)} per plans${sp.sheets.length ? ` (${[...new Set(sp.sheets)].join(", ")})` : ""}`; }
  let m;
  if ((m = t.match(/^SAW\s*-?CUT(?:\s*,?\s*(?:BREAK\s*)?(?:&|AND)\s*(?:REMOVE|HAUL|DEMO(?:LISH)?))?\s+/i))) { verb = "saw cut, break and haul"; rest = t.slice(m[0].length); }
  else if ((m = t.match(/^BREAK\s*(?:&|AND)\s*(?:HAUL|REMOVE)\s+/i))) { verb = "break and haul"; rest = t.slice(m[0].length); }
  else if ((m = t.match(/^(?:CUT\s*(?:&|AND)\s*)?DEMO(?:LISH)?\s+/i))) { verb = /^CUT/i.test(t) ? "cut and remove" : "demolish"; rest = t.slice(m[0].length); }
  else if ((m = t.match(/^(?:CUT\s*(?:&|AND)\s*)?(?:REMOVE|TEAR\s*OUT|ABANDON|R\s*&\s*R)(?:\s+(?:AND|&)\s+DISPOSE\s+OF)?\s+/i))) { verb = /^ABANDON/i.test(t) ? "abandon" : "remove"; rest = t.slice(m[0].length); }
  else { verb = "remove"; rest = t; }
  const sp = splitSheets(rest, sheet);
  return `Properly ${verb} ${low(sp.name)} per plans${sp.sheets.length ? ` (${[...new Set(sp.sheets)].join(", ")})` : ""}`;
}

function draftInputs(items, facts = {}, prod, extraCallouts = []) {
  const crew = prod.crew_size || 4;
  const sec = {};
  const S = (name) => (sec[name] = sec[name] || { wd: 0, loads: 0, why: [], groups: {}, sawcut: false });
  for (const it of items) {
    if (SKIP.has(it.group)) continue;
    const p = ((prod.groups[it.group] || {})[it.unit]) || prod.by_unit[it.unit] || prod.by_unit.EA;
    const s = S(sectionOf(it.group));
    const wd = it.qty * p.wd, ld = it.qty * p.loads;
    s.wd += wd; s.loads += ld;
    s.groups[it.group] = s.groups[it.group] || { qty: 0, unit: it.unit, wd: 0 };
    if (s.groups[it.group].unit === it.unit) s.groups[it.group].qty += it.qty;
    s.groups[it.group].wd += wd;
    if (/saw\s?cut/i.test(it.item)) s.sawcut = true;
    s.why.push(`${splitSheets(it.item, it.plan).name} ${fmt(it.qty)} ${it.unit} = ${r2(wd)} wd`);
  }
  for (const c of extraCallouts) {
    const s = S(sectionOf(c.group || "other"));
    s.wd += prod.missing_callout_worker_days; s.why.push(`plan callout "${c.callout}" = ${prod.missing_callout_worker_days} wd allowance`);
  }
  const add = prod.condition_labor_add || {};
  const lines = [];
  for (const name of ["Interior", "Exterior", "Grading"]) {
    const s = sec[name]; if (!s || s.wd <= 0) continue;
    const extra = [];
    if (name === "Interior") {
      if ((facts.job || {}).floor_level >= 2) extra.push(["upper floor carry-down", add.upper_floor]);
      if (/man\s*door/i.test((facts.job || {}).access || "")) extra.push(["single man door access", add.man_door_access]);
      if (facts.occupied) extra.push(["occupied building", add.occupied]);
    }
    const pct = extra.reduce((t, [, p]) => t + (p || 0), 0);
    const wdAll = s.wd * (1 + pct);
    const days = Math.max(1, Math.ceil(wdAll / crew));
    lines.push({ section: name, category: "Labor", description: `${crew} workers x ${days} day${days === 1 ? "" : "s"}${extra.length ? ` (incl. ${extra.map(([w, p]) => `+${Math.round(p * 100)}% ${w}`).join(", ")})` : ""}`, qty: crew * days,
      basis: `autopilot: ${r2(s.wd)} worker-days from the production table (${s.why.slice(0, 6).join("; ")}${s.why.length > 6 ? "; ..." : ""})${extra.length ? `, +${Math.round(pct * 100)}% for ${extra.map(([w]) => w).join(" and ")} (from the plans)` : ""}, rounded up to full crew-days` });
    const loads = Math.max(1, Math.ceil(s.loads * (prod.haul_cushion || 1.2)));
    lines.push({ section: name, category: "Hauling", description: `${loads} load${loads === 1 ? "" : "s"}`, qty: loads, basis: `autopilot: ${r2(s.loads)} loads from the production table + ${Math.round(((prod.haul_cushion || 1.2) - 1) * 100)}% cushion` });

    const g = s.groups;
    if (name === "Interior") {
      if (g.ceilings) {
        const ht = (facts.job || {}).ceiling_height_ft, lift = liftFor(ht), d = Math.max(1, Math.ceil(g.ceilings.wd / crew));
        lines.push({ section: name, category: "Equipment", description: `${lift}`, qty: d, basis: `autopilot: ceiling work${ht ? `, ${ht} ft ceiling` : ", ceiling height unknown"}; ${d} day${d === 1 ? "" : "s"}` });
        lines.push({ section: name, category: "Equipment", description: "Lift delivery and pickup", qty: 2, rate: prod.equipment_delivery_each_way, basis: "autopilot: delivery + pickup (training notes)" });
      }
      if (g.flooring && g.flooring.unit === "SF" && g.flooring.qty > 800) {
        const d = Math.max(1, Math.ceil(g.flooring.qty / 3000));
        lines.push({ section: name, category: "Equipment", description: "Ride On Scraper (Ride Along Floor Scraper)", qty: d, basis: `autopilot: ${fmt(g.flooring.qty)} SF flooring` });
      }
    } else {
      const heavy = Math.max(1, Math.ceil(s.wd / crew));
      const big = name === "Grading" || g.whole_structure;
      const machines = big ? ["20k Excavator", "Full Sized Skid Steer - 72 in. Wide Wheeled"] : ["8k Mini Excavator", "Breaker Attachment 500lb (Skidsteer/Mini Ex)"];
      for (const m of machines) lines.push({ section: name, category: "Equipment", description: m, qty: heavy, basis: `autopilot: ${big ? "structure / grading" : "slab and hardscape"} work, ${heavy} day${heavy === 1 ? "" : "s"}` });
      if (s.sawcut) lines.push({ section: name, category: "Equipment", description: "Quickie Saw and Blade", qty: heavy, basis: "autopilot: saw cutting in the takeoff" });
      lines.push({ section: name, category: "Equipment", description: "Equipment delivery and pickup (verify)", qty: 2, rate: prod.equipment_delivery_each_way, basis: "autopilot: placeholder, get the real delivery charge" });
      lines.push({ section: name, category: "Fuel", description: `Fuel, ${heavy * (big ? 2 : 1)} machine-days`, qty: heavy * (big ? 2 : 1), rate: prod.fuel_per_heavy_equipment_day, basis: "autopilot: starter fuel allowance per machine-day" });
    }
  }
  return { lines };
}

// overrides (Estimating Desk, from the multiple-choice answers): { job: { access, floor_level, ceiling_height_ft },
//   occupied, ceiling: { grid }, recompaction_required, dropCallouts: [callout text] } -> applied on top of what the plans say.
//   dropItems: [itemKey] and dropScopes: ["demo" | "grading"] take scope lines (and their takeoff items) out of the bid.
function autopilot({ items: allItems, pages = null, library = null, rates, defaults, production, job = {}, markup = null, learned = null, overrides = null }) {
  // jobs learned from training uploads count as comps too
  const extra = learned ? learnedJobs(learned) : [];
  const lib = extra.length ? { ...(library || {}), jobs: [...((library && library.jobs) || []), ...extra] } : library;
  const ov0 = overrides || {};
  const dropItems = new Set(ov0.dropItems || []), dropScopes = new Set(ov0.dropScopes || []);
  const dropSections = new Set((ov0.dropSections || []).map((x) => String(x).toLowerCase()));
  // The plans are checked against the whole takeoff, so a removed item doesn't come back as a "missing" callout.
  const items = (allItems || []).filter((it) => !dropItems.has(itemKey(it)) && !(dropScopes.has("grading") && GRADING.has(it.group)) && !(dropScopes.has("demo") && !GRADING.has(it.group)) && !dropSections.has(sectionOf(it.group).toLowerCase()));
  const comps = lib && allItems.length ? findComps(allItems, lib, { top: 5 }) : null;
  const planCheck = pages && pages.length ? analyzePlans(pages, allItems) : null;
  const facts = planCheck ? { ...planCheck.facts, plan_flags: planCheck.flags } : {};
  if (planCheck && planCheck.flags.some((f) => f.kind === "condition" && /occupied/i.test(f.message))) facts.occupied = true;
  const ov = overrides || {};
  if (ov.job) facts.job = { ...(facts.job || {}), ...ov.job };
  if (ov.occupied != null) facts.occupied = !!ov.occupied;
  if (ov.ceiling) facts.ceiling = { ...(facts.ceiling || {}), ...ov.ceiling };
  if (ov.recompaction_required != null) facts.recompaction_required = !!ov.recompaction_required;
  const dropped = new Set((ov.dropCallouts || []).map((t) => String(t).toLowerCase()));

  // plan callouts with no takeoff line: add them to scope (and a small labor allowance) automatically
  const missing = planCheck && !dropScopes.has("demo") ? planCheck.flags.filter((f) => f.kind === "missing" && !dropped.has(String(f.callout || "").toLowerCase())) : [];
  const missingCallouts = missing.filter((f) => !dropSections.has(sectionOf((planCheck.callouts.find((c) => c.text === f.callout) || {}).group || "other").toLowerCase())).map((f) => ({ callout: f.callout, sheet: f.sheet, group: (planCheck.callouts.find((c) => c.text === f.callout) || {}).group }));
  const inputs = draftInputs(items, facts, production, missingCallouts);
  const est = autoEstimate({ items, facts, inputs, job, defaults, rates, markup });

  if (missingCallouts.length && est.scopes.length) {
    const s0 = est.scopes[0];
    const gradeScope = est.scopes.find((sc) => /GRAD|EXCAV|EARTH/i.test(sc.name || "")) || s0;
    for (const m of missingCallouts) {
      const line = calloutLine(m.callout, m.sheet);
      (GRADING.has(m.group) ? gradeScope : s0).lines.push(line);
      est.line_keys[line] = "callout:" + String(m.callout).toLowerCase();
    }
    // the plan "missing" questions become "added from plans, confirm" questions
    est.plan_flags = (est.plan_flags || []).map((f) => (f.kind === "missing" ? { ...f, message: `Added to scope from the plans (no takeoff quantity, ${production.missing_callout_worker_days} worker-day allowance): "${f.callout}" (${f.sheet}). Confirm it's covered.` } : f));
  }
  if (facts.exclusions && facts.exclusions.length) est.extra_exclusions = facts.exclusions.slice();
  // Removed lines / scopes / sections take their plan questions with them.
  if (dropItems.size || dropScopes.size || dropSections.size || dropped.size) {
    const keptNames = new Set(items.map((it) => String(it.item).toLowerCase()));
    const has = (g) => items.some((it) => it.group === g) || missingCallouts.some((c) => c.group === g);
    est.plan_flags = (est.plan_flags || []).filter((f) => {
      if (f.kind === "missing") return missingCallouts.some((c) => c.callout === f.callout);
      if (f.kind === "takeoff_only") { const q = (String(f.message).match(/"([^"]+)"/) || [])[1]; return !q || keptNames.has(q.toLowerCase()); }
      if (["no_rcp", "ceiling_height", "devices", "ceiling_missing"].includes(f.kind)) return has("ceilings") || (f.kind === "devices" && has("mep_electrical_hvac"));
      return true;
    });
    est.quantity_checks = (est.quantity_checks || []).filter((qc) => has(/ceil/i.test(qc.item) ? "ceilings" : "flooring"));
  }

  // A2Z's own wording and line items, learned from past proposals and cost sheets (Training)
  const auto_flags = [];
  if (learned) {
    const { changed, flags } = applyLearned(est, learned);
    for (const c of changed) if (c.kind === "scope" && est.line_keys[c.from]) est.line_keys[c.to] = est.line_keys[c.from];
    est.learned = { changed, proposals: (learned.counts || {}).proposals || 0, costsheets: (learned.counts || {}).costsheets || 0 };
    for (const f of flags) auto_flags.push({ ...f, sheet: "" });
  }
  // comps sanity check
  if (comps && comps.comps.length) {
    const top = comps.comps.slice(0, 3).map((c) => c.sentTotal).sort((a, b) => a - b), med = top[Math.floor(top.length / 2)];
    const cost = (est.sections || []).reduce((t, s) => t + s.lines.reduce((u, l) => u + Number(l.qty) * Number(l.rate || 0), 0), 0);
    const price = Math.round(cost * (1 + Number(est.markup)));
    if (med && price && (price < med * 0.5 || price > med * 2))
      auto_flags.push({ key: "auto_comps_gap", level: "warn", message: `Autopilot bid is about $${fmt(price)} but the closest past jobs center on $${fmt(med)}. Check the crew-days and loads.`, sheet: "" });
    est.comp_summary = { confidence: comps.comps[0].score >= 0.6 ? "medium" : "low", best_why: comps.comps[0].sharedGroups.join(", "), recommended_use: "sanity range only (autopilot)" };
  }
  if (dropScopes.size) est.scopes = (est.scopes || []).filter((sc) => !dropScopes.has(/GRAD|EXCAV|EARTH/i.test(sc.name || "") ? "grading" : "demo"));
  if (items.some((i) => GRADING.has(i.group))) auto_flags.push({ key: "auto_grading", level: "ask", message: "Grading / excavation was drafted from starter numbers. Verify the haul method (subbed or ours), equipment and duration; they drive the price.", sheet: "" });
  if (!pages || !pages.length) auto_flags.push({ key: "auto_no_plans", level: "ask", message: "No plans were checked. Upload the plan set so the takeoff can be checked against it.", sheet: "" });
  est.auto_flags = auto_flags;
  est.auto = { ...(est.auto || {}), mode: "autopilot", production_note: "crew-days, loads and equipment from data/production.json (starter numbers)" };
  return { estimate: est, comps, planCheck };
}

module.exports = { autopilot, draftInputs, liftFor, calloutLine };
