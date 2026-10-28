"use strict";
// Plan QC (code, no AI) on a synthetic 3-sheet plan set: test/fixtures/sample-plans.pdf (+ its pdftotext -layout text).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const E = require("..");
const text = fs.readFileSync(path.join(__dirname, "fixtures", "sample-plans.txt"), "utf8");
const CSV = [
  '"Takeoff Name","Takeoff Description","Sq Ft","Ln Ft","Cu Yd","EA","Marker Count","Drop Count","Takeoff Quantity","Takeoff Unit","Scale","Plan Name"',
  '"demo metal stud walls","","0","53.27","0","8","0","0","53.27","Ln Ft","","A101 - DEMO FLOOR PLAN"',
  '"cut and demo floor carpet","","1783.81","384.41","0","1","0","0","1783.81","Sq Ft","","A101 - DEMO FLOOR PLAN"',
  '"remove millwork","","66.61","60.01","0","1","0","0","66.61","Sq Ft","","A101 - DEMO FLOOR PLAN"',
  '"demo sink","","0","0","0","1","0","0","1","EA","","A101 - DEMO FLOOR PLAN"',
].join("\n");
const items = E.parseStackCsv(CSV);
const r = E.analyzePlans(E.pagesFromPdftotext(text), items);
const kinds = (k) => r.flags.filter((f) => f.kind === k);

test("finds the sheets and their types", () => {
  assert.deepStrictEqual(r.sheets.map((s) => [s.code, s.kind]), [["G0.1", "cover"], ["A1.0", "demo"], ["A2.0", "rcp"]]);
});
test("matches demo callouts to the takeoff and flags the missing ones", () => {
  const miss = kinds("missing").map((f) => f.callout);
  assert.deepStrictEqual(miss.sort(), ["DEMO (E) DOOR & FRAME", "REMOVE (E) ACT CEILING TILES", "REMOVE (E) LIGHT FIXTURES AND DIFFUSERS"]);
  assert.strictEqual(r.callouts.find((c) => /COUNTER/.test(c.text)).matched, "remove millwork");
  assert.ok(!r.callouts.some((c) => /REMAIN|KEYNOTES|FLOOR PLAN/.test(c.text)), "headings and remain notes are not callouts");
  assert.strictEqual(kinds("ceiling_missing").length, 1);
});
test("new work, by others, hazmat and conditions", () => {
  assert.match(kinds("new_work")[0].message, /MAT SLAB/);
  assert.ok(r.facts.exclusions.includes("Replace (E) x-ray equipment by others"));
  assert.strictEqual(kinds("hazmat").length, 1);
  assert.strictEqual(r.facts.job.floor_level, 2);
  assert.ok(kinds("condition").some((f) => /occupied/.test(f.message)));
});
test("ceiling facts and quantity check against the remodel area", () => {
  assert.strictEqual(r.facts.job.ceiling_height_ft, 9);
  assert.strictEqual(r.facts.ceiling.grid, "remain");
  assert.deepStrictEqual(r.facts.quantity_checks[0], { item: "Flooring", takeoff_qty: 1783.81, plan_qty: 959, unit: "SF", source: "G0.1 remodel area" });
});
test("plan flags show up in the checker and clear when answered", () => {
  const est = E.autoEstimate({ items, facts: { ...r.facts, plan_flags: r.flags }, rates: E.loadAssets().rates,
    inputs: { lines: [{ section: "Interior", category: "Labor", description: "4-man crew x 2 days", qty: 2 }] } });
  const chk = E.checkEstimate(est, { rates: E.loadAssets().rates });
  const planIssues = chk.issues.filter((i) => i.id.startsWith("plan_"));
  assert.strictEqual(planIssues.length, r.flags.length);
  assert.ok(chk.issues.some((i) => i.id === "quantity_gap"));
  est.confirmed = r.flags.map((f) => f.key);
  assert.strictEqual(E.checkEstimate(est, { rates: E.loadAssets().rates }).issues.filter((i) => i.id.startsWith("plan_")).length, 0);
});
test("a scanned set (no text) is reported, not guessed", () => {
  const s = E.analyzePlans([{ n: 1, lines: [] }, { n: 2, lines: ["A1"] }], items);
  assert.strictEqual(s.sheets.length, 0);
  assert.match(s.flags[0].message, /no readable text/);
});
