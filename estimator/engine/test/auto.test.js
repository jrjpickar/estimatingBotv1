"use strict";
// Auto mode: STACK items + plan facts + draft inputs -> priced draft that passes the math checks.
const test = require("node:test");
const assert = require("node:assert");
const E = require("..");
const A = require("../lib/auto");
const assets = E.loadAssets();
const item = (item, qty, unit, plan = "A101 - DEMO PLAN") => ({ item, qty, unit, plan, group: require("../lib/common").groupFor(item) });

test("interior: work order, grid stays, device counts, default 130% markup", () => {
  const items = [item("Remove ACT ceiling tile", 1079, "SF", "A201 - RCP"), item("demo walls", 80, "LF"), item("remove carpet tile", 1079, "SF"), item("remove cabinet", 1, "EA"), item("dumpster", 1, "EA")];
  const est = A.autoEstimate({ items, rates: assets.rates,
    facts: { job: { access: "single man door", ceiling_height_ft: 10 }, ceiling: { grid: "remain", devices: { lights: 12, diffusers: 4 } } },
    inputs: { lines: [
      { section: "Interior", category: "Labor", description: "5 workers x 2 days", qty: 10 },
      { section: "Interior", category: "Hauling", description: "1 load", qty: 1 },
      { section: "Interior", category: "Equipment", description: "Scissor Lift 15 ft Electric", qty: 1 },
      { section: "Interior", category: "Equipment", description: "Lift delivery and pickup", qty: 2, rate: 150 }] } });
  const lines = est.scopes[0].lines;
  assert.match(lines[0], /cabinet/); assert.match(lines[1], /carpet/); assert.match(lines[2], /demolish walls/); assert.match(lines[3], /ceiling tile.*grid in place/);
  assert.match(lines[4], /\(12\) lights, \(4\) diffusers/);
  assert.ok(!lines.some((l) => /dumpster/.test(l)), "hauling items are cost lines, not scope");
  assert.strictEqual(est.markup, 1.3);
  const lift = est.sections[0].lines.find((l) => /Scissor/.test(l.description));
  assert.strictEqual(lift.rate, 115);
  assert.strictEqual(est.sections[0].lines[0].rate, 400);
  assert.strictEqual(est.sections[0].lines[1].rate, 850);
  const chk = E.checkEstimate(est, { rates: assets.rates });
  assert.strictEqual(chk.ok, true);
  assert.strictEqual(chk.priced.final_price, Math.round((4000 + 850 + 115 + 300) * 2.3));
  assert.ok(chk.issues.some((i) => i.id === "draft_inputs"));
  assert.ok(!chk.issues.some((i) => ["work_order", "ceiling_grid", "access", "ceiling_height"].includes(i.id)));
});

test("demo + grading: separate scopes whose prices add up exactly", () => {
  const items = [item("house demo", 1900, "SF", "C1 - SITE"), item("remove hardscape", 4000, "SF", "C1 - SITE"), item("over-ex and recompact pad", 2400, "SF", "C2 - GRADING")];
  const est = A.autoEstimate({ items, rates: assets.rates, facts: { recompaction_required: true, excavation: { footprint_sf: 2400, depth_ft: 3, volume_cy: 267, loads: 20 } },
    inputs: { lines: [
      { section: "Exterior", category: "Labor", description: "4 workers x 7 days", qty: 28 },
      { section: "Exterior", category: "Hauling", description: "14 loads", qty: 14 },
      { section: "Grading", category: "Labor", description: "4 workers x 3 days", qty: 12 },
      { section: "Grading", category: "Hauling", description: "Sub haul, 20 loads", qty: 20, rate: 500 }] } });
  assert.deepStrictEqual(est.scopes.map((s) => s.name), ["Demolition", "GRADING/EXCAVATION"]);
  assert.match(est.scopes[1].lines.join("\n"), /12" lifts/);
  const chk = E.checkEstimate(est, { rates: assets.rates });
  assert.strictEqual(chk.ok, true, JSON.stringify(chk.issues));
  assert.strictEqual(est.scopes[0].price, Math.round((11200 + 11900) * 2.3));
  assert.strictEqual(est.scopes[1].price, Math.round((4800 + 10000) * 2.3));
  assert.strictEqual(chk.priced.final_price, est.scopes[0].price + est.scopes[1].price);
});

test("markup override and documents build from an auto draft", () => {
  const items = [item("demo metal stud walls", 53.27, "LF"), item("cut and demo floor carpet", 1783.81, "SF")];
  const est = A.autoEstimate({ items, rates: assets.rates, markup: 2.5, job: { name: "600 PCH", estimator: "Jesse Pickar" },
    inputs: { lines: [{ section: "Interior", category: "Labor", description: "4-man crew x 2 days", qty: 2 }] } });
  const chk = E.checkEstimate(est, { rates: assets.rates });
  assert.strictEqual(chk.priced.final_price, 11200);
  const docs = E.buildDocuments(chk.priced, null, assets);
  assert.ok(docs.proposal.length > 1000 && docs.costing.length > 1000);
});
