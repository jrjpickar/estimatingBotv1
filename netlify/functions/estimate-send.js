// Send: the finished cost sheet and proposal go to Make, and the GHL opportunity is updated like the Desk's Build Proposal.
//   POST { id, takeoffCsv? }  (id = a saved estimate; its latest version is what gets sent)
//   1. Refuses while any FIX or QUESTION is open (409).
//   2. Fills A2Z's two templates and POSTs JSON to the Make webhook (MAKE_BOT_WEBHOOK_URL):
//        costData = Job Costing Worksheet .xlsx (base64), genProp = proposal .docx (base64), jobAddress, opportunityId,
//        the proposal fields (same keys as GHL's Estimating custom fields) and who sent it.
//   3. If the estimate is linked to an opportunity: writes the proposal custom fields and moves it to
//      Generate Proposal (change order: Generate) in one PUT, the same as the Desk.
"use strict";
const { protect, authJson, parseBody, resOk } = require("../lib/auth");
const { E, getAssets, fileName } = require("../lib/engine");
const { estimateStore, validId } = require("../lib/estimates");
const G = require("../lib/ghl");

const DEFAULT_WEBHOOK = "https://hook.us2.make.com/srx3k2i5fbmy9y68ls9gkoa9h1jji7tt";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

async function inner(event) {
  if (event.httpMethod !== "POST") return authJson(405, { error: "POST only" });
  const body = parseBody(event);
  if (!validId(body.id)) return authJson(400, { error: "Save the estimate first, then send it." });
  const s = event.a2zSession;
  const who = { name: s.name || "", email: s.email || "" };
  try {
    const store = estimateStore(event);
    const record = await store.get(`estimates/${body.id}`, { type: "json" });
    if (!record) return authJson(404, { error: "That estimate wasn't found." });
    const est = record.estimate;
    const assets = getAssets();
    const chk = E.checkEstimate(est, { rates: assets.rates });
    const open = chk.issues.filter((i) => i.level === "block" || i.level === "ask");
    if (!chk.priced || open.length) return authJson(409, { error: `Clear every FIX and QUESTION before sending (${open.length} open).`, issues: open });
    const priced = chk.priced;
    const pf = E.proposalFields(priced, assets.style);
    let comps = null;
    if (body.takeoffCsv) { try { comps = E.findComps(E.parseStackCsv(String(body.takeoffCsv)), assets.library, { top: 5 }); } catch (e) { comps = null; } }
    const docx = E.fillProposal(assets.proposalTemplate, pf.doc);
    const xlsx = E.fillJobCosting(assets.costingTemplate, priced, comps);
    const job = priced.job || {};
    const name = fileName(job);
    const opportunityId = String(est.opportunityId || "");
    const payload = {
      event: "estimate_sent",
      opportunityId, opportunity_name: est.opportunityName || job.name || "", pipeline: est.pipeline || (opportunityId ? "jobs" : ""),
      is_change_order: est.pipeline === "change_orders",
      estimateId: record.id, version: record.version, estimate_number: pf.fields.estimate_number,
      jobAddress: pf.fields.job_address, jobName: job.name || "", customer_company: pf.fields.customer_company,
      estimator_name: pf.doc.estimator_name, estimator_email: pf.doc.estimator_email, estimator_phone: pf.doc.estimator_phone,
      total_price: pf.fields.total_price, total_cost: priced.total_cost, markup: priced.markup,
      proposal_fields: pf.fields,
      genProp: docx.toString("base64"), genPropFileName: `${name} - Proposal.docx`, genPropMimeType: DOCX,
      costData: xlsx.buffer.toString("base64"), costDataFileName: `${name} - Job Costing.xlsx`, costDataMimeType: XLSX,
      sentBy: who, sentAt: new Date().toISOString(),
    };
    const url = String(process.env.MAKE_BOT_WEBHOOK_URL || DEFAULT_WEBHOOK).trim();
    let hook;
    try {
      hook = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    } catch (e) {
      return authJson(502, { error: "Couldn't reach the Make webhook. Nothing was changed in GHL.", detail: String(e.message || e) });
    }
    if (!hook.ok) return authJson(502, { error: `The Make webhook answered ${hook.status}. Nothing was changed in GHL.` });

    let ghl = null;
    if (opportunityId) {
      try { ghl = await G.sendProposal(opportunityId, pf.fields, Number(pf.fields.total_price)); }
      catch (e) { ghl = { ok: false, error: String(e.message || e) }; }
    }
    const sent = { at: payload.sentAt, by: who, version: record.version, bid: priced.final_price, ghl: ghl && { ok: ghl.ok !== false, stage: ghl.stage || "", unresolvedFields: ghl.unresolvedFields || [], error: ghl.error || "" } };
    await store.setJSON(`estimates/${record.id}`, { ...record, sentAt: sent.at, sentBy: who, sentVersion: record.version, sends: (record.sends || []).concat([sent]).slice(-20) });
    return authJson(200, { ok: true, version: record.version, files: { proposal: payload.genPropFileName, costing: payload.costDataFileName }, ghl, sentAt: sent.at, notes: xlsx.notes });
  } catch (e) {
    return authJson(e.status || 500, { error: String(e.message || e) });
  }
}

exports.handler = protect(inner, {
  audit: (event, res) => {
    const b = parseBody(event);
    let out = {}; try { out = JSON.parse(res.body || "{}"); } catch (e) {}
    return { action: "Sent to Make", target: b.name || b.id || "", ok: resOk(res), error: out.error || (out.ghl && out.ghl.error ? "GHL: " + out.ghl.error : ""), detail: { id: b.id, version: out.version || "", ghlStage: out.ghl ? out.ghl.stage || "" : "" } };
  },
});
