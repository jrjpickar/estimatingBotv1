"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../index.js");
const L = require("../lib/learn");
const LF = require("../lib/learnFiles");

const assets = E.loadAssets();
const job = { name: "Office TI", location: "100 Example Ave, Irvine, CA", customer: "Sample Builders Inc.", estimator: "Jesse Pickar", estimate_number: "102926JP", date: "2026-10-29" };
function proposalDocx(scopes, extra) {
  const est = { job, sections: [{ name: "Interior", lines: [{ category: "Labor", description: "4 workers x 2 days", qty: 8, rate: 400 }] }], markup: 1.3, scopes, extra_exclusions: extra };
  const p = E.computeEstimate(est);
  return E.fillProposal(assets.proposalTemplate, E.proposalFields(p, assets.style).doc);
}

test("reads a proposal made from A2Z's template", () => {
  const buf = proposalDocx([
    { name: "Demolition", lines: ["Properly remove and dispose of carpet and rubber base (approx. 1,784 SF, per plans A101)", "Properly remove ACT ceiling tiles, leave grid in place"], price: 5000 },
    { name: "Grading/Excavation", lines: ["Rough grade building pad (approx. 2,800 SF)"], price: 2360 }], ["Fire sprinkler work by others"]);
  const r = LF.proposalFromDocx(buf, { file: "a.docx" });
  assert.equal(r.estimate_number, "102926JP");
  assert.equal(r.customer, "SAMPLE BUILDERS INC.");
  assert.equal(r.job_address, "100 EXAMPLE AVE, IRVINE, CA");
  assert.deepEqual(r.scopes.map((s) => [s.name, s.bullets.length, s.total]), [["DEMOLITION", 2, 5000], ["GRADING/EXCAVATION", 1, 2360]]);
  assert.equal(r.total, 7360);
  assert.equal(r.exclusions_extra, "Fire sprinkler work by others.");
});

test("reads PDF-style text with wrapped bullets and right-aligned totals", () => {
  const r = L.proposalFromLines(["ESTIMATE #: 0101JP", "CUSTOMER:", "ACME", "JOB LOCATION:", "1 MAIN ST", "Scope of Work",
    "A2Z Construction Services will provide the necessary labor, equipment, materials, and trucking to do the following:",
    "INTERIOR DEMOLITION", "• Properly remove and dispose of carpet and rubber base", "throughout the suite (approx. 900 SF)", "• Properly remove drywall ceiling", "$12,500.00",
    "NOTES:", "• something", "Total: $12,500.00"]);
  assert.equal(r.scopes.length, 1);
  assert.equal(r.scopes[0].bullets[0], "Properly remove and dispose of carpet and rubber base throughout the suite (approx. 900 SF)");
  assert.equal(r.scopes[0].total, 12500);
  assert.equal(r.total, 12500);
});

test("reads a job costing worksheet by its labels", () => {
  const p = E.computeEstimate({ job, markup: 1.3, sections: [{ name: "Interior", lines: [
    { category: "Labor", description: "4 workers x 2 days", qty: 8, rate: 400 },
    { category: "Equipment", description: "Scissor Lift 19' Electric", qty: 2, rate: 575 },
    { category: "Misc", description: "Dump fees", qty: 1, rate: 300 }] }], scopes: [{ name: "Demolition", lines: ["x"] }] });
  const r = LF.costSheetFromXlsx(E.fillJobCosting(assets.costingTemplate, p, null).buffer);
  assert.equal(r.job_name, "Office TI");
  assert.deepEqual(r.lines.map((l) => [l.category, l.description, l.qty, l.rate]), [["Labor", "4 workers x 2 days", 8, 400], ["Equipment", "Scissor Lift 19' Electric", 2, 575], ["Misc", "Dump fees", 1, 300]]);
  assert.equal(r.total_cost, 4650);
  assert.equal(r.markup, 1.3);
});

test("learns wording, scope names and line items, then applies them", () => {
  const props = [1, 2, 3].map((n) => L.proposalFromLines(["Scope of Work", "to do the following:", "INTERIOR DEMOLITION",
    `• Properly remove and dispose of carpet and rubber base (approx. ${n}00 SF)`, "• Properly remove ACT ceiling tiles, leave grid in place", `$${n},000.00`, "NOTES:", `Total: $${n},000.00`]));
  const sheets = [1, 2, 3].map((n) => ({ kind: "costsheet", lines: [
    { section: "Interior", category: "Equipment", description: "Scissor lift 19' (delivery + pickup)", qty: 1, rate: 600 + n },
    { section: "Interior", category: "Misc", description: "Dump fees", qty: 1, rate: 300 }] }));
  const model = L.learnModel([...props, ...sheets]);
  assert.equal(model.counts.proposals, 3);
  assert.equal(model.counts.costsheets, 3);
  assert.equal(model.scopeNames[0].name, "INTERIOR DEMOLITION");
  assert.equal(model.jobs.length, 3);

  const est = { scopes: [{ name: "Demolition", lines: ["Properly remove carpet base (approx. 1,784 SF, per plans A101)", "Properly remove stucco (approx. 50 SF)"] }],
    sections: [{ name: "Interior", lines: [{ category: "Equipment", description: "Scissor Lift 19' Electric", qty: 1, rate: 1200 }] }] };
  const { changed, flags } = L.applyLearned(est, model);
  assert.equal(est.scopes[0].name, "INTERIOR DEMOLITION");
  assert.equal(est.scopes[0].lines[0], "Properly remove and dispose of carpet and rubber base (approx. 1,784 SF, per plans A101)");
  assert.equal(est.scopes[0].lines[1], "Properly remove stucco (approx. 50 SF)"); // nothing learned for stucco
  assert.ok(changed.length >= 2);
  assert.ok(flags.some((f) => /Dump fees/.test(f.message)), "common item flagged");
  const C = require("../lib/common");
  const items = [{ item: "Remove carpet", qty: 900, unit: C.normUnit("SF"), group: C.groupFor("Remove carpet") }];
  const comps = E.findComps(items, { jobs: L.learnedJobs(model) });
  assert.ok(comps.comps.length > 0);
});
