"use strict";
// GHL pipelines and opportunities, the same way the Estimating Desk does it
// (desk: netlify/functions/ghl-refresh.js + ghl-job.js). Server-side only: the
// GHL_PIT_TOKEN never reaches the browser.
//
//   listEstimatingJobs()             -> { jobs, changeOrders, fetchedAt }
//   startEstimate(opp)               -> moves New Lead / Proposal In Progress to Proposal In Progress
//                                       (change order: Customer Requested -> CO In Progress), like the Desk's Start Estimate
//   sendProposal(opp, fields, value) -> writes the proposal custom fields and moves to Generate Proposal
//                                       (change order: Generate) in one PUT, like the Desk's Build Proposal
const { fetchLocationUsers } = require("./ghl-users");

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "2021-07-28";
const DEFAULT_LOCATION_ID = "QUcu2PEAxPV1sQm1GQCq";
const DEFAULT_PIPELINE_ID = "d5Ix1SlN3YpZ5gQewZUo";
const CHANGE_ORDER_PIPELINE_ID = "Nvk3EKhRzg5omo4BLCOK";
const PROPOSAL_IN_PROGRESS_STAGE_ID = "b1279023-ac6d-4aad-97b1-eacc4afc5da7"; // desk: JOB_COST_STARTED_STAGE_ID
const GENERATE_PROPOSAL_STAGE_ID = "94e10d38-7dea-4112-86a2-f62291dedf69"; // desk: BID_STARTED_STAGE_ID
const CHANGE_ORDER_STAGE_IDS = {
  customer_requested: "c87713d6-c03f-4594-9b53-2fd9c3efbdf9",
  in_progress: "28d2193d-0e0b-4d45-88b0-74bcb66a453f",
  generate: "31fe3a7a-e4c1-4445-8774-7928906a9a2e",
  sent: "c73755a7-34fa-4df6-892a-d55c7c8811e5",
  accepted: "3753254f-eae0-4290-845c-dc85f783f9c1",
};
const PROJECT_NAME_FIELD_ID = process.env.GHL_PROJECT_NAME_FIELD_ID || "KR2KUc73WyIutiNX56DD";
// Local proposal keys match GHL's opportunity custom-field keys except job_address ("jobaddress").
const CUSTOM_FIELD_KEY_OVERRIDES = { job_address: "jobaddress" };
const UPPERCASE_FIELDS = new Set(["scope_name", "scope_name2", "scope_name3", "customer_company", "job_address"]);
// Desk stage keys (STATUS_LABEL in ghl-job.js)
const STAGE_KEYS = {
  "new lead": "new_lead", "proposal in progress": "proposal_in_progress", "generate proposal": "generate_proposal",
  "proposal sent": "proposal_sent", "in negotiation": "in_negotiation", "pending decision": "pending_decision",
};
// What the bot lists: the Desk's dashboard stages (estimating first), and open change orders.
const JOB_STAGES = ["new_lead", "proposal_in_progress", "generate_proposal", "proposal_sent", "in_negotiation", "pending_decision"];
const ESTIMATE_MOVES = ["new_lead", "proposal_in_progress"];
const CO_STAGES = { [CHANGE_ORDER_STAGE_IDS.customer_requested]: "customer_requested", [CHANGE_ORDER_STAGE_IDS.in_progress]: "in_progress", [CHANGE_ORDER_STAGE_IDS.generate]: "generate", [CHANGE_ORDER_STAGE_IDS.sent]: "sent" };
const CO_ESTIMATE_MOVES = ["customer_requested", "in_progress"];

const cfg = () => ({
  token: String(process.env.GHL_PIT_TOKEN || "").trim(),
  locationId: String(process.env.GHL_LOCATION_ID || DEFAULT_LOCATION_ID).trim(),
  pipelineId: String(process.env.GHL_PIPELINE_ID || DEFAULT_PIPELINE_ID).trim(),
});
function headers() {
  const { token } = cfg();
  if (!token) { const e = new Error("Missing GHL_PIT_TOKEN environment variable."); e.status = 500; throw e; }
  return { Authorization: `Bearer ${token}`, Version: GHL_API_VERSION, Accept: "application/json", "Content-Type": "application/json" };
}
async function ghl(path, opts = {}) {
  const res = await fetch(GHL_BASE + path, { ...opts, headers: headers() });
  const text = await res.text();
  let data = {}; try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text }; }
  if (!res.ok) { const e = new Error(`GHL ${opts.method || "GET"} ${path.split("?")[0]} failed (${res.status}): ${String(data.message || data.error || text).slice(0, 300)}`); e.status = res.status >= 500 ? 502 : res.status; throw e; }
  return data;
}

function readCustomField(opp, fieldId) {
  const f = (opp.customFields || []).find((c) => c && c.id === fieldId);
  if (!f) return "";
  const v = f.fieldValue ?? f.fieldValueString ?? f.field_value ?? f.value ?? "";
  return Array.isArray(v) ? v.join(", ") : String(v);
}

async function fetchPipelines() {
  const { locationId } = cfg();
  const data = await ghl(`/opportunities/pipelines?locationId=${encodeURIComponent(locationId)}`);
  const stageNameById = {};
  for (const p of data.pipelines || []) for (const s of p.stages || []) stageNameById[s.id] = s.name;
  return { stageNameById };
}

async function fetchPipelineOpportunities(pipelineId) {
  const { locationId } = cfg();
  const all = [], seen = new Set();
  let startAfter = "", startAfterId = "";
  for (let page = 1; page <= 25; page++) {
    const params = new URLSearchParams({ location_id: locationId, pipeline_id: pipelineId, status: "open", limit: "100" });
    if (startAfterId) { params.set("startAfterId", startAfterId); params.set("startAfter", String(startAfter)); }
    const data = await ghl(`/opportunities/search?${params}`);
    const batch = data.opportunities || [];
    for (const o of batch) if (!seen.has(o.id)) { seen.add(o.id); all.push(o); }
    const meta = data.meta || {};
    if (!batch.length || !meta.startAfterId || meta.startAfterId === startAfterId) break;
    startAfter = meta.startAfter; startAfterId = meta.startAfterId;
  }
  return all;
}

async function fieldIdByKey() {
  const { locationId } = cfg();
  const data = await ghl(`/locations/${encodeURIComponent(locationId)}/customFields?model=opportunity`);
  const out = {};
  for (const f of data.customFields || []) { const k = String(f.fieldKey || "").replace(/^opportunity\./, ""); if (k) out[k] = f.id; }
  return out;
}

async function listEstimatingJobs() {
  const { pipelineId } = cfg();
  const [{ stageNameById }, jobs, cos, users, ids] = await Promise.all([
    fetchPipelines(), fetchPipelineOpportunities(pipelineId), fetchPipelineOpportunities(CHANGE_ORDER_PIPELINE_ID),
    fetchLocationUsers().catch(() => []), fieldIdByKey().catch(() => ({})),
  ]);
  const userById = Object.fromEntries((users || []).map((u) => [u.id, u]));
  const addressFieldId = ids.jobaddress || ids.job_address || "";
  const companyFieldId = ids.customer_company || "";
  const norm = (o, isCo) => {
    const stageName = stageNameById[o.pipelineStageId] || "";
    const stageKey = isCo ? CO_STAGES[o.pipelineStageId] || "" : STAGE_KEYS[stageName.toLowerCase().trim()] || "";
    const c = o.contact || {};
    const u = userById[o.assignedTo] || {};
    return {
      id: o.id, name: o.name || "", pipeline: isCo ? "change_orders" : "jobs", stageId: o.pipelineStageId || "", stageName, stageKey,
      customer: c.companyName || (companyFieldId && readCustomField(o, companyFieldId)) || c.name || `${c.firstName || ""} ${c.lastName || ""}`.trim(),
      contactName: c.name || `${c.firstName || ""} ${c.lastName || ""}`.trim(),
      address: (addressFieldId && readCustomField(o, addressFieldId)) || c.address1 || c.address || c.fullAddress || o.address || "",
      projectName: readCustomField(o, PROJECT_NAME_FIELD_ID),
      estimator: u.name || "", estimatorEmail: u.email || "", estimatorPhone: u.phone || "", assignedTo: o.assignedTo || "",
      value: o.monetaryValue || 0, updatedAt: o.updatedAt || o.lastStageChangeAt || o.createdAt || "",
    };
  };
  return {
    jobs: jobs.map((o) => norm(o, false)).filter((j) => JOB_STAGES.includes(j.stageKey)),
    changeOrders: cos.map((o) => norm(o, true)).filter((j) => j.stageKey),
    fetchedAt: new Date().toISOString(),
  };
}

async function readOpportunity(id) {
  const d = await ghl(`/opportunities/${encodeURIComponent(id)}`);
  return d.opportunity || d;
}

async function startEstimate(opportunityId) {
  const opp = await readOpportunity(opportunityId);
  const { stageNameById } = await fetchPipelines();
  if (opp.pipelineId === CHANGE_ORDER_PIPELINE_ID) {
    const key = CO_STAGES[opp.pipelineStageId] || "";
    if (!CO_ESTIMATE_MOVES.includes(key) || key === "in_progress") return { moved: false, stage: stageNameById[opp.pipelineStageId] || key };
    await ghl(`/opportunities/${encodeURIComponent(opportunityId)}`, { method: "PUT", body: JSON.stringify({ pipelineId: CHANGE_ORDER_PIPELINE_ID, pipelineStageId: CHANGE_ORDER_STAGE_IDS.in_progress }) });
    return { moved: true, stage: stageNameById[CHANGE_ORDER_STAGE_IDS.in_progress] || "CO In Progress" };
  }
  const key = STAGE_KEYS[String(stageNameById[opp.pipelineStageId] || "").toLowerCase().trim()] || "";
  if (!ESTIMATE_MOVES.includes(key) || opp.pipelineStageId === PROPOSAL_IN_PROGRESS_STAGE_ID) return { moved: false, stage: stageNameById[opp.pipelineStageId] || key };
  await ghl(`/opportunities/${encodeURIComponent(opportunityId)}`, { method: "PUT", body: JSON.stringify({ pipelineStageId: PROPOSAL_IN_PROGRESS_STAGE_ID }) });
  return { moved: true, stage: stageNameById[PROPOSAL_IN_PROGRESS_STAGE_ID] || "Proposal In Progress" };
}

async function sendProposal(opportunityId, fields, value) {
  const opp = await readOpportunity(opportunityId);
  const isCo = opp.pipelineId === CHANGE_ORDER_PIPELINE_ID;
  const ids = await fieldIdByKey();
  const customFields = [], unresolvedFields = [];
  for (const [key, raw] of Object.entries(fields || {})) {
    const id = ids[CUSTOM_FIELD_KEY_OVERRIDES[key] || key];
    const v = UPPERCASE_FIELDS.has(key) && typeof raw === "string" ? raw.toUpperCase() : raw;
    if (id) customFields.push({ id, fieldValue: v }); else unresolvedFields.push(key);
  }
  const body = isCo
    ? { pipelineId: CHANGE_ORDER_PIPELINE_ID, pipelineStageId: CHANGE_ORDER_STAGE_IDS.generate }
    : { pipelineStageId: GENERATE_PROPOSAL_STAGE_ID };
  if (value != null && isFinite(Number(value))) body.monetaryValue = Number(value);
  if (customFields.length) body.customFields = customFields;
  await ghl(`/opportunities/${encodeURIComponent(opportunityId)}`, { method: "PUT", body: JSON.stringify(body) });
  return { ok: true, stage: isCo ? "Generate" : "Generate Proposal", isChangeOrder: isCo, unresolvedFields, opportunityName: opp.name || "" };
}

module.exports = { listEstimatingJobs, startEstimate, sendProposal, readOpportunity, CHANGE_ORDER_PIPELINE_ID, GENERATE_PROPOSAL_STAGE_ID, PROPOSAL_IN_PROGRESS_STAGE_ID, CHANGE_ORDER_STAGE_IDS };
