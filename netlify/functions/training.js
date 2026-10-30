// Training: upload past proposals and job costing sheets in bulk; the bot learns A2Z's
// scope wording, scope names and cost line items from them (code, no AI: estimator/engine/lib/learn.js).
//   GET                                   -> { counts, model summary, records }          (any signed-in user)
//   POST { action: "add", name, base64 }  -> parse a .docx proposal or a .xlsx / .csv cost sheet (any layout)   (admins)
//   POST { action: "add", name, lines }   -> parse a PDF proposal (text lines read in the browser with pdf.js)
//   POST { action: "rebuild" }            -> rebuild the model from every record (send once after a batch)
//   POST { action: "delete", id }         -> remove one record and rebuild
"use strict";
const { protect, authJson, parseBody, resOk } = require("../lib/auth");
const { E } = require("../lib/engine");
const T = require("../lib/training");

const MAX_BYTES = 5.5 * 1024 * 1024;
function describe(r) {
  if (r.kind === "proposal") return `${r.scopes.length} scope${r.scopes.length === 1 ? "" : "s"}, ${r.scopes.reduce((t, s) => t + s.bullets.length, 0)} lines${r.total ? `, $${Math.round(r.total).toLocaleString("en-US")}` : ""}`;
  return `${r.lines.length} cost line${r.lines.length === 1 ? "" : "s"}${r.total_cost ? `, cost $${Math.round(r.total_cost).toLocaleString("en-US")}` : ""}`;
}
const summary = (r) => ({ id: r.id, kind: r.kind, file: r.file, at: r.at, by: r.by, what: describe(r), layout: r.layout || "",
  lines: r.kind === "costsheet" ? (r.lines || []).slice(0, 40).map((l) => ({ section: l.section, category: l.category, description: l.description, qty: l.qty, rate: l.rate })) : undefined,
  job: r.kind === "proposal" ? (r.job_address || r.customer || r.estimate_number || "") : (r.job_name || ""), warnings: r.warnings || [] });
function modelSummary(m) {
  if (!m) return null;
  return { updated: m.updated, counts: m.counts, phrases: (m.phrases || []).slice(0, 60).map((p) => ({ text: p.core, count: p.count, unit: p.unit })),
    scopeNames: (m.scopeNames || []).slice(0, 20), exclusions: (m.exclusions || []).slice(0, 20),
    lineItems: (m.lineItems || []).slice(0, 60).map((i) => ({ category: i.category, description: i.description, count: i.count, sheets: i.sheets, rate: i.rateMedian })),
    jobs: (m.jobs || []).length };
}

async function inner(event) {
  const store = T.trainingStore(event);
  const s = event.a2zSession;
  const who = { name: s.name || "", email: s.email || "" };
  try {
    if (event.httpMethod === "GET") {
      const [records, model] = await Promise.all([T.listRecords(store), store.get("model", { type: "json" }).catch(() => null)]);
      return authJson(200, { model: modelSummary(model), records: records.map(summary).sort((a, b) => String(b.at).localeCompare(String(a.at))) });
    }
    if (event.httpMethod !== "POST") return authJson(405, { error: "GET or POST only" });
    if ((event.body || "").length > MAX_BYTES) return authJson(413, { error: "That file is too big (over about 4 MB). Save it smaller or as .docx." });
    const body = parseBody(event);
    if (body.action === "rebuild") { const { model } = await T.rebuildModel(store); return authJson(200, { ok: true, model: modelSummary(model) }); }
    if (body.action === "delete") {
      if (!T.validRecordId(body.id)) return authJson(400, { error: "Bad record id" });
      await store.delete(`records/${body.id}`);
      const { model } = await T.rebuildModel(store);
      return authJson(200, { ok: true, model: modelSummary(model) });
    }
    if (body.action !== "add") return authJson(400, { error: "Unknown action" });
    const name = String(body.name || "file").slice(0, 160), ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1] || "";
    const meta = { file: name };
    let rec;
    if (Array.isArray(body.lines)) rec = E.proposalFromLines(body.lines.map(String).slice(0, 5000), meta);
    else if (/^docx$/i.test(ext)) rec = E.proposalFromDocx(Buffer.from(String(body.base64 || ""), "base64"), meta);
    else if (/^xlsx$/i.test(ext)) rec = E.costSheetFromXlsx(Buffer.from(String(body.base64 || ""), "base64"), meta);
    else if (/^csv$/i.test(ext)) {
      const text = Buffer.from(String(body.base64 || ""), "base64").toString("utf8");
      let stack = []; try { stack = E.parseStackCsv(text); } catch (e) { stack = []; }
      if (stack.length) return authJson(400, { error: `${name}: that's a STACK takeoff, not a cost sheet. Takeoffs go on the Estimate page.` });
      rec = E.costSheetFromCsv(text, meta);
    }
    else if (/^xls$/i.test(ext)) return authJson(400, { error: `${name}: old .xls files can't be read. Open it and save it as .xlsx.` });
    else return authJson(400, { error: `${name}: use .pdf or .docx proposals and .xlsx or .csv cost sheets.` });
    const warnings = [];
    if (rec.kind === "proposal") {
      if (!rec.scopes.length) warnings.push("No scope lines found. Is this an A2Z proposal?");
      else if (!rec.total) warnings.push("No total found; it won't count as a comp.");
      if (body.lines && body.lines.length < 5) warnings.push("Almost no text (scanned PDF?).");
    } else if (!rec.lines.length) warnings.push("No cost lines found.");
    else if (rec.layout === "other") warnings.push(`Older layout${rec.sheet && rec.sheet !== "csv" ? ` (sheet "${rec.sheet}")` : ""}: read by column headers and wording. Check the lines in the list below.`);
    const id = T.newRecordId();
    const record = { ...rec, id, at: new Date().toISOString(), by: who, warnings };
    if (rec.kind === "proposal" && !rec.scopes.length) return authJson(422, { error: `${name}: no scope lines found. Is this an A2Z proposal?`, record: summary(record) });
    await store.setJSON(`records/${id}`, record);
    if (body.rebuild) await T.rebuildModel(store);
    return authJson(200, { ok: true, record: summary(record) });
  } catch (e) {
    return authJson(e.status || 400, { error: `${String((parseBody(event) || {}).name || "")}: ${String(e.message || e)}`.replace(/^: /, "") });
  }
}

const isWrite = (event) => event.httpMethod === "POST";
exports.handler = protect(inner, {
  admin: isWrite,
  audit: (event, res) => {
    if (event.httpMethod !== "POST") return null;
    const b = parseBody(event);
    if (b.action === "add") return null; // one entry per batch (rebuild), not per file
    let out = {}; try { out = JSON.parse(res.body || "{}"); } catch (e) {}
    const c = (out.model && out.model.counts) || {};
    return { action: b.action === "delete" ? "Removed training file" : "Trained the bot", target: `${c.proposals || 0} proposals, ${c.costsheets || 0} cost sheets`, ok: resOk(res), error: out.error || "", detail: { id: b.id || "" } };
  },
});
