// Jobs (GHL pipeline like the Desk), Send (Make webhook + GHL writeback) and Training.
const test = require("node:test");
const assert = require("node:assert/strict");
const H = require("./helpers.cjs");
const fs = require("node:fs");
const path = require("node:path");
const PizZip = require("../estimator/engine/vendor/docx-vendor").PizZip;
const { makeFake, STAGES, USERS } = require("./fake-ghl.cjs");
const G = require("../netlify/lib/ghl");
process.env.GHL_PIT_TOKEN = "pit";
const fake = makeFake();
global.fetch = fake.fetch;

const session = H.fn("session"), jobs = H.fn("jobs"), estimates = H.fn("estimates"), send = H.fn("estimate-send"), training = H.fn("training"), data = H.fn("bot-data"), auto = H.fn("estimate-auto"), admin = H.fn("admin");
const as = (t) => ({ "x-a2z-session": t });
const CSV = fs.readFileSync(path.join(__dirname, "../tools/sample-takeoff.csv"), "utf8");
let jesse, andie;

test("sign in", async () => {
  jesse = H.body(await session(H.post({ action: "ghl", encryptedData: H.ghlContext(USERS[0]) }))).token;
  andie = H.body(await session(H.post({ action: "ghl", encryptedData: H.ghlContext(USERS[1]) }))).token;
  assert.ok(jesse && andie);
});

test("Jobs lists the Desk's estimating stages and change orders, with the job details filled", async () => {
  const r = await jobs(H.get({}, as(andie)));
  assert.equal(r.statusCode, 200);
  const b = H.body(r);
  assert.deepEqual(b.jobs.map((j) => j.id), ["oppNEW000001", "oppPIP000002"], "awarded jobs are left off");
  const j = b.jobs[0];
  assert.equal(j.stageKey, "new_lead"); assert.equal(j.customer, "Sample Builders Inc."); assert.equal(j.address, "100 Example Ave, Irvine, CA");
  assert.equal(j.estimator, "Jesse Pickar"); assert.equal(j.projectName, "Suite 210 TI");
  assert.equal(b.jobs[1].address, "2200 Sample Blvd, Costa Mesa, CA", "jobaddress custom field wins");
  assert.equal(b.changeOrders[0].stageKey, "customer_requested");
});

test("opening a job moves New Lead to Proposal In Progress (once), change orders to CO In Progress", async () => {
  let r = await jobs(H.post({ action: "start", opportunityId: "oppNEW000001" }, as(andie)));
  assert.equal(H.body(r).moved, true); assert.equal(fake.opps[0].pipelineStageId, STAGES.proposal_in_progress);
  r = await jobs(H.post({ action: "start", opportunityId: "oppNEW000001" }, as(andie)));
  assert.equal(H.body(r).moved, false);
  r = await jobs(H.post({ action: "start", opportunityId: "oppCO0000004" }, as(andie)));
  assert.equal(H.body(r).moved, true); assert.equal(fake.opps[3].pipelineStageId, G.CHANGE_ORDER_STAGE_IDS.in_progress);
});

let estId;
test("Send is locked while questions are open", async () => {
  const a = H.body(await auto(H.post({ takeoffCsv: CSV, job: { name: "Office TI Demo, Suite 210", location: "100 Example Ave, Irvine, CA", customer: "Sample Builders Inc.", estimator: "Jesse Pickar" } }, as(andie))));
  const est = { ...a.estimate, opportunityId: "oppNEW000001", pipeline: "jobs", opportunityName: "Office TI Demo, Suite 210" };
  const s = H.body(await estimates(H.post({ action: "save", estimate: est }, as(andie))));
  estId = s.id;
  const r = await send(H.post({ id: estId }, as(andie)));
  assert.equal(r.statusCode, 409); assert.ok(H.body(r).issues.length > 0);
  assert.equal(fake.hooks.length, 0);
});

test("Send posts costData + genProp + jobAddress to Make, then writes GHL like Build Proposal", async () => {
  const rec = H.body(await estimates(H.get({ id: estId }, as(andie))));
  const est = rec.estimate;
  const chk = require("../estimator/engine").checkEstimate(est, { rates: require("../netlify/lib/engine").getAssets().rates });
  est.confirmed = [...new Set([...(est.confirmed || []), ...chk.issues.filter((i) => i.level !== "block").map((i) => i.id)])];
  est.job.estimate_number = "102926JP";
  const s = H.body(await estimates(H.post({ action: "save", id: estId, estimate: est }, as(andie))));
  assert.equal(s.version, 2);
  const r = await send(H.post({ id: estId, takeoffCsv: CSV }, as(andie)));
  assert.equal(r.statusCode, 200, r.body);
  const out = H.body(r);
  assert.equal(fake.hooks.length, 1);
  const p = fake.hooks[0].body;
  assert.equal(fake.hooks[0].url, "https://hook.us2.make.com/srx3k2i5fbmy9y68ls9gkoa9h1jji7tt");
  assert.equal(p.opportunityId, "oppNEW000001");
  assert.equal(p.jobAddress, "100 EXAMPLE AVE, IRVINE, CA");
  assert.equal(p.estimate_number, "102926JP");
  const docx = new PizZip(Buffer.from(p.genProp, "base64")), xlsx = new PizZip(Buffer.from(p.costData, "base64"));
  assert.match(docx.file("word/header1.xml").asText(), /102926JP/);
  assert.ok(xlsx.file("xl/worksheets/sheet1.xml"));
  assert.match(p.genPropFileName, /Proposal\.docx$/); assert.doesNotMatch(p.genPropFileName, /DRAFT/);
  assert.equal(p.proposal_fields.total_price, String(Math.round(out.ghl ? Number(p.total_price) : 0)));
  // GHL: one PUT with the fields + Generate Proposal
  const put = fake.puts[fake.puts.length - 1];
  assert.equal(put.id, "oppNEW000001"); assert.equal(put.body.pipelineStageId, G.GENERATE_PROPOSAL_STAGE_ID);
  const byId = Object.fromEntries(put.body.customFields.map((c) => [c.id, c.fieldValue]));
  assert.equal(byId.cf14, "100 EXAMPLE AVE, IRVINE, CA", "job_address goes to the jobaddress field");
  assert.equal(byId.cf1, "SAMPLE BUILDERS INC.");
  assert.deepEqual(out.ghl.unresolvedFields, []);
  const list = H.body(await estimates(H.get({}, as(andie))));
  assert.ok(list.estimates[0].sentAt, "saved estimate shows it was sent");
});

test("a failed webhook changes nothing in GHL", async () => {
  fake.hookStatus = 500; const puts = fake.puts.length;
  const r = await send(H.post({ id: estId }, as(andie)));
  assert.equal(r.statusCode, 502); assert.equal(fake.puts.length, puts);
  fake.hookStatus = 200;
});

test("Training: admins upload proposals + cost sheets; the model reaches the page and autopilot", async () => {
  const E = require("../estimator/engine"), A = require("../netlify/lib/engine").getAssets();
  const est = { job: { name: "x", location: "1 Main St", customer: "ACME", estimator: "Jesse Pickar", estimate_number: "1" }, markup: 1.3,
    sections: [{ name: "Interior", lines: [{ category: "Labor", description: "4 workers x 2 days", qty: 8, rate: 400 }, { category: "Misc", description: "Dump fees", qty: 1, rate: 300 }] }],
    scopes: [{ name: "Interior Demolition", lines: ["Properly remove and dispose of carpet and rubber base (approx. 900 SF)"] }] };
  const p = E.computeEstimate(est);
  const docx = E.fillProposal(A.proposalTemplate, E.proposalFields(p, A.style).doc).toString("base64");
  const xlsx = E.fillJobCosting(A.costingTemplate, p, null).buffer.toString("base64");
  let r = await training(H.post({ action: "add", name: "a.docx", base64: docx }, as(andie)));
  assert.equal(r.statusCode, 403, "estimators can't train");
  r = await training(H.post({ action: "add", name: "a.docx", base64: docx }, as(jesse))); assert.equal(r.statusCode, 200, r.body);
  r = await training(H.post({ action: "add", name: "b.pdf", lines: ["Scope of Work", "to do the following:", "INTERIOR DEMOLITION", "• Properly remove and dispose of carpet and rubber base (approx. 500 SF)", "$4,000.00", "NOTES:", "Total: $4,000.00"] }, as(jesse)));
  assert.equal(r.statusCode, 200);
  r = await training(H.post({ action: "add", name: "c.xlsx", base64: xlsx }, as(jesse))); assert.equal(H.body(r).record.kind, "costsheet");
  r = await training(H.post({ action: "add", name: "d.txt", base64: "eA==" }, as(jesse))); assert.equal(r.statusCode, 400);
  r = await training(H.post({ action: "rebuild" }, as(jesse)));
  assert.deepEqual(H.body(r).model.counts, { proposals: 2, costsheets: 1 });
  r = await training(H.get({}, as(andie)));
  assert.equal(H.body(r).records.length, 3);
  const d = H.body(await data(H.get({}, as(andie))));
  assert.equal(d.learned.counts.proposals, 2);
  const a = H.body(await auto(H.post({ takeoffCsv: CSV }, as(andie))));
  assert.ok(a.estimate.learned, "autopilot used the learned model");
  const del = H.body(await training(H.get({}, as(jesse)))).records[0].id;
  r = await training(H.post({ action: "delete", id: del }, as(jesse)));
  assert.equal(H.body(r).model.counts.proposals + H.body(r).model.counts.costsheets, 2);
});

test("Admin health shows the pipeline, webhook and training", async () => {
  const hr = await admin(H.get({ view: "health" }, as(jesse))); const h = H.body(hr); assert.equal(hr.statusCode, 200, hr.body);
  const by = Object.fromEntries(h.checks.map((c) => [c.key || c.id, c]));
  const keys = h.checks.map((c) => c.key || c.id);
  assert.ok(keys.includes("pipeline") && keys.includes("webhook") && keys.includes("training"), keys.join(","));
  assert.equal(by.pipeline.status, "ok"); assert.equal(by.training.status, "ok");
});
