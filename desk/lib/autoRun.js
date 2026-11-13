// Auto Estimate core, shared by the Netlify function and the in-page demo.
// Pure: the engine functions and data come in as arguments (no file access).
//
// runAutoEstimateWith(E, assets, { takeoffCsv, planPages, job, markup, learned, answers })
//   E: { parseStackCsv, autopilot, checkEstimate, proposalFields, findComps, learnedJobs, slotMap, reviewSheet? }
//   D: lib/decisions.js
// Pass 1 drafts with no answers (its checks become the questions). Pass 2
// re-drafts with the answers' overrides, adds the crew / truck / equipment
// questions from that draft, applies every answer and prices it again.
"use strict";

const LEVEL_TAG = { block: "FIX", ask: "QUESTION", warn: "CHECK" };

// Proposal bullet fields go out as plain lines, one per line, no bullet marks.
function plainBullets(fields) {
  const out = { ...fields };
  for (const k of ["scope_bullets1", "scope_bullets2", "scope_bullets3"]) {
    out[k] = String(out[k] || "").split("\n").map((l) => l.replace(/^\s*(?:[•·\-*]|\d+[.)])\s*/, "").trim()).filter(Boolean).join("\n");
  }
  return out;
}

// A small Job Costing Worksheet: the same sections and fixed rows as
// Job_Costing_Worksheet_V3 (Interior, Exterior, Grading), filled from the priced lines.
function costSheetOf(priced, slotMap) {
  const sections = priced.sections || [];
  const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
  const lineTotal = (l) => (l.extended != null ? Number(l.extended) : Number(l.qty || 0) * Number(l.rate || 0));
  const out = [];
  for (const block of slotMap(sections)) {
    if (!block.present) continue;
    const sec = sections.find((s) => String(s.name).trim().toLowerCase() === block.section.toLowerCase()) || { lines: [] };
    const rows = block.rows.map((r) => {
      const idx = [r.line, ...r.merged].filter((i) => i != null);
      const lines = idx.map((i) => sec.lines[i]);
      const total = lines.reduce((t, l) => t + lineTotal(l), 0);
      const one = lines.length === 1 ? lines[0] : null;
      return {
        row: r.row, cat: r.cat,
        description: lines.map((l) => l.description).join(" + "),
        qty: one ? Number(one.qty) : lines.length ? 1 : null,
        rate: one ? (one.rate == null ? null : Number(one.rate)) : lines.length ? r2(total) : null,
        total: lines.length ? r2(total) : null,
        draft: lines.some((l) => l.draft),
        basis: lines.map((l) => l.basis).filter(Boolean).join(" | "),
      };
    });
    out.push({ section: block.section, subRow: block.sub, rows, subtotal: r2(rows.reduce((t, r) => t + (r.total || 0), 0)) });
  }
  const cost = priced.total_cost ?? out.reduce((t, s) => t + s.subtotal, 0);
  return { sections: out, cost: r2(cost), markup: priced.effective_markup ?? priced.markup ?? null, bid: priced.final_price ?? null, margin: priced.margin ?? null };
}


function runAutoEstimateWith(E, D, a, { takeoffCsv, planPages = null, job = {}, markup = null, learned = null, answers = null }) {
  const slotMap = E.slotMap;
  const items = E.parseStackCsv(String(takeoffCsv || ""));
  if (!items.length) {
    const e = new Error("No takeoff lines found. Export it from STACK as Reports, Takeoff Quantity, CSV.");
    e.code = 400;
    throw e;
  }
  const pages = Array.isArray(planPages) && planPages.length ? planPages : null;
  const engineJob = { name: job.name || "", customer: job.customer || "", location: job.address || "", estimator: job.estimator || "", estimate_number: job.estimate_number || "" };
  const mk = markup == null || markup === "" ? null : Number(markup);
  const draft = (overrides) => E.autopilot({ items, pages, library: a.library, rates: a.rates, defaults: a.defaults, production: a.production, job: engineJob, markup: mk, learned, overrides });
  const ctx = { production: a.production, learned };
  const given = answers && typeof answers === "object" ? answers : {};
  // Removed scope lines ride in the answers as "drop:<line key>" (and
  // "drop:scope:demo" / "drop:scope:grading" for a whole scope).
  const drops = new Set(Object.keys(given).filter((k) => k.startsWith("drop:")).map((k) => k.slice(5)));
  // "No <section> work performed" on a crew question = drop that whole section.
  for (const [k, v] of Object.entries(given)) if (/^crew:/.test(k) && v === "none") drops.add("section:" + k.slice(5).toLowerCase());
  const ans = Object.fromEntries(Object.entries(given).filter(([k, v]) => !k.startsWith("drop:") && !(/^crew:/.test(k) && v === "none")));
  const dropOv = (ov) => {
    if (!drops.size) return ov;
    const out = { ...(ov || {}), dropCallouts: [...((ov && ov.dropCallouts) || [])], dropItems: [], dropScopes: [] };
    for (const k of drops) {
      if (k.startsWith("item:")) out.dropItems.push(k);
      else if (k.startsWith("callout:")) out.dropCallouts.push(k.slice(8));
      else if (k.startsWith("scope:")) out.dropScopes.push(k.slice(6));
      else if (k.startsWith("section:")) (out.dropSections = out.dropSections || []).push(k.slice(8));
    }
    return out;
  };

  // Pass 1: no answers (removed lines already out) -> the questions, so a
  // removed item or scope takes its questions with it.
  const ap1 = draft(dropOv(null));
  const apAll = drops.size ? draft(null) : ap1; // the full draft, for the Undo list
  const chk1 = E.checkEstimate(JSON.parse(JSON.stringify(ap1.estimate)), { rates: a.rates });
  const issueQs = D.buildQuestions({ sections: [] }, chk1.issues, ctx);
  // Low-stakes questions answer themselves unless the estimator picked something else.
  const ansIssues = { ...D.autoAnswers(issueQs, ans), ...ans };
  // Pass 2: overrides from the answers (and removed lines), then the line questions from that draft.
  const ap = Object.keys(ans).length || drops.size ? draft(dropOv(D.overridesFrom(issueQs, ansIssues))) : ap1;
  const est = ap.estimate;
  const baseCopy = JSON.parse(JSON.stringify(est));
  const lineQs = D.buildQuestions(baseCopy, [], ctx);
  const eff = { ...D.autoAnswers(lineQs, ans), ...ansIssues };
  D.applyAnswers(est, lineQs.concat(issueQs), eff, { ...ctx, base: baseCopy });
  // Text-only lines (ceiling grid, devices, recompaction, added by an answer) come off here.
  const keyOf = (text, keys) => (keys && keys[text]) || "text:" + String(text).toLowerCase().slice(0, 150);
  if (drops.size) for (const sc of est.scopes || []) sc.lines = (sc.lines || []).filter((l) => !drops.has(keyOf(l, est.line_keys)));
  est.scopes = (est.scopes || []).filter((sc) => (sc.lines || []).length);
  const chk = E.checkEstimate(est, { rates: a.rates });
  // New checks raised by the answers become questions too.
  const known = new Set(issueQs.flatMap((x) => x.ids));
  const moreQs = D.buildQuestions({ sections: [] }, chk.issues.filter((i) => !known.has(i.id)), ctx).filter((x) => !issueQs.some((y) => y.key === x.key));
  const questions = lineQs.concat(issueQs, moreQs);
  Object.assign(eff, D.autoAnswers(moreQs, eff));
  // A question is open while its check is still raised (or it has no answer yet).
  const openIds = new Set(chk.issues.map((i) => i.id));
  const pub = D.publicQuestions(questions, eff).map((x, n) => {
    const src = questions[n];
    const raised = src.ids.some((id) => openIds.has(id));
    const answered = x.answer != null && !(src.options.find((o) => o.id === x.answer) || { effect: {} }).effect.keepOpen;
    const autoAnswered = x.answer != null && ans[x.key] == null;
    return { ...x, autoAnswered, open: src.fix ? raised : !answered && (src.line || raised || src.ids.length === 0) };
  });

  const priced = chk.priced || est;
  const pf = E.proposalFields(priced, a.style);
  // Proposal lines with the key the Desk removes them by; removed ones listed for Undo.
  const kindOf = (name) => (/GRAD|EXCAV|EARTH/i.test(name || "") ? "grading" : "demo");
  const scopeLines = (priced.scopes || est.scopes || []).filter((sc) => !sc.alternate).map((sc) => ({ name: sc.name, kind: kindOf(sc.name), lines: (sc.lines || []).map((l) => ({ text: l, key: keyOf(l, est.line_keys) })) }));
  const firstText = {};
  for (const sc of apAll.estimate.scopes || []) for (const l of sc.lines || []) { const k = keyOf(l, apAll.estimate.line_keys); if (!firstText[k]) firstText[k] = l; }
  const scopeName = Object.fromEntries((apAll.estimate.scopes || []).map((sc) => [kindOf(sc.name), sc.name]));
  const removed = [...drops].map((k) => ({ key: k, text: k.startsWith("section:") ? `No ${k.slice(8)} work performed` : k.startsWith("scope:") ? `${scopeName[k.slice(6)] || k.slice(6)} (whole scope)` : firstText[k] || k.replace(/^(item|callout|text):/, "").replace(/\|.*$/, "") }));
  const extra = learned ? E.learnedJobs(learned) : [];
  // Master Job List jobs (bundled seed + weekly CSV) dedupe by row id and the
  // latest revision of a job wins (E.mergeMasterJobs; the in-page demo has none).
  const merge = E.mergeMasterJobs || ((jobs) => jobs);
  const lib = extra.length ? { ...a.library, jobs: merge([...(a.library.jobs || []), ...extra]) } : a.library;
  const comps = ap.comps || E.findComps(items, lib, { top: 5 });
  return {
    proposalFields: plainBullets(pf.fields),
    warnings: pf.warnings,
    price: { cost: priced.total_cost ?? null, bid: priced.final_price ?? null, markup: priced.effective_markup ?? priced.markup ?? null, margin: priced.margin ?? null, note: priced.pricing_note || "" },
    sections: (priced.sections || []).map((s) => ({ name: s.name, lines: (s.lines || []).map((l) => ({ category: l.category, description: l.description, qty: l.qty, rate: l.rate ?? null, extended: l.extended ?? null, draft: !!l.draft, basis: l.basis || "" })) })),
    questions: pub,
    answers: { ...Object.fromEntries(pub.filter((x) => x.answer != null && !x.autoAnswered).map((x) => [x.key, x.answer])), ...Object.fromEntries([...drops].map((k) => ["drop:" + k, "1"])) },
    scopeLines,
    removed,
    issues: (chk.issues || []).map((i, n) => ({ key: `${i.id || "issue"}:${n}`, level: i.level, tag: LEVEL_TAG[i.level] || "CHECK", where: i.where || "", message: i.message })),
    exclusions: (priced.extra_exclusions || []).slice(),
    costSheet: costSheetOf(priced, slotMap),
    comps: ((comps && comps.comps) || []).slice(0, 5).map((c) => ({ name: c.name, sentTotal: c.sentTotal, outcome: c.outcome, score: c.score, sharedGroups: c.sharedGroups })),
    planCheck: ap.planCheck ? { stats: ap.planCheck.stats, sheets: ap.planCheck.sheets } : null,
    takeoffLines: items.length,
    learned: priced.learned || null,
    review: E.reviewSheet ? E.reviewSheet(priced, chk, comps, {}) : "",
  };
}

module.exports = { runAutoEstimateWith, plainBullets, costSheetOf, LEVEL_TAG };
