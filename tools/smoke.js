// Calls the three Netlify functions directly (no Netlify needed) to prove they work end to end.
"use strict";
const assert = require("assert");
const CSV = [
  '"Takeoff Name","Takeoff Description","Sq Ft","Ln Ft","Cu Yd","EA","Marker Count","Drop Count","Takeoff Quantity","Takeoff Unit","Scale","Plan Name"',
  '"demo metal stud walls","","0","53.27","0","8","0","0","53.27","Ln Ft","","A101 - DEMO FLOOR PLAN"',
  '"cut and demo floor carpet","","1783.81","384.41","0","1","0","0","1783.81","Sq Ft","","A101 - DEMO FLOOR PLAN"',
  '"remove millwork","","66.61","60.01","0","1","0","0","66.61","Sq Ft","","A101 - DEMO FLOOR PLAN"',
].join("\n");
const post = (body) => ({ httpMethod: "POST", body: JSON.stringify(body) });
(async () => {
  const auto = require("../netlify/functions/estimate-auto").handler;
  const check = require("../netlify/functions/estimate-check").handler;
  const docs = require("../netlify/functions/estimate-docs").handler;

  let r = await auto(post({ takeoffCsv: CSV, job: { name: "Smoke Test" }, inputs: { lines: [
    { section: "Interior", category: "Labor", description: "4-man crew x 2 days", qty: 2 },
    { section: "Interior", category: "Hauling", description: "3 loads", qty: 3 }] } }));
  assert.strictEqual(r.statusCode, 200, r.body);
  const a = JSON.parse(r.body);
  assert.strictEqual(a.priced.final_price, Math.round((3200 + 2550) * 2.3));
  assert.ok(a.comps.length > 0 && a.review.includes("DRAFT"));

  r = await check(post(a.estimate));
  assert.strictEqual(r.statusCode, 200);
  assert.ok(JSON.parse(r.body).issues.some((i) => i.id === "draft_inputs"));

  r = await docs(post({ estimate: a.estimate, takeoffCsv: CSV }));
  assert.strictEqual(r.statusCode, 200, r.body);
  const d = JSON.parse(r.body);
  assert.ok(d.proposalBase64.length > 1000 && d.costingBase64.length > 1000 && /Proposal\.docx$/.test(d.proposalFileName));

  r = await check({ httpMethod: "GET" });
  assert.strictEqual(r.statusCode, 405);
  console.log("smoke: estimate-auto, estimate-check, estimate-docs all OK");
})().catch((e) => { console.error(e); process.exit(1); });
