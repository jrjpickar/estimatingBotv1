// POST { estimate, takeoffCsv?, force? } -> proposal .docx + job costing .xlsx (base64), filled from A2Z's real templates.
// Refuses while the checker has FIX items, unless force is true. Files are named DRAFT while any FIX item
// or open QUESTION remains (autopilot drafts always start that way).
"use strict";
const { protect, resOk } = require("../lib/auth");
const { E, getAssets, json, parse, fileName } = require("../lib/engine");
async function inner(event) {
  try {
    const { estimate, takeoffCsv, force } = parse(event);
    if (!estimate) return json(400, { error: "Send { estimate }" });
    const assets = getAssets();
    const chk = E.checkEstimate(estimate, { rates: assets.rates });
    if (!chk.priced) return json(422, { error: "Estimate can't be priced yet.", issues: chk.issues });
    if (!chk.ok && !force) return json(422, { error: "Fix the FIX items first, or send force: true for a draft.", issues: chk.issues });
    const comps = takeoffCsv ? E.findComps(E.parseStackCsv(takeoffCsv), assets.library, { top: 5 }) : null;
    const docs = E.buildDocuments(chk.priced, comps, assets);
    const draft = !chk.ok || chk.issues.some((i) => i.level === "ask");
    const name = (draft ? assets.defaults.draft_prefix || "DRAFT - " : "") + fileName(chk.priced.job);
    return json(200, {
      ok: chk.ok, draft, issues: chk.issues, priced: chk.priced, notes: docs.notes,
      proposalFileName: `${name} - Proposal.docx`, proposalBase64: docs.proposal.toString("base64"),
      costingFileName: `${name} - Job Costing.xlsx`, costingBase64: docs.costing.toString("base64"),
    });
  } catch (e) { return json(e.code || 400, { error: e.message }); }
}
exports.handler = protect(inner, { audit: (event, res) => {
  let out = {}; try { out = JSON.parse(res.body || "{}"); } catch (e) {}
  const est = (JSON.parse(event.body || "{}").estimate) || {};
  return { action: "Made files", target: ((est.job || {}).name) || "", ok: resOk(res), error: out.error || "", detail: { bid: out.priced ? out.priced.final_price : "", draft: !!out.draft, id: est._id || "" } };
} });
