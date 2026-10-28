// Auto draft: POST { takeoffCsv, planPages?, inputs?, facts?, job?, markup? }
//   Without inputs this is AUTOPILOT: everything is drafted by code, no AI, no person.
//   planPages: [ { n, lines: [text...] } ] plan text per page (the page reads it with pdf.js); runs the code plan check.
//   -> { estimate, priced, issues, comps, review } . Plan reading and drafting crew/loads
//   (facts / inputs) come from the Cowork plugin or a person; everything else is rules.
"use strict";
const { protect, resOk } = require("../lib/auth");
const { E, getAssets, json, parse } = require("../lib/engine");
async function inner(event) {
  try {
    const { takeoffCsv, planPages, inputs, job, markup, facts: given } = parse(event);
    if (!takeoffCsv) return json(400, { error: "Send { takeoffCsv } (STACK Takeoff Quantity CSV as text)" });
    const assets = getAssets();
    const items = E.parseStackCsv(takeoffCsv);
    const comps = E.findComps(items, assets.library, { top: 5 });
    let facts = given || {};
    let planCheck = null;
    if (Array.isArray(planPages) && planPages.length) {
      planCheck = E.analyzePlans(planPages, items);
      const pf = planCheck.facts;
      facts = { ...pf, ...facts, job: { ...pf.job, ...(facts.job || {}) }, sources: { ...pf.sources, ...(facts.sources || {}) },
        quantity_checks: (facts.quantity_checks || []).concat(pf.quantity_checks || []), plan_flags: (facts.plan_flags || []).concat(planCheck.flags) };
    }
    // no inputs -> AUTOPILOT: code drafts crew-days, loads and equipment (estimator/data/production.json)
    let estimate;
    if (!inputs || !inputs.lines || !inputs.lines.length) {
      const ap = E.autopilot({ items, pages: planPages, library: assets.library, rates: assets.rates, defaults: assets.defaults, production: assets.production, job: job || {}, markup: markup == null ? null : markup });
      estimate = ap.estimate; planCheck = ap.planCheck || planCheck;
    } else {
      estimate = E.autoEstimate({ items, facts, inputs, job: job || {}, defaults: assets.defaults, rates: assets.rates, markup: markup == null ? null : markup });
    }
    const chk = E.checkEstimate(estimate, { rates: assets.rates });
    return json(200, {
      estimate, priced: chk.priced, ok: chk.ok, issues: chk.issues,
      comps: comps.comps.map((c) => ({ name: c.name, sentTotal: c.sentTotal, outcome: c.outcome, score: c.score, sharedGroups: c.sharedGroups, onlyInNew: c.onlyInNew })),
      review: E.reviewSheet(chk.priced || estimate, chk, comps, facts || {}),
      planCheck: planCheck && { stats: planCheck.stats, sheets: planCheck.sheets, callouts: planCheck.callouts },
    });
  } catch (e) { return json(e.code || 400, { error: e.message }); }
}
exports.handler = protect(inner, { audit: (event, res) => {
  let out = {}; try { out = JSON.parse(res.body || "{}"); } catch (e) {}
  const job = (JSON.parse(event.body || "{}").job) || {};
  return { action: "Ran autopilot", target: job.name || "", ok: resOk(res), error: out.error || "", detail: { bid: out.priced ? out.priced.final_price : "", source: "server" } };
} });
