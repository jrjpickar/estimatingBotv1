"use strict";
// Autopilot: takeoff (+ plan text) -> complete draft with no person and no AI in the loop.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const E = require("..");
const A = E.loadAssets();
const { groupFor } = require("../lib/common");
const it = (item, qty, unit, plan = "A101 - DEMO PLAN") => ({ item, qty, unit, plan, group: groupFor(item) });
const run = (items, pages, job = {}) => E.autopilot({ items, pages, library: A.library, rates: A.rates, defaults: A.defaults, production: A.production, job });

test("600 PCH takeoff: lands near the real crew-days and loads", () => {
  const items = [it("demo metal stud walls", 53.27, "LF"), it("cut and demo floor carpet", 1783.81, "SF"), it("remove millwork", 66.61, "SF"), it("demo sink", 1, "EA")];
  const { estimate } = run(items, null);
  const L = estimate.sections[0].lines;
  assert.strictEqual(L.find((l) => l.category === "Labor").qty, 8);          // real job: 4 guys x 2 days
  assert.strictEqual(L.find((l) => l.category === "Hauling").qty, 3);        // real job: 3 trucks
  assert.ok(L.some((l) => /Ride On Scraper/.test(l.description) && l.rate === 575)); // real job: floor scraper
  assert.ok(L.every((l) => l.draft && l.basis && l.rate > 0));
  const chk = E.checkEstimate(estimate, { rates: A.rates });
  assert.strictEqual(chk.ok, true);
  assert.strictEqual(chk.priced.final_price, Math.round((3200 + 2550 + 575) * 2.3));
  assert.ok(chk.issues.some((i) => i.id === "auto_no_plans") && chk.issues.some((i) => i.id === "draft_inputs"));
});

test("with plans: missing callouts added to scope, exclusions, lift sized from ceiling height, carry-down", () => {
  const pages = E.pagesFromPdftotext(fs.readFileSync(path.join(__dirname, "fixtures", "sample-plans.txt"), "utf8"));
  const items = [it("demo metal stud walls", 53.27, "LF"), it("cut and demo floor carpet", 1783.81, "SF"), it("remove millwork", 66.61, "SF"), it("demo sink", 1, "EA")];
  const { estimate, planCheck } = run(items, pages);
  assert.strictEqual(planCheck.stats.readable, 3);
  const scope = estimate.scopes[0].lines.join("\n");
  assert.match(scope, /door & frame \(per plans A1\.0\)/);
  assert.match(scope, /ACT ceiling tiles \(per plans A2\.0\)/);
  assert.ok(estimate.extra_exclusions.some((x) => /x-ray/i.test(x)));
  const L = estimate.sections[0].lines;
  const labor = L.filter((l) => l.category === "Labor");
  assert.strictEqual(labor.length, 1, "one labor line per section (the job costing sheet has one Labor row)");
  assert.match(labor[0].description, /\+15% upper floor carry-down, \+10% occupied building/);
  assert.strictEqual(labor[0].qty, 12); // 7.7 wd x 1.25 = 9.6 -> 3 crew-days
  const chk = E.checkEstimate(estimate, { rates: A.rates });
  assert.strictEqual(chk.ok, true);
  assert.ok(chk.issues.some((i) => /Added to scope from the plans/.test(i.message)));
  const docs = E.buildDocuments(chk.priced, null, A);
  assert.ok(docs.proposal.length > 1000);
});

test("ceiling job: lift by height plus delivery and pickup", () => {
  const items = [it("Remove ACT ceiling tile", 1079, "SF", "A201 - RCP"), it("remove carpet tile", 1079, "SF")];
  const L = run(items, [{ n: 1, lines: ["REFLECTED CEILING PLAN", "CLG HT 14'-0\" A.F.F.", "A2.0"] }]).estimate.sections[0].lines;
  assert.ok(L.some((l) => l.description === "Scissor Lift 19 ft Electric" && l.rate === 120));
  assert.ok(L.some((l) => l.description === "Lift delivery and pickup" && l.qty === 2 && l.rate === 150));
});

test("exterior and grading get their own sections, machines, fuel and a grading question", () => {
  const items = [it("house demo", 1900, "SF", "C1 - SITE"), it("remove hardscape", 4840, "SF", "C1 - SITE"), it("over-ex and recompact pad", 2400, "SF", "C2 - GRADING")];
  const { estimate } = run(items, null);
  assert.deepStrictEqual(estimate.sections.map((s) => s.name), ["Exterior", "Grading"]);
  const ext = estimate.sections[0].lines;
  assert.ok(ext.some((l) => l.description === "20k Excavator" && l.rate === 450));
  assert.ok(ext.some((l) => l.category === "Fuel" && l.rate === 75));
  assert.deepStrictEqual(estimate.scopes.map((s) => s.name), ["Demolition", "GRADING/EXCAVATION"]);
  const chk = E.checkEstimate(estimate, { rates: A.rates });
  assert.strictEqual(chk.ok, true, JSON.stringify(chk.issues.filter((i) => i.level === "block")));
  assert.ok(chk.issues.some((i) => i.id === "auto_grading"));
});
