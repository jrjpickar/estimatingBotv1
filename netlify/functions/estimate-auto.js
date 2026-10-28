// Auto draft (code part): POST { takeoffCsv, inputs?, facts?, job?, markup? }
//   -> { estimate, priced, issues, comps, review } . Plan reading and drafting crew/loads
//   (facts / inputs) come from the Cowork plugin or a person; everything else is rules.
"use strict";
const { E, getAssets, json, parse } = require("../lib/engine");
exports.handler = async (event) => {
  try {
    const { takeoffCsv, inputs, facts, job, markup } = parse(event);
    if (!takeoffCsv) return json(400, { error: "Send { takeoffCsv } (STACK Takeoff Quantity CSV as text)" });
    const assets = getAssets();
    const items = E.parseStackCsv(takeoffCsv);
    const comps = E.findComps(items, assets.library, { top: 5 });
    const estimate = E.autoEstimate({ items, facts: facts || {}, inputs: inputs || {}, job: job || {}, defaults: assets.defaults, rates: assets.rates, markup: markup == null ? null : markup });
    const chk = E.checkEstimate(estimate, { rates: assets.rates });
    return json(200, {
      estimate, priced: chk.priced, ok: chk.ok, issues: chk.issues,
      comps: comps.comps.map((c) => ({ name: c.name, sentTotal: c.sentTotal, outcome: c.outcome, score: c.score, sharedGroups: c.sharedGroups, onlyInNew: c.onlyInNew })),
      review: E.reviewSheet(chk.priced || estimate, chk, comps, facts || {}),
    });
  } catch (e) { return json(e.code || 400, { error: e.message }); }
};
