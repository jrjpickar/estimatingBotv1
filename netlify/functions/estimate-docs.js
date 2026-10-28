// POST { estimate, takeoffCsv?, force? } -> proposal .docx + job costing .xlsx (base64), filled from A2Z's real templates.
// Refuses while the checker has FIX items, unless force is true (then the files are named DRAFT).
"use strict";
const { E, getAssets, json, parse, fileName } = require("../lib/engine");
exports.handler = async (event) => {
  try {
    const { estimate, takeoffCsv, force } = parse(event);
    if (!estimate) return json(400, { error: "Send { estimate }" });
    const assets = getAssets();
    const chk = E.checkEstimate(estimate, { rates: assets.rates });
    if (!chk.priced) return json(422, { error: "Estimate can't be priced yet.", issues: chk.issues });
    if (!chk.ok && !force) return json(422, { error: "Fix the FIX items first, or send force: true for a draft.", issues: chk.issues });
    const comps = takeoffCsv ? E.findComps(E.parseStackCsv(takeoffCsv), assets.library, { top: 5 }) : null;
    const docs = E.buildDocuments(chk.priced, comps, assets);
    const name = (chk.ok ? "" : assets.defaults.draft_prefix || "DRAFT - ") + fileName(chk.priced.job);
    return json(200, {
      ok: chk.ok, issues: chk.issues, priced: chk.priced, notes: docs.notes,
      proposalFileName: `${name} - Proposal.docx`, proposalBase64: docs.proposal.toString("base64"),
      costingFileName: `${name} - Job Costing.xlsx`, costingBase64: docs.costing.toString("base64"),
    });
  } catch (e) { return json(e.code || 400, { error: e.message }); }
};
