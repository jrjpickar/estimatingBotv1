// Auto Estimate questions as multiple choice, answered by code (no AI).
//
// Every check the engine raises becomes one question with fixed choices.
// Each choice has a fixed effect on the estimate:
//   pre  -> overrides for the autopilot draft (access, floor, occupied, ceiling
//           grid and height, recompaction, plan callouts to leave out)
//   post -> edits on the drafted estimate (add or remove a scope line, an
//           exclusion or a cost line, change a crew or a load count)
// Then the estimate is checked and priced again, so the bid, the proposal
// lines and the cost sheet follow the answers.
//
//   buildQuestions(est, issues, ctx) -> [ { key, tag, title, detail, ids, options: [ { id, label, drafted } ] } ]
//   overridesFrom(questions, answers) -> autopilot overrides
//   applyAnswers(est, questions, answers, ctx) -> est (mutated; answered checks added to est.confirmed)
//
// Fewer questions per bid: a question with an `auto` option id is answered
// with that choice unless the estimator picks another one (autoAnswers). Those
// are the low-stakes checks (equipment / fuel lines, plan callouts added to
// scope, takeoff items not on the plans, plan exclusions, occupied / upper
// floor from the plans, "did you check" confirmations). Scope lines the
// estimator doesn't want come off with the Remove buttons instead.
"use strict";

const TAG = { block: "FIX", ask: "QUESTION", warn: "CHECK" };
const lc = (s) => String(s || "").toLowerCase();
const quoted = (msg) => (String(msg).match(/"([^"]+)"/) || [])[1] || "";
const titleCase = (t) => (t.charAt(0) + t.slice(1).toLowerCase()).replace(/\((e|n)\)/g, (m) => m.toUpperCase()).replace(/\.$/, "");
const fmt = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
const money = (n) => "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });

// ---------- Questions ----------

function q(key, issue, title, options, extra = {}) {
  return { key, tag: issue ? TAG[issue.level] || "CHECK" : "QUESTION", title, detail: issue ? issue.message : "", ids: issue ? [issue.id] : [], options, ...extra };
}
const opt = (id, label, effect = {}, more = {}) => ({ id, label, effect, ...more });

// Crew, haul and equipment questions come from the drafted cost lines themselves.
function lineQuestions(est) {
  const out = [];
  for (const s of est.sections || []) {
    const lines = s.lines || [];
    lines.forEach((l, i) => {
      if (!l.draft) return;
      const cat = lc(l.category);
      if (cat === "labor") {
        const m = String(l.description).match(/(\d+)\s+workers?\s+x\s+(\d+)\s+days?/i);
        const crew = m ? +m[1] : null, days = m ? +m[2] : null;
        const options = [opt("keep", m ? `Yes, ${crew} workers x ${days} day${days === 1 ? "" : "s"}` : "Yes, as drafted", { undraft: { section: s.name, index: i } }, { drafted: true })];
        if (m) {
          // Older saved answers (kept working, not shown): the picker below replaced them.
          options.push(opt("plus_day", `Add a day (${crew} x ${days + 1})`, { crew: { section: s.name, index: i, crew, days: days + 1 } }, { hidden: true }));
          if (days > 1) options.push(opt("minus_day", `Take off a day (${crew} x ${days - 1})`, { crew: { section: s.name, index: i, crew, days: days - 1 } }, { hidden: true }));
          options.push(opt("plus_worker", `Add a worker (${crew + 1} x ${days})`, { crew: { section: s.name, index: i, crew: crew + 1, days } }, { hidden: true }));
          if (crew > 2) options.push(opt("minus_worker", `One less worker (${crew - 1} x ${days})`, { crew: { section: s.name, index: i, crew: crew - 1, days } }, { hidden: true }));
        }
        // "No <section> work performed": the run takes that section's takeoff items out (autoRun, drop section).
        options.push(opt("none", `No ${lc(s.name)} work performed`, {}, { dropSection: s.name }));
        out.push({ key: `crew:${s.name}`, tag: "QUESTION", title: `${s.name} crew: is ${m ? `${crew} workers x ${days} day${days === 1 ? "" : "s"}` : `"${l.description}"`} right?`, detail: l.basis || "", ids: [], options, line: true,
          // Any crew: answer "crew:<workers>x<days>" (dynamicOption).
          picker: m ? { kind: "crew", workers: crew, days, section: s.name, index: i } : null });
      } else if (cat === "hauling") {
        const n = Number(l.qty) || 0;
        const options = [opt("keep", `Yes, ${n} load${n === 1 ? "" : "s"}`, { undraft: { section: s.name, index: i } }, { drafted: true }),
          opt("plus_load", `Yes, ${n + 1} loads`, { loads: { section: s.name, index: i, n: n + 1 } }, { hidden: true })];
        if (n > 1) options.push(opt("minus_load", `Yes, ${n - 1} load${n - 1 === 1 ? "" : "s"}`, { loads: { section: s.name, index: i, n: n - 1 } }, { hidden: true }));
        options.push(opt("none", "No, dumpsters / hauling by others", { removeLine: { section: s.name, index: i }, addExclusion: "Dumpsters and hauling by others" }));
        // Any load count: answer "loads:<n>" (dynamicOption).
        out.push({ key: `haul:${s.name}`, tag: "QUESTION", title: `${s.name}: do we include trucks?`, detail: `Drafted ${n} load${n === 1 ? "" : "s"}. ${l.basis || ""}`.trim(), ids: [], options, line: true,
          picker: { kind: "loads", loads: n, section: s.name, index: i } });
      } else {
        const what = cat === "fuel" ? "Fuel" : cat === "equipment" ? "Equipment" : l.category;
        out.push({ key: `line:${s.name}:${lc(l.description)}`, tag: "QUESTION", title: `${s.name} ${lc(what)}: include "${l.description}"?`, detail: `${fmt(l.qty)} x ${money(l.rate || 0)}. ${l.basis || ""}`.trim(), ids: [], line: true, auto: "keep",
          options: [opt("keep", "Yes, include it", { undraft: { section: s.name, index: i } }, { drafted: true }), opt("remove", "No, take it out", { removeLine: { section: s.name, index: i } })] });
      }
    });
  }
  return out;
}

function questionFor(issue, est, ctx) {
  const id = String(issue.id || "");
  const kind = id.startsWith("plan_") ? id.slice(5).split(":")[0] : id;
  const confirm = { confirm: true };
  switch (kind) {
    case "access":
      return q("access", issue, "How does the crew get in and out?", [
        opt("rollup", "Roll-up door / open access", { pre: { job: { access: "roll-up door" } } }),
        opt("mandoor", "Single man door (+10% labor)", { pre: { job: { access: "single man door" } } }),
        opt("stairs", "Upper floor, stairs or chute (+15% labor)", { pre: { job: { access: "stairs", floor_level: 2 } } }),
        opt("elevator", "Upper floor with freight elevator", { pre: { job: { access: "freight elevator" } } }),
      ]);
    case "ceiling_grid":
      return q("ceiling_grid", issue, "Does the ceiling grid stay or go?", [
        opt("remain", "Grid stays", { pre: { ceiling: { grid: "remain" } }, addScopeUnless: { text: "Leave existing ceiling grid in place", re: "grid" }, ...confirm }),
        opt("remove", "Remove the grid too", { pre: { ceiling: { grid: "remove" } }, addScopeUnless: { text: "Properly remove ceiling grid", re: "remove[^\\n]*grid" }, ...confirm }),
      ]);
    case "ceiling_height":
      return q("ceiling_height", issue, "How high is the ceiling? (picks the lift)", [
        opt("12", "12 ft or less", { pre: { job: { ceiling_height_ft: 12 } } }),
        opt("15", "13 to 15 ft", { pre: { job: { ceiling_height_ft: 15 } } }),
        opt("22", "16 to 22 ft", { pre: { job: { ceiling_height_ft: 22 } } }),
        opt("26", "Over 22 ft", { pre: { job: { ceiling_height_ft: 26 } } }),
      ]);
    case "ceiling_devices": case "devices":
      return q("ceiling_devices", issue, "Who removes the ceiling devices (lights, diffusers, grilles)?", [
        opt("us", "We do, include them in scope", { addScope: "Properly remove ceiling devices (lights, diffusers, grilles) per plans", ...confirm }),
        opt("others", "By others, add to exclusions", { addExclusion: "Ceiling devices (lights, diffusers, grilles) by others", ...confirm }),
      ]);
    case "lift_delivery":
      return q("lift_delivery", issue, "Do we include equipment delivery and pickup?", [
        opt("add", `Yes, add delivery and pickup (${money((ctx.production || {}).equipment_delivery_each_way || 150)} each way)`, { addLine: { section: "Interior", category: "Equipment", description: "Equipment delivery and pickup", qty: 2, rate: (ctx.production || {}).equipment_delivery_each_way || 150 }, ...confirm }),
        opt("included", "No, it's in the rental price", confirm),
      ]);
    case "sawcut":
      return q("sawcut", issue, "Does this job need saw cutting?", [
        opt("yes", "Yes, keep it", confirm),
        opt("no", "No, take saw cutting out", { removeScope: "saw ?cut", removeLinesLike: "saw", ...confirm }),
      ]);
    case "lifts_recompaction":
      return q("lifts_recompaction", issue, "Do the plans or soils report require 12\" lifts and recompaction?", [
        opt("yes", "Yes, add it to the scope", { pre: { recompaction_required: true }, ...confirm }),
        opt("no", "No", confirm),
      ]);
    case "quantity_unchecked":
      return q("quantity_unchecked", issue, "Did you check the takeoff quantities against the plans?", [
        opt("yes", "Yes, they match", confirm),
        opt("later", "Not yet", { keepOpen: true }),
      ]);
    case "quantity_gap":
      return q(`gap:${issue.where}`, issue, `${issue.where}: which quantity is right?`, [
        opt("takeoff", "The takeoff is right", confirm),
        opt("recheck", "Recheck in STACK first", { keepOpen: true }),
      ]);
    case "auto_no_plans":
      return q("auto_no_plans", issue, "Price it without the plans?", [
        opt("yes", "Yes, price from the takeoff only", confirm),
        opt("upload", "No, I'll add the plan set (Run again)", { keepOpen: true }),
      ]);
    case "auto_grading":
      return q("auto_grading", issue, "Who hauls the grading export?", [
        opt("us", "Our trucks, as drafted", confirm),
        opt("sub", "Subbed haul (mark the haul line sub)", { markSubHaul: "Grading", ...confirm }),
      ]);
    case "auto_comps_gap":
      return q("auto_comps_gap", issue, "The bid is far from the closest past jobs. Keep it?", [
        opt("keep", "Keep the bid", confirm),
        opt("review", "I'll review the crew and loads", { keepOpen: true }),
      ]);
    case "equipment_quote":
      return q(`quote:${issue.where}`, issue, "Use this equipment price or get a quote?", [
        opt("keep", "Use it as is", confirm),
        opt("quote", "Get a quote first", { keepOpen: true }),
      ]);
    case "missing": {
      const text = quoted(issue.message);
      return q(`missing:${lc(text)}`, issue, `"${text}" is on the plans. Is it in our scope?`, [
        opt("in", "Yes, it's in our scope", confirm, { drafted: true }),
        opt("others", "No, by others (add to exclusions)", { pre: { dropCallouts: [text] }, addExclusion: `${titleCase(text.replace(/^(cut\s*(&|and)\s*)?(demo(lish)?|remove)\s+/i, ""))} by others`, ...confirm }),
        opt("out", "No, not part of this job", { pre: { dropCallouts: [text] }, ...confirm }),
      ]);
    }
    case "by_others": {
      const text = quoted(issue.message);
      return q(`by_others:${lc(text)}`, issue, `Add "${titleCase(text)}" to the exclusions?`, [
        opt("yes", "Yes, exclude it", confirm, { drafted: true }),
        opt("no", "No, leave it off", { removeExclusion: titleCase(text), ...confirm }),
      ]);
    }
    case "hazmat":
      return q(`hazmat:${lc(quoted(issue.message))}`, issue, "Hazardous materials: is testing and abatement ours?", [
        opt("exclude", "No, by others (add to exclusions)", { addExclusion: "Hazardous material testing and abatement", ...confirm }),
        opt("ours", "Yes, it's priced in", confirm),
      ]);
    case "condition": {
      const m = lc(issue.message);
      if (/occupied/.test(m)) return q("cond:occupied", issue, "Does the building stay occupied during the work? (+10% labor)", [
        opt("yes", "Yes, keep the extra labor", confirm, { drafted: true }),
        opt("no", "No, take it out", { pre: { occupied: false }, ...confirm }),
      ]);
      if (/above the ground floor/.test(m)) return q("cond:floor", issue, "Is the work above the ground floor? (+15% labor for carry-down)", [
        opt("yes", "Yes, keep the carry-down labor", confirm, { drafted: true }),
        opt("no", "No, ground floor", { pre: { job: { floor_level: 1 } }, ...confirm }),
      ]);
      if (/dust|barrier/.test(m)) return q("cond:protection", issue, "Who provides dust protection and temporary barriers?", [
        opt("others", "By others (add to exclusions)", { addExclusion: "Dust protection and temporary barriers by others", ...confirm }),
        opt("us", "We do, it's in our labor", confirm),
      ]);
      return q(`cond:${lc(issue.message).slice(0, 40)}`, issue, "Is this covered in the price?", [opt("yes", "Yes, covered", confirm), opt("no", "Not yet", { keepOpen: true })]);
    }
    case "ceiling_missing":
      return q("plan:ceiling_missing", issue, "The ceiling plan has demo callouts the takeoff doesn't. Is the ceiling covered?", [
        opt("yes", "Yes, the plan callouts cover it", confirm),
        opt("redo", "No, I'll add ceiling lines in STACK", { keepOpen: true }),
      ]);
    case "no_rcp":
      return q("plan:no_rcp", issue, "No ceiling plan in the set. Is the ceiling scope right as drafted?", [
        opt("yes", "Yes, it's right", confirm),
        opt("check", "I'll check it", { keepOpen: true }),
      ]);
    case "unreadable":
      return q("plan:unreadable", issue, "Some plan pages had no readable text. Did you check them by eye?", [
        opt("yes", "Yes, checked", confirm),
        opt("no", "Not yet", { keepOpen: true }),
      ]);
    case "takeoff_only": {
      const text = quoted(issue.message);
      return q(`takeoff_only:${lc(text)}`, issue, `"${text}" is in the takeoff but not on the plans. Keep it in scope?`, [
        opt("keep", "Yes, keep it", confirm, { drafted: true }),
        opt("remove", "No, take it out of the scope", { removeScope: text.replace(/^(cut\s*(and|&)\s*)?(demo(lish)?|remove)\s+/i, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), ...confirm }),
      ]);
    }
    case "new_work":
      return q(`new_work:${lc(quoted(issue.message))}`, issue, "New work on the plans. Keep it out of our scope?", [
        opt("out", "Yes, keep it out", { addExclusion: `${titleCase(quoted(issue.message) || "New construction")} by others`, ...confirm }),
        opt("noted", "Already out, no exclusion needed", confirm),
      ]);
    default:
      break;
  }
  if (id.startsWith("learned_common:")) {
    const item = ((ctx.learned && ctx.learned.lineItems) || []).find((i) => lc(i.description) === id.slice(15));
    const rate = item && item.rateMedian ? Math.round(item.rateMedian) : null;
    return q(id, issue, `Past jobs usually include "${item ? item.description : quoted(issue.message)}". Add it?`, [
      opt("add", rate ? `Yes, add it (${money(rate)})` : "Yes, add it", { addLine: { section: "Interior", category: item ? item.category : "Misc", description: item ? item.description : quoted(issue.message), qty: 1, rate: rate || 0 }, ...confirm }),
      opt("no", "No, not on this job", confirm),
    ]);
  }
  if (id.startsWith("learned_rate:")) {
    return q(id, issue, "This rate is off from past cost sheets. Keep it?", [opt("keep", "Keep this rate", confirm), opt("review", "I'll change it", { keepOpen: true })]);
  }
  if (issue.level === "block") return q(`fix:${id}:${issue.where}`, issue, "Fix this before Build Proposal", [], { fix: true });
  return q(`ok:${id}:${issue.where}`, issue, issue.level === "warn" ? "Is this OK?" : "Is this right?", [
    opt("yes", issue.level === "warn" ? "Yes, it's fine" : "Yes, confirmed", confirm),
    opt("no", "Not yet", { keepOpen: true }),
  ]);
}

// Answered automatically (with this choice) unless the estimator picks another.
const AUTO_BY_KEY = {
  missing: "in", takeoff_only: "keep", by_others: "yes", "cond:occupied": "yes", "cond:floor": "yes",
  quantity_unchecked: "yes", "plan:unreadable": "yes", "plan:no_rcp": "yes", "plan:ceiling_missing": "yes",
  learned_rate: "keep", learned_common: "no", auto_comps_gap: "keep", quote: "keep", auto_no_plans: "yes",
};
function autoFor(x, issue) {
  if (x.fix || x.auto) return x.auto || null;
  const k = x.key.startsWith("cond:") || x.key.startsWith("plan:") ? x.key : x.key.split(":")[0];
  let a = AUTO_BY_KEY[k];
  if (!a && x.key.startsWith("ok:") && issue && issue.level === "warn") a = "yes";
  return a && x.options.some((o) => o.id === a) ? a : null;
}
// The auto answers for these questions, under the estimator's own answers.
function autoAnswers(questions, answers = {}) {
  const out = {};
  for (const x of questions) if (x.auto && !(answers && answers[x.key] != null)) out[x.key] = x.auto;
  return out;
}

function buildQuestions(est, issues, ctx = {}) {
  const out = [], seen = new Map();
  const push = (x) => {
    if (seen.has(x.key)) { const prev = seen.get(x.key); prev.ids = [...new Set(prev.ids.concat(x.ids))]; return; }
    seen.set(x.key, x); out.push(x);
  };
  lineQuestions(est).forEach(push);
  for (const i of issues || []) {
    if (i.id === "draft_inputs") continue; // covered by the crew / truck / equipment questions
    const x = questionFor(i, est, ctx);
    const a = autoFor(x, i);
    if (a) x.auto = a;
    push(x);
  }
  return out;
}

// ---------- Effects ----------

// Picker answers: "crew:<workers>x<days>" on a crew question, "loads:<n>" on a trucks question.
const MAX_WORKERS = 20, MAX_DAYS = 120, MAX_LOADS = 200;
function dynamicOption(x, a) {
  const p = x && x.picker;
  if (!p || typeof a !== "string") return null;
  let m;
  if (p.kind === "crew" && (m = a.match(/^crew:(\d{1,3})x(\d{1,3})$/))) {
    const crew = +m[1], days = +m[2];
    if (crew < 1 || crew > MAX_WORKERS || days < 1 || days > MAX_DAYS) return null;
    return opt(a, `${crew} workers x ${days} day${days === 1 ? "" : "s"}`, { crew: { section: p.section, index: p.index, crew, days } });
  }
  if (p.kind === "loads" && (m = a.match(/^loads:(\d{1,3})$/))) {
    const n = +m[1];
    if (n < 1 || n > MAX_LOADS) return null;
    return opt(a, `${n} load${n === 1 ? "" : "s"}`, { loads: { section: p.section, index: p.index, n } });
  }
  return null;
}
const optionFor = (x, a) => (a ? x.options.find((p) => p.id === a) || dynamicOption(x, a) : null);

function chosen(questions, answers) {
  const out = [];
  for (const x of questions) {
    const o = optionFor(x, answers && answers[x.key]);
    if (o) out.push({ q: x, o });
  }
  return out;
}

function overridesFrom(questions, answers) {
  const ov = { job: {}, dropCallouts: [] };
  for (const { o } of chosen(questions, answers)) {
    const p = o.effect.pre;
    if (!p) continue;
    if (p.job) Object.assign(ov.job, p.job);
    if (p.ceiling) ov.ceiling = { ...(ov.ceiling || {}), ...p.ceiling };
    if (p.occupied != null) ov.occupied = p.occupied;
    if (p.recompaction_required != null) ov.recompaction_required = p.recompaction_required;
    if (p.dropCallouts) ov.dropCallouts.push(...p.dropCallouts);
  }
  return ov;
}

// Lines are found by section and category position, so they still match after
// the overrides re-drafted the estimate.
function findLine(est, section, index, base) {
  const sec = (est.sections || []).find((s) => s.name === section);
  if (!sec) return null;
  const ref = base && base.sections ? ((base.sections.find((s) => s.name === section) || {}).lines || [])[index] : null;
  if (ref) {
    const sameCat = (base.sections.find((s) => s.name === section).lines || []).filter((l) => l.category === ref.category);
    const nth = sameCat.indexOf(ref);
    const here = sec.lines.filter((l) => l.category === ref.category);
    const hit = ref.category === "Labor" || ref.category === "Hauling" ? here[nth] : here.find((l) => l.description === ref.description) || null;
    return hit ? { sec, line: hit } : null;
  }
  return sec.lines[index] ? { sec, line: sec.lines[index] } : null;
}

function applyAnswers(est, questions, answers, ctx = {}) {
  est.confirmed = est.confirmed || [];
  const base = ctx.base || null;
  const removals = [];
  for (const { q: x, o } of chosen(questions, answers)) {
    const e = o.effect || {};
    if (e.undraft) { const f = findLine(est, e.undraft.section, e.undraft.index, base); if (f) f.line.draft = false; }
    if (e.crew) {
      const f = findLine(est, e.crew.section, e.crew.index, base);
      if (f) {
        const extra = (String(f.line.description).match(/\s*\(incl\.[^)]*\)/) || [""])[0];
        f.line.qty = e.crew.crew * e.crew.days;
        f.line.description = `${e.crew.crew} workers x ${e.crew.days} day${e.crew.days === 1 ? "" : "s"}${extra}`;
        f.line.basis = `${f.line.basis || ""}; set by the estimator's answer`.replace(/^; /, "");
        f.line.draft = false;
      }
    }
    if (e.loads) { const f = findLine(est, e.loads.section, e.loads.index, base); if (f) { f.line.qty = e.loads.n; f.line.description = `${e.loads.n} load${e.loads.n === 1 ? "" : "s"}`; f.line.draft = false; } }
    if (e.removeLine) { const f = findLine(est, e.removeLine.section, e.removeLine.index, base); if (f) removals.push(f); }
    if (e.addLine) {
      let sec = (est.sections || []).find((s) => s.name === e.addLine.section);
      if (!sec) { sec = { name: e.addLine.section, lines: [] }; est.sections.push(sec); }
      if (!sec.lines.some((l) => l.description === e.addLine.description)) sec.lines.push({ category: e.addLine.category, description: e.addLine.description, qty: e.addLine.qty, rate: e.addLine.rate, basis: "added by the estimator's answer" });
    }
    if (e.removeLinesLike) for (const s of est.sections || []) s.lines = s.lines.filter((l) => !new RegExp(e.removeLinesLike, "i").test(l.description));
    if (e.markSubHaul) for (const s of est.sections || []) if (s.name === e.markSubHaul) s.lines.forEach((l) => { if (l.category === "Hauling" && !/sub/i.test(l.description)) l.description += " (sub)"; });
    const first = (est.scopes || [])[0];
    if (e.addScope && first && !first.lines.includes(e.addScope)) first.lines.push(e.addScope);
    if (e.addScopeUnless && first && !(est.scopes || []).some((sc) => sc.lines.some((l) => new RegExp(e.addScopeUnless.re, "i").test(l)))) first.lines.push(e.addScopeUnless.text);
    if (e.removeScope) for (const s of est.scopes || []) s.lines = s.lines.filter((l) => !new RegExp(e.removeScope, "i").test(l));
    if (e.addExclusion) { est.extra_exclusions = est.extra_exclusions || []; if (!est.extra_exclusions.some((t) => lc(t) === lc(e.addExclusion))) est.extra_exclusions.push(e.addExclusion); }
    if (e.removeExclusion) est.extra_exclusions = (est.extra_exclusions || []).filter((t) => lc(t) !== lc(e.removeExclusion));
    if (e.confirm && !e.keepOpen) est.confirmed.push(...x.ids);
  }
  for (const f of removals) f.sec.lines = f.sec.lines.filter((l) => l !== f.line);
  est.sections = (est.sections || []).filter((s) => s.lines.length);
  return est;
}

// Strip the effects before sending questions to the page.
function publicQuestions(questions, answers) {
  return questions.map((x) => ({
    key: x.key, tag: x.tag, title: x.title, detail: x.detail, fix: !!x.fix, auto: x.auto || null,
    options: x.options.filter((o) => !o.hidden).map((o) => ({ id: o.id, label: o.label, drafted: !!o.drafted, keepOpen: !!(o.effect && o.effect.keepOpen), ...(o.dropSection ? { dropSection: o.dropSection } : {}) })),
    picker: x.picker ? { kind: x.picker.kind, workers: x.picker.workers, days: x.picker.days, loads: x.picker.loads, max: x.picker.kind === "crew" ? { workers: MAX_WORKERS, days: MAX_DAYS } : { loads: MAX_LOADS } } : null,
    answer: answers && optionFor(x, answers[x.key]) ? answers[x.key] : null,
  }));
}

module.exports = { buildQuestions, overridesFrom, applyAnswers, publicQuestions, questionFor, autoAnswers, AUTO_BY_KEY, dynamicOption, optionFor };
