// Saved estimates: pull up, edit and re-save the estimate behind the cost sheet and proposal.
//   GET                          -> { estimates: [summary...] }            (any signed-in user)
//   GET  ?id=<id>                -> { record, estimate }                   latest version
//   GET  ?id=<id>&v=<n>          -> { record, estimate }                   an older version
//   POST { action: "save", id?, estimate, note? }  -> { id, version, record }
//   POST { action: "delete", id }                  -> { ok }               (admins)
"use strict";
const { protect, authJson, parseBody, resOk } = require("../lib/auth");
const { estimateStore, newId, validId } = require("../lib/estimates");
const { E, getAssets } = require("../lib/engine");

const MAX_BYTES = 4 * 1024 * 1024;
const isDelete = (event) => event.httpMethod === "POST" && parseBody(event).action === "delete";

function summarize(estimate) {
  const assets = getAssets();
  const chk = E.checkEstimate(estimate, { rates: assets.rates });
  const job = estimate.job || {};
  const count = (l) => chk.issues.filter((i) => i.level === l).length;
  return {
    name: String(job.name || job.location || "Untitled estimate").slice(0, 120),
    customer: String(job.customer || "").slice(0, 120),
    location: String(job.location || "").slice(0, 160),
    estimator: String(job.estimator || "").slice(0, 60),
    estimateNumber: String(job.estimate_number || "").slice(0, 40),
    opportunityId: String(estimate.opportunityId || "").slice(0, 60),
    bid: chk.priced ? chk.priced.final_price : null,
    cost: chk.priced ? chk.priced.total_cost : null,
    fix: count("block"), questions: count("ask"), checks: count("warn"),
    draft: !chk.ok || count("ask") > 0,
  };
}

async function inner(event) {
  const store = estimateStore(event);
  const session = event.a2zSession;
  const who = { name: session.name || "", email: session.email || "", id: session.uid || "" };
  try {
    if (event.httpMethod === "GET") {
      const q = event.queryStringParameters || {};
      if (q.id) {
        if (!validId(q.id)) return authJson(400, { error: "Bad estimate id" });
        const record = await store.get(`estimates/${q.id}`, { type: "json" });
        if (!record) return authJson(404, { error: "That estimate wasn't found." });
        let estimate = record.estimate;
        if (q.v && Number(q.v) !== record.version) {
          estimate = await store.get(`versions/${q.id}/${Number(q.v)}`, { type: "json" });
          if (!estimate) return authJson(404, { error: "That version wasn't found." });
        }
        const { estimate: _, ...meta } = record;
        return authJson(200, { record: meta, estimate });
      }
      const { blobs } = await store.list({ prefix: "estimates/" });
      const rows = await Promise.all((blobs || []).map(async (b) => {
        const r = await store.get(b.key, { type: "json" }).catch(() => null);
        if (!r) return null;
        const { estimate, versions, ...meta } = r;
        return { ...meta, versionCount: (versions || []).length };
      }));
      return authJson(200, { estimates: rows.filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))) });
    }
    if (event.httpMethod !== "POST") return authJson(405, { error: "GET or POST only" });
    if ((event.body || "").length > MAX_BYTES) return authJson(413, { error: "That estimate is too big to save." });
    const body = parseBody(event);
    if (body.action === "delete") {
      if (!validId(body.id)) return authJson(400, { error: "Bad estimate id" });
      const record = await store.get(`estimates/${body.id}`, { type: "json" });
      if (!record) return authJson(404, { error: "That estimate wasn't found." });
      for (const v of record.versions || []) await store.delete(`versions/${body.id}/${v.version}`).catch(() => {});
      await store.delete(`estimates/${body.id}`);
      return authJson(200, { ok: true, id: body.id, name: record.name });
    }
    if (body.action !== "save") return authJson(400, { error: "Unknown action" });
    const estimate = body.estimate;
    if (!estimate || typeof estimate !== "object" || !Array.isArray(estimate.sections || [])) return authJson(400, { error: "Send { estimate }." });
    const id = body.id && validId(body.id) ? body.id : newId();
    const prev = await store.get(`estimates/${id}`, { type: "json" }).catch(() => null);
    const now = new Date().toISOString();
    const version = prev ? prev.version + 1 : 1;
    const clean = { ...estimate, _id: id, _version: version };
    const sum = summarize(clean);
    const versions = (prev ? prev.versions : []).concat([{ version, at: now, by: who, bid: sum.bid, draft: sum.draft, note: String(body.note || "").slice(0, 200) }]);
    const record = {
      id, version, ...sum,
      createdAt: prev ? prev.createdAt : now, createdBy: prev ? prev.createdBy : who,
      updatedAt: now, updatedBy: who, versions, estimate: clean,
    };
    await store.setJSON(`versions/${id}/${version}`, clean);
    await store.setJSON(`estimates/${id}`, record);
    const { estimate: _, ...meta } = record;
    return authJson(200, { ok: true, id, version, record: meta });
  } catch (e) {
    return authJson(e.status || 500, { error: String(e.message || e) });
  }
}

exports.handler = protect(inner, {
  admin: isDelete,
  audit: (event, res) => {
    if (event.httpMethod !== "POST") return null;
    const body = parseBody(event);
    let out = {};
    try { out = JSON.parse(res.body || "{}"); } catch (e) {}
    if (body.action === "save") return { action: "Saved estimate", target: (out.record && out.record.name) || ((body.estimate || {}).job || {}).name || "", ok: resOk(res), error: out.error || "", detail: { id: out.id || body.id || "", version: out.version || "", bid: out.record ? out.record.bid : "" } };
    if (body.action === "delete") return { action: "Deleted estimate", target: out.name || body.id, ok: resOk(res), error: out.error || "", detail: { id: body.id } };
    return null;
  },
});
