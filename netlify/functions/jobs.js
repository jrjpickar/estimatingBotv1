// Jobs from GHL, like the Estimating Desk: the main pipeline's estimating stages and open change orders.
//   GET                                   -> { jobs, changeOrders, fetchedAt } (+ savedId when the bot already has an estimate for it)
//   POST { action: "start", opportunityId } -> Start Estimate: New Lead -> Proposal In Progress
//                                             (change order: Customer Requested -> CO In Progress), same rule as the Desk
"use strict";
const { protect, authJson, parseBody, resOk } = require("../lib/auth");
const G = require("../lib/ghl");
const { estimateStore } = require("../lib/estimates");

async function savedByOpp(event) {
  const out = {};
  try {
    const store = estimateStore(event);
    const { blobs } = await store.list({ prefix: "estimates/" });
    const rows = await Promise.all((blobs || []).map((b) => store.get(b.key, { type: "json" }).catch(() => null)));
    for (const r of rows) if (r && r.opportunityId && (!out[r.opportunityId] || r.updatedAt > out[r.opportunityId].updatedAt)) out[r.opportunityId] = { id: r.id, version: r.version, updatedAt: r.updatedAt, bid: r.bid, sentAt: r.sentAt || "" };
  } catch (e) { /* non-fatal */ }
  return out;
}

async function inner(event) {
  try {
    if (event.httpMethod === "GET") {
      const [list, saved] = await Promise.all([G.listEstimatingJobs(), savedByOpp(event)]);
      const tag = (j) => ({ ...j, saved: saved[j.id] || null });
      return authJson(200, { ...list, jobs: list.jobs.map(tag), changeOrders: list.changeOrders.map(tag) });
    }
    if (event.httpMethod !== "POST") return authJson(405, { error: "GET or POST only" });
    const b = parseBody(event);
    if (b.action !== "start") return authJson(400, { error: "Unknown action" });
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(String(b.opportunityId || ""))) return authJson(400, { error: "Bad opportunity id" });
    const r = await G.startEstimate(b.opportunityId);
    return authJson(200, { ok: true, ...r });
  } catch (e) {
    return authJson(e.status || 500, { error: String(e.message || e) });
  }
}
exports.handler = protect(inner, {
  audit: (event, res) => {
    if (event.httpMethod !== "POST") return null;
    const b = parseBody(event);
    let out = {}; try { out = JSON.parse(res.body || "{}"); } catch (e) {}
    return { action: "Started estimate", target: b.name || b.opportunityId || "", ok: resOk(res), error: out.error || "", detail: { opportunityId: b.opportunityId, stage: out.stage || "", moved: !!out.moved } };
  },
});
