// A fake GHL API + Make webhook for tests and tools/dev-server.cjs (never deployed).
const G = require("../netlify/lib/ghl");
const STAGES = {
  new_lead: "s-new-lead", proposal_in_progress: G.PROPOSAL_IN_PROGRESS_STAGE_ID, generate_proposal: G.GENERATE_PROPOSAL_STAGE_ID,
  proposal_sent: "s-sent", awarded: "s-awarded",
};
const PIPELINES = [
  { id: "d5Ix1SlN3YpZ5gQewZUo", name: "Jobs", stages: [
    { id: STAGES.new_lead, name: "New Lead" }, { id: STAGES.proposal_in_progress, name: "Proposal In Progress" },
    { id: STAGES.generate_proposal, name: "Generate Proposal" }, { id: STAGES.proposal_sent, name: "Proposal Sent" }, { id: STAGES.awarded, name: "Job Awarded" }] },
  { id: G.CHANGE_ORDER_PIPELINE_ID, name: "Change Orders", stages: [
    { id: G.CHANGE_ORDER_STAGE_IDS.customer_requested, name: "Customer Requested" }, { id: G.CHANGE_ORDER_STAGE_IDS.in_progress, name: "CO In Progress" },
    { id: G.CHANGE_ORDER_STAGE_IDS.generate, name: "Generate" }, { id: G.CHANGE_ORDER_STAGE_IDS.sent, name: "Sent" }] },
];
const FIELDS = ["proposal_date", "customer_company", "scope_name", "scope_name2", "scope_name3", "scope_bullets1", "scope_bullets2", "scope_bullets3",
  "total_price", "estimate_number", "exclusions", "scope_total1", "scope_total2", "scope_total3", "jobaddress"].map((k, i) => ({ id: "cf" + i, fieldKey: "opportunity." + k }));
const USERS = [
  { id: "neeX5r7tAWikhEMzrFEC", name: "Jesse Pickar", email: "jesse@a2zcs.net", phone: "(949) 522-7441" },
  { id: "IVFHrDqUqc7tkWwtmiXc", name: "Andie LaRue", email: "andie@a2zcs.net" },
  { id: "OUTSIDER000000000001", name: "Not Listed", email: "nobody@a2zcs.net" },
];
function freshOpps() {
  return [
    { id: "oppNEW000001", name: "Office TI Demo, Suite 210", pipelineId: PIPELINES[0].id, pipelineStageId: STAGES.new_lead, assignedTo: USERS[0].id, monetaryValue: 0,
      contact: { name: "Pat Sample", companyName: "Sample Builders Inc.", address1: "100 Example Ave, Irvine, CA" }, customFields: [{ id: "KR2KUc73WyIutiNX56DD", fieldValue: "Suite 210 TI" }] },
    { id: "oppPIP000002", name: "Retail Ceiling Tile Removal", pipelineId: PIPELINES[0].id, pipelineStageId: STAGES.proposal_in_progress, assignedTo: USERS[1].id,
      contact: { name: "Harbor Retail Group" }, customFields: [{ id: "cf14", fieldValue: "2200 Sample Blvd, Costa Mesa, CA" }] },
    { id: "oppWON000003", name: "Awarded job (hidden)", pipelineId: PIPELINES[0].id, pipelineStageId: STAGES.awarded, contact: {} },
    { id: "oppCO0000004", name: "CO #1 - Extra demo", pipelineId: G.CHANGE_ORDER_PIPELINE_ID, pipelineStageId: G.CHANGE_ORDER_STAGE_IDS.customer_requested, contact: { companyName: "Westside Property Co." } },
  ];
}
function makeFake() {
  const state = { opps: freshOpps(), puts: [], hooks: [], hookStatus: 200 };
  const res = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
  state.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    if (u.hostname === "hook.us2.make.com") { state.hooks.push({ url: String(url), body: JSON.parse(opts.body || "{}") }); return res(state.hookStatus, { accepted: true }); }
    if (u.hostname !== "services.leadconnectorhq.com") throw new Error("unexpected fetch " + url);
    const p = u.pathname, method = opts.method || "GET";
    if (p === "/users/") return res(200, { users: USERS });
    if (p === "/opportunities/pipelines") return res(200, { pipelines: PIPELINES });
    if (p === "/opportunities/search") return res(200, { opportunities: state.opps.filter((o) => o.pipelineId === u.searchParams.get("pipeline_id")), meta: {} });
    if (/^\/locations\/[^/]+\/customFields$/.test(p)) return res(200, { customFields: FIELDS });
    const m = p.match(/^\/opportunities\/([^/]+)$/);
    if (m) {
      const o = state.opps.find((x) => x.id === decodeURIComponent(m[1]));
      if (!o) return res(404, { message: "not found" });
      if (method === "GET") return res(200, { opportunity: o });
      if (method === "PUT") {
        const b = JSON.parse(opts.body || "{}");
        state.puts.push({ id: o.id, body: b });
        if (b.pipelineStageId) o.pipelineStageId = b.pipelineStageId;
        if (b.pipelineId) o.pipelineId = b.pipelineId;
        if (b.customFields) o.customFields = b.customFields.concat((o.customFields || []).filter((c) => !b.customFields.some((n) => n.id === c.id)));
        return res(200, { opportunity: o });
      }
    }
    return res(404, { message: "no route " + p });
  };
  return state;
}
module.exports = { makeFake, STAGES, USERS };
