"use strict";
// Autopilot: STACK takeoff (+ plan text) -> a complete draft estimate with NO person and NO AI in the loop.
//   autopilot({ items, pages, library, rates, defaults, production, job, markup })
//     -> { estimate, comps, planCheck }
// Crew-days, loads and equipment come from data/production.json (starter numbers, editable) and the rate sheet.
// Every drafted line is marked draft with its basis, so the checker asks the estimator to confirm it.
// Comps are an automatic sanity check: a bid far from the closest past jobs is flagged.

const { autoEstimate, draftScopes } = require("./auto");
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
    s.why.push(`${it.item} ${fmt(it.qty)} ${it.unit} = ${r2(wd)} wd`);
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

function autopilot({ items, pages = null, library = null, rates, defaults, production, job = {}, markup = null, learned = null }) {
  // jobs learned from training uploads count as comps too
  const extra = learned ? learnedJobs(learned) : [];
  const lib = extra.length ? { ...(library || {}), jobs: [...((library && library.jobs) || []), ...extra] } : library;
  const comps = lib && items.length ? findComps(items, lib, { top: 5 }) : null;
  const planCheck = pages && pages.length ? analyzePlans(pages, items) : null;
  const facts = planCheck ? { ...planCheck.facts, plan_flags: planCheck.flags } : {};
  if (planCheck && planCheck.flags.some((f) => f.kind === "condition" && /occupied/i.test(f.message))) facts.occupied = true;

  // plan callouts with no takeoff line: add them to scope (and a small labor allowance) automatically
  const missing = planCheck ? planCheck.flags.filter((f) => f.kind === "missing") : [];
  const missingCallouts = missing.map((f) => ({ callout: f.callout, sheet: f.sheet, group: (planCheck.callouts.find((c) => c.text === f.callout) || {}).group }));
  const inputs = draftInputs(items, facts, production, missingCallouts);
  const est = autoEstimate({ items, facts, inputs, job, defaults, rates, markup });

  if (missingCallouts.length && est.scopes.length) {
    const s0 = est.scopes[0];
    for (const m of missingCallouts) {
      const txt = m.callout.replace(/^(CUT\s*(&|AND)\s*)?(DEMO(LISH)?|REMOVE)\s+/i, "").toLowerCase().replace(/\((e|n)\)/g, (x) => x.toUpperCase()).replace(/\b(act|vct|lvt|cmu|hvac|rtu|gwb|mep)\b/g, (x) => x.toUpperCase());
      s0.lines.push(`Properly remove ${txt}${m.sheet ? ` (per plans ${m.sheet})` : ""}`);
    }
    // the plan "missing" questions become "added from plans, confirm" questions
    est.plan_flags = (est.plan_flags || []).map((f) => (f.kind === "missing" ? { ...f, message: `Added to scope from the plans (no takeoff quantity, ${production.missing_callout_worker_days} worker-day allowance): "${f.callout}" (${f.sheet}). Confirm it's covered.` } : f));
  }
  if (facts.exclusions && facts.exclusions.length) est.extra_exclusions = facts.exclusions.slice();

  // A2Z's own wording and line items, learned from past proposals and cost sheets (Training)
  const auto_flags = [];
  if (learned) {
    const { changed, flags } = applyLearned(est, learned);
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
  if (items.some((i) => GRADING.has(i.group))) auto_flags.push({ key: "auto_grading", level: "ask", message: "Grading / excavation was drafted from starter numbers. Verify the haul method (subbed or ours), equipment and duration; they drive the price.", sheet: "" });
  if (!pages || !pages.length) auto_flags.push({ key: "auto_no_plans", level: "ask", message: "No plans were checked. Upload the plan set so the takeoff can be checked against it.", sheet: "" });
  est.auto_flags = auto_flags;
  est.auto = { ...(est.auto || {}), mode: "autopilot", production_note: "crew-days, loads and equipment from data/production.json (starter numbers)" };
  return { estimate: est, comps, planCheck };
}

module.exports = { autopilot, draftInputs, liftFor };
