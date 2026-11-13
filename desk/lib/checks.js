"use strict";
// Estimate checker: A2Z's estimating rules as plain code. No AI, no network, no file access,
// so the same function runs in the Cowork plugin, a Netlify function and the browser.
//
//   checkEstimate(estimate, { rates }) -> { ok, priced, issues: [ { id, level, where, message } ] }
//
// Levels:
//   block = the numbers are wrong or missing; don't build a proposal until fixed
//   ask   = a question the estimator must answer; answer it by adding the rule id to
//           estimate.confirmed (e.g. "confirmed": ["sawcut", "ceiling_height"])
//   warn  = looks off; fix it or add a pricing_note / confirmation
//
// Extra estimate fields this file reads (all optional):
//   pricing_note: "why the bid differs from the markup price"
//   price_source: "proposal" | "costing_sheet" | "transcript" | "notes" | "memory"
//   job.access: "roll-up door", "single man door", ...
//   job.ceiling_height_ft: 12
//   excavation: { footprint_sf, depth_ft, volume_cy, loads }
//   quantity_checks: [ { item, takeoff_qty, plan_qty, unit, source } ]
//   confirmed: [ rule ids already answered ]
//   plan_flags: [ { key, level, message, sheet } ] from lib/plans.js analyzePlans (each answered by adding its key to confirmed)
//
// Every rule comes from references/training-notes.md. Add a rule here + a test when a new lesson comes in.

const { computeEstimate } = require("./price");

const STANDARD = { worker_day: 400, crew_day_4man: 1600, load: 850, hourly: [50, 65, 85] };

const RULES = {
  // math and structure
  line_values: { level: "block", lesson: "Every cost line needs a quantity and a rate." },
  price_basis: { level: "block", lesson: "Give a markup or a final price; the bot never picks one." },
  markup_format: { level: "block", lesson: "Markup is a decimal on cost (1.4 = 140%)." },
  scope_sum: { level: "block", lesson: "Scope line items must add up exactly to the total bid." },
  scope_prices: { level: "block", lesson: "With several base scopes, every scope needs its own price." },
  template_scopes: { level: "block", lesson: "A2Z's proposal template holds 3 scopes." },
  template_alternates: { level: "warn", lesson: "A2Z's proposal template has no alternate section." },
  below_cost: { level: "block", lesson: "Final price is below cost." },
  bid_vs_markup: { level: "ask", lesson: "Keep cost, price at markup and final bid separate; say why the bid differs." },
  low_markup: { level: "ask", lesson: "A2Z usually marks up 100%+; a lower markup needs a reason." },
  unconfirmed_price: { level: "block", lesson: "Prices from transcripts or notes must be checked against the proposal or costing sheet." },
  draft_inputs: { level: "ask", lesson: "Auto-drafted crew-days, loads and equipment must be confirmed by the estimator." },
  empty_line: { level: "warn", lesson: "Remove cost lines that don't apply." },
  mixed_scope: { level: "warn", lesson: "Price demolition and grading/excavation as separate scopes." },
  // cost lines
  labor_rate: { level: "ask", lesson: "Labor is $400 per worker-day, $1,600 per 4-man crew-day, or $50/$65/$85 per hour." },
  lift_delivery: { level: "ask", lesson: "Equipment delivery and pickup are separate charges." },
  haul_rate: { level: "ask", lesson: "Standard haul is $850 all-in per load; other rates must be a subcontract price." },
  sub_haul_fuel: { level: "warn", lesson: "Subcontracted hauling already includes its fuel." },
  equipment_quote: { level: "ask", lesson: "Large or long equipment rentals need a current quote." },
  equipment_vs_sheet: { level: "warn", lesson: "Equipment rate is far above the rate sheet's monthly rate." },
  // scope
  sawcut: { level: "ask", lesson: "Don't include saw cutting unless the work needs it." },
  new_work: { level: "warn", lesson: "New construction (new slab, mat slab, footing) is not demo scope." },
  ceiling_grid: { level: "ask", lesson: "Ceiling tiles and grid are separate; say whether the grid stays." },
  ceiling_devices: { level: "ask", lesson: "Ceiling devices need counts or a 'by others' decision." },
  ceiling_height: { level: "ask", lesson: "Ceiling height decides the lift." },
  work_order: { level: "warn", lesson: "Interior demo order: millwork, carpet/base, doors/walls, ceiling, then what stays." },
  access: { level: "ask", lesson: "Access (single man door vs roll-up) changes handling time and hauling." },
  lifts_recompaction: { level: "ask", lesson: "Grading: include 12\" lifts and recompaction when the plans or soils report require it." },
  excavation_chain: { level: "ask", lesson: "Excavation: show footprint, depth, volume and loads." },
  excavation_math: { level: "warn", lesson: "Footprint x depth should match the stated volume." },
  // quantities
  quantity_gap: { level: "warn", lesson: "Takeoff quantity doesn't match the plan dimensions." },
  quantity_unchecked: { level: "ask", lesson: "Cross-check key takeoff quantities against plan dimensions." },
};

const money = (v) => "$" + Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 });
const lc = (s) => String(s || "").toLowerCase();

function checkEstimate(est, opts = {}) {
  const rates = opts.rates || null;
  if (est.pricing_auto) require("./auto").reprice(est);
  const confirmed = new Set((est.confirmed || []).map(String));
  const issues = [];
  const add = (id, where, message) => {
    if (confirmed.has(id) && RULES[id].level !== "block") return;
    issues.push({ id, level: RULES[id].level, where, message, lesson: RULES[id].lesson });
  };

  const sections = est.sections || [];
  const allLines = [];
  sections.forEach((s) => (s.lines || []).forEach((ln, i) => allLines.push({ ...ln, section: s.name, where: `${s.name} line ${i + 1}` })));
  const scopes = est.scopes || [];
  const scopeText = scopes.map((s) => [s.name, ...(s.lines || [])].join("\n")).join("\n");
  const allText = lc(scopeText + "\n" + allLines.map((l) => l.description).join("\n"));

  // ---- math and structure ----
  let lineProblem = false;
  for (const l of allLines) {
    const q = Number(l.qty), r = Number(l.rate);
    if (l.qty == null || l.rate == null || l.qty === "" || l.rate === "" || !isFinite(q) || !isFinite(r) || q < 0 || r < 0) {
      add("line_values", l.where, `"${l.description || l.category}" is missing a quantity or rate.`); lineProblem = true;
    } else if (q === 0 || r === 0) add("empty_line", l.where, `"${l.description || l.category}" is $0. Remove it if it doesn't apply.`);
  }
  const hasMarkup = est.markup != null && est.markup !== "";
  if (!hasMarkup && !est.final_price) add("price_basis", "pricing", "No markup and no final price.");
  if (hasMarkup && Number(est.markup) > 5) add("markup_format", "pricing", `Markup is ${est.markup}. Did you mean ${Number(est.markup) / 100} (${est.markup}%)?`);

  const base = scopes.filter((s) => !s.alternate);
  if (base.length > 1 && base.some((s) => s.price == null || s.price === "")) add("scope_prices", "scopes", "Several base scopes, but not all have a price.");
  if (base.length > 3) add("template_scopes", "scopes", `${base.length} scopes, but the proposal template holds 3. Combine ${base.slice(3).map((s) => s.name).join(", ")} into another scope.`);
  if (scopes.some((s) => s.alternate)) add("template_alternates", "scopes", `The proposal template has no alternate section, so ${scopes.filter((s) => s.alternate).map((s) => s.name).join(", ")} won't print. Make it a scope or a note, or remove it.`);

  let priced = null;
  if (!lineProblem && (hasMarkup || est.final_price)) {
    try { priced = computeEstimate(est); }
    catch (e) {
      if (/Scope prices add to/.test(e.message)) add("scope_sum", "scopes", e.message);
      else add("line_values", "estimate", e.message);
      // still price it without the scope check so the rest of the rules can run
      try { priced = computeEstimate({ ...est, scopes: [] }); } catch (_) { priced = null; }
    }
  }
  if (priced) {
    if (priced.final_price < priced.total_cost) add("below_cost", "pricing", `Final ${money(priced.final_price)} is below cost ${money(priced.total_cost)}.`);
    if (priced.computed_price != null && Math.abs(priced.final_price - priced.computed_price) > 0.5 && !est.pricing_note)
      add("bid_vs_markup", "pricing", `Price at markup is ${money(priced.computed_price)} but the bid is ${money(priced.final_price)}. Add a pricing note saying why.`);
    if (priced.effective_markup != null && priced.effective_markup < 1 && priced.final_price >= priced.total_cost && !est.pricing_note)
      add("low_markup", "pricing", `Effective markup is ${Math.round(priced.effective_markup * 100)}% (margin ${Math.round(priced.margin * 100)}%). Add a pricing note saying why.`);
  }
  if (["transcript", "notes", "memory", "verbal"].includes(lc(est.price_source)))
    add("unconfirmed_price", "pricing", `Price came from ${est.price_source === "transcript" ? "a transcript" : est.price_source}. Check it against the proposal or costing sheet, then mark which one you checked.`);

  const demoWords = /\bdemo|demolition|demolish/;
  const gradeWords = /grading|excavat|export|import|over.?ex/;
  for (const s of base) {
    const n = lc(s.name);
    if (demoWords.test(n) && gradeWords.test(n)) add("mixed_scope", `scope "${s.name}"`, "Demolition and grading/excavation are in one scope. Split them so each has its own price.");
  }

  // ---- cost lines ----
  const drafts = allLines.filter((l) => l.draft);
  if (drafts.length) add("draft_inputs", "cost lines", `${drafts.length} cost line${drafts.length === 1 ? " is a draft" : "s are drafts"} (${drafts.map((l) => l.description).slice(0, 4).join("; ")}${drafts.length > 4 ? "; ..." : ""}). Confirm the crew-days, loads and equipment.`);
  for (const l of allLines.filter((x) => lc(x.category) === "labor")) {
    const r = Number(l.rate), d = lc(l.description);
    const ok = r === STANDARD.worker_day || r === STANDARD.crew_day_4man || STANDARD.hourly.includes(r) || /sub|lump|per sf|per lf/.test(d);
    if (!ok) add("labor_rate", l.where, `Labor rate ${money(r)} isn't a standard rate. Confirm the basis.`);
  }
  const equip = allLines.filter((x) => lc(x.category) === "equipment" || /lift|excavator|skid|bobcat|breaker|scraper/.test(lc(x.description)));
  const hasDelivery = /deliver|pick.?up|transport|mobiliz/.test(allText);
  if (equip.some((l) => /lift|excavator|skid steer|scraper/.test(lc(l.description))) && !hasDelivery)
    add("lift_delivery", "equipment", "Rented equipment has no delivery or pickup line. Add them or confirm they're included.");
  for (const l of equip) {
    const ext = Number(l.qty) * Number(l.rate);
    if (ext >= 10000 || /verify|quote|tbd/.test(lc(l.description))) add("equipment_quote", l.where, `${l.description} (${money(ext)}). Confirm with a current quote.`);
    if (rates && rates.rate_sheet) {
      const size = (lc(l.description).match(/(\d+)\s?k\b/) || [])[1];
      const kind = ["excavator", "skid steer", "scissor lift", "scraper"].find((k) => lc(l.description).includes(k));
      if (kind) {
        const rows = rates.rate_sheet.filter((x) => lc(x.item).includes(kind.split(" ")[0]) && (!size || lc(x.item).includes(size + "k")) && x.per === "Month");
        const month = rows.length ? Math.max(...rows.map((x) => x.rate)) : null;
        if (month && Number(l.rate) > month * 2)
          add("equipment_vs_sheet", l.where, `${money(l.rate)} for ${l.description}, but the rate sheet's highest monthly rate is ${money(month)}.`);
      }
    }
  }
  const haul = allLines.filter((x) => lc(x.category) === "hauling");
  const subHaul = haul.filter((l) => /sub|super ?ten|super ?10|trucking co/.test(lc(l.description)));
  for (const l of haul) if (Number(l.rate) !== STANDARD.load && !subHaul.includes(l)) add("haul_rate", l.where, `Haul at ${money(l.rate)}/load instead of $850. If it's subcontracted, say "sub" in the description.`);
  if (subHaul.length && allLines.some((l) => lc(l.category) === "fuel" && /haul|truck/.test(lc(l.description))))
    add("sub_haul_fuel", "fuel", "Hauling is subcontracted but there's also a hauling fuel line.");

  // ---- scope ----
  if (/saw.?cut/.test(allText)) add("sawcut", "scope", "Saw cutting is in the estimate. Confirm the work needs it.");
  if (/(new|\(n\)|proposed)\s+[^\n]{0,20}(slab|footing|foundation)|mat slab/.test(allText)) add("new_work", "scope", "Mentions new slab/footing/foundation work. That's new construction, not demo; exclude it unless intended.");
  const ceiling = /ceiling|\bact\b|acoustic/.test(lc(scopeText));
  if (ceiling) {
    if (!/grid/.test(lc(scopeText))) add("ceiling_grid", "scope", "Ceiling work but no mention of the grid. Does it stay or go?");
    if (/light|diffuser|grille|speaker|security|sensor|detector/.test(lc(scopeText))) add("ceiling_devices", "scope", "Ceiling devices listed. Confirm counts for each, or mark them by others.");
    if (!(est.job && est.job.ceiling_height_ft)) add("ceiling_height", "job", "Ceiling work but no ceiling height. Needed to size the lift.");
  }
  const interior = scopes.length && /interior|millwork|carpet|ceiling|walls?|doors?/.test(lc(scopeText)) && !gradeWords.test(lc(scopeText));
  if (interior) {
    const order = [/millwork|cabinet|casework|counter/, /carpet|flooring|base\b|vct|tile floor/, /\bdoors?\b|\bwalls?\b|partition/, /ceiling|\bact\b/];
    const lines = scopes.flatMap((s) => s.lines || []).map(lc);
    const firstIdx = order.map((re) => lines.findIndex((t) => re.test(t))).filter((i) => i >= 0);
    for (let i = 1; i < firstIdx.length; i++) if (firstIdx[i] < firstIdx[i - 1]) {
      add("work_order", "scope", "Scope lines are out of work order (millwork, carpet/base, doors/walls, ceiling)."); break;
    }
    if (!(est.job && est.job.access)) add("access", "job", "Access isn't set. Pick how the crew gets in and out (single man door, roll-up door, stairs...).");
  }
  const grading = gradeWords.test(lc(scopeText));
  if (grading && !/lift|recompact|compact/.test(lc(scopeText))) add("lifts_recompaction", "scope", "Grading scope doesn't mention lifts or recompaction. Required by the plans or soils report?");
  const excavating = /excavat|basement|over.?ex/.test(lc(scopeText));
  if (excavating) {
    const x = est.excavation || {};
    const missing = ["footprint_sf", "depth_ft", "volume_cy", "loads"].filter((k) => !(Number(x[k]) > 0));
    if (missing.length) add("excavation_chain", "excavation", `Missing ${missing.join(", ")}.`);
    else {
      const calc = (Number(x.footprint_sf) * Number(x.depth_ft)) / 27;
      if (Math.abs(calc - x.volume_cy) / calc > 0.15)
        add("excavation_math", "excavation", `${x.footprint_sf} SF x ${x.depth_ft} ft = ${Math.round(calc).toLocaleString()} CY, but volume says ${Number(x.volume_cy).toLocaleString()} CY.`);
    }
  }

  // ---- quantities ----
  const qc = est.quantity_checks || [];
  for (const q of qc) {
    const t = Number(q.takeoff_qty), p = Number(q.plan_qty);
    if (t > 0 && p > 0 && Math.max(t, p) / Math.min(t, p) > 1.25)
      add("quantity_gap", q.item, `Takeoff ${t.toLocaleString()} ${q.unit || ""} vs plans ${p.toLocaleString()} ${q.unit || ""}${q.source ? ` (${q.source})` : ""}.`);
  }
  if (!qc.length && (est.takeoff || est.has_takeoff)) add("quantity_unchecked", "quantities", "No takeoff quantities were cross-checked against plan dimensions.");

  // ---- plan QC (lib/plans.js results stored on the estimate) ----
  for (const f of (est.plan_flags || []).concat(est.auto_flags || [])) {
    if (confirmed.has(f.key)) continue;
    const fromPlans = f.key.startsWith("plan_");
    issues.push({ id: f.key, level: f.level === "block" ? "ask" : f.level, where: fromPlans ? (f.sheet ? `plans ${f.sheet}` : "plans") : "autopilot", message: f.message,
      lesson: fromPlans ? "From the plan check (code reading the plan text, no AI)." : "From the autopilot draft (starter production numbers, no AI)." });
  }

  const order = { block: 0, ask: 1, warn: 2 };
  issues.sort((a, b) => order[a.level] - order[b.level]);
  return { ok: !issues.some((i) => i.level === "block"), priced, issues };
}

function formatIssues(res) {
  if (!res.issues.length) return "CHECKS: all clear";
  const tag = { block: "BLOCK", ask: "ASK  ", warn: "WARN " };
  return ["CHECKS:", ...res.issues.map((i) => `  ${tag[i.level]} [${i.id}] ${i.where}: ${i.message}`)].join("\n");
}

module.exports = { checkEstimate, formatIssues, RULES };
