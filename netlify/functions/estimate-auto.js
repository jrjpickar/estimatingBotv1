// Auto draft (code part): POST { takeoffCsv, planPages?, inputs?, facts?, job?, markup? }
//   planPages: [ { n, lines: [text...] } ] plan text per page (the page reads it with pdf.js); runs the code plan check.
//   -> { estimate, priced, issues, comps, review } . Plan reading and drafting crew/loads
//   (facts / inputs) come from the Cowork plugin or a person; everything else is rules.
"use strict";
const { E, getAssets, json, parse } = require("../lib/engine");
exports.handler = async (event) => {
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
    const estimate = E.autoEstimate({ items, facts, inputs: inputs || {}, job: job || {}, defaults: assets.defaults, rates: assets.rates, markup: markup == null ? null : markup });
    const chk = E.checkEstimate(estimate, { rates: assets.rates });
    return json(200, {
      estimate, priced: chk.priced, ok: chk.ok, issues: chk.issues,
      comps: comps.comps.map((c) => ({ name: c.name, sentTotal: c.sentTotal, outcome: c.outcome, score: c.score, sharedGroups: c.sharedGroups, onlyInNew: c.onlyInNew })),
      review: E.reviewSheet(chk.priced || estimate, chk, comps, facts || {}),
      planCheck: planCheck && { stats: planCheck.stats, sheets: planCheck.sheets, callouts: planCheck.callouts },
    });
  } catch (e) { return json(e.code || 400, { error: e.message }); }
};
