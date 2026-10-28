"use strict";
// Checker tests, built from the training-session examples in references/training-notes.md.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const { checkEstimate } = require("../lib/checks");
const rates = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "data", "rates.json"), "utf8"));
const ids = (r) => r.issues.map((i) => i.id);
const has = (r, id) => ids(r).includes(id);

const montebello = () => ({
  job: { name: "Montebello ceiling demo" },
  sections: [{ name: "Interior", lines: [
    { category: "Labor", description: "5 workers x 2 days", qty: 10, rate: 400 },
    { category: "Hauling", description: "1 load", qty: 1, rate: 850 },
    { category: "Equipment", description: "Scissor lift 15 ft, 1 day", qty: 1, rate: 115 },
  ] }],
  markup: 1.4,
  price_source: "transcript",
  scopes: [{ name: "Demolition", lines: [
    "Properly remove (1) small millwork cabinet",
    "Properly remove ACT ceiling tiles, lights, diffusers, speakers and security devices",
    "Properly remove carpet tile and rubber base",
    "Properly remove marked walls and doors",
  ] }],
});

test("montebello: catches the transcript price, lift delivery, ceiling questions, order and access", () => {
  const r = checkEstimate(montebello(), { rates });
  assert.strictEqual(r.ok, false);
  for (const id of ["unconfirmed_price", "lift_delivery", "ceiling_grid", "ceiling_devices", "ceiling_height", "work_order", "access"])
    assert.ok(has(r, id), "expected " + id + " in " + ids(r));
});

test("montebello fixed: answers clear the questions", () => {
  const e = montebello();
  e.price_source = "costing_sheet";
  e.sections[0].lines.push({ category: "Equipment", description: "Lift delivery and pickup", qty: 2, rate: 150 });
  e.scopes[0].lines = [
    "Properly remove (1) small millwork cabinet",
    "Properly remove carpet tile and rubber base",
    "Properly remove marked walls and doors",
    "Properly remove ACT ceiling tiles, leave existing ceiling grid in place",
    "Properly remove (12) lights, (6) diffusers, (4) speakers, (2) security devices",
  ];
  e.job.access = "single man door";
  e.job.ceiling_height_ft = 10;
  e.confirmed = ["ceiling_devices"];
  const r = checkEstimate(e, { rates });
  assert.deepStrictEqual(ids(r), []);
  assert.strictEqual(r.ok, true);
});

test("parking lot: bid under markup price needs a reason; takeoff gap and new slab flagged", () => {
  const e = {
    sections: [{ name: "Exterior", lines: [
      { category: "Labor", description: "3 workers x 3 days", qty: 9, rate: 400 },
      { category: "Hauling", description: "10 loads", qty: 10, rate: 850 },
      { category: "Equipment", description: "20K excavator, skid steer, breaker, delivery", qty: 1, rate: 2800 },
    ] }],
    markup: 1.4, final_price: 29800,
    scopes: [{ name: "Asphalt", lines: ["Saw-cut, break and haul 2,800 SF asphalt (per plans)", "24\" mat slab by others"] }],
    quantity_checks: [{ item: "Asphalt", takeoff_qty: 241000, plan_qty: 2800, unit: "SF", source: "70 x 40 on plans" }],
  };
  const r = checkEstimate(e, { rates });
  for (const id of ["bid_vs_markup", "sawcut", "new_work", "quantity_gap"]) assert.ok(has(r, id), "expected " + id);
  assert.strictEqual(r.priced.computed_price, 35760);
  e.pricing_note = "Bid lower to stay competitive";
  e.confirmed = ["sawcut"];
  const r2 = checkEstimate(e, { rates });
  assert.ok(!has(r2, "bid_vs_markup") && !has(r2, "sawcut"));
});

test("basement: scope sum, mixed scope, sub haul fuel, excavator vs rate sheet, excavation chain", () => {
  const e = {
    sections: [{ name: "Grading", lines: [
      { category: "Labor", description: "4 workers x 3 weeks", qty: 60, rate: 400 },
      { category: "Hauling", description: "Sub haul, super ten loads", qty: 240, rate: 500 },
      { category: "Equipment", description: "56K excavator, 1 month, delivered", qty: 1, rate: 56000 },
      { category: "Fuel", description: "Hauling fuel", qty: 1, rate: 2000 },
      { category: "Misc", description: "Breaker allowance", qty: 0, rate: 1500 },
    ] }],
    final_price: 294000,
    scopes: [
      { name: "DEMOLITION AND GRADING", lines: ["Full demolition of structure and foundation"], price: 31400 },
      { name: "BASEMENT EXCAVATION", lines: ["Excavate basement"], price: 260000 },
    ],
  };
  const r = checkEstimate(e, { rates });
  assert.strictEqual(r.ok, false);
  for (const id of ["scope_sum", "mixed_scope", "sub_haul_fuel", "equipment_vs_sheet", "equipment_quote", "excavation_chain", "lifts_recompaction", "empty_line"])
    assert.ok(has(r, id), "expected " + id + " in " + ids(r));
});

test("excavation math: footprint x depth vs volume", () => {
  const e = {
    sections: [{ name: "Grading", lines: [{ category: "Labor", description: "crew", qty: 1, rate: 400 }] }],
    final_price: 1000,
    pricing_note: "test",
    scopes: [{ name: "BASEMENT EXCAVATION", lines: ["Excavate basement, 12\" lifts and recompaction"] }],
    excavation: { footprint_sf: 2000, depth_ft: 12, volume_cy: 3000, loads: 250 },
  };
  assert.ok(has(checkEstimate(e, { rates }), "excavation_math"));
  e.excavation.volume_cy = 889;
  assert.ok(!has(checkEstimate(e, { rates }), "excavation_math"));
});

test("math blockers: missing rate, percent-style markup, below cost", () => {
  const base = { sections: [{ name: "Interior", lines: [{ category: "Labor", description: "crew", qty: 2, rate: 1600 }] }] };
  assert.ok(has(checkEstimate({ ...base, markup: 140 }), "markup_format"));
  assert.ok(has(checkEstimate({ ...base, final_price: 1000 }), "below_cost"));
  assert.ok(has(checkEstimate({ sections: [{ name: "Interior", lines: [{ category: "Labor", qty: 2 }] }], markup: 1 }), "line_values"));
  assert.ok(has(checkEstimate({ ...base }), "price_basis"));
  // block-level items can't be silenced with confirmed
  assert.ok(has(checkEstimate({ ...base, final_price: 1000, confirmed: ["below_cost"] }), "below_cost"));
});

test("600 PCH real estimate passes with no blockers", () => {
  const r = checkEstimate({
    sections: [{ name: "Interior", lines: [
      { category: "Labor", description: "4-man crew", qty: 3, rate: 1600 },
      { category: "Hauling", description: "loads", qty: 2, rate: 850 },
    ] }],
    final_price: 21454,
    scopes: [{ name: "Demolition", lines: ["Properly remove carpet"] }],
  }, { rates });
  assert.strictEqual(r.ok, true);
});
