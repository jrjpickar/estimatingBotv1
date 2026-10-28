"use strict";
// Test cases from A2Z training sessions (references/training-notes.md).
// Only the totals were given in the sessions; where the line breakdown wasn't,
// one "balance" line brings cost to the stated total.
const test = require("node:test");
const assert = require("node:assert");
const { computeEstimate } = require("../lib/price.js");

test("parking lot: cost, 140% price and final bid stay separate", () => {
  const r = computeEstimate({
    sections: [{ name: "Exterior", lines: [
      { category: "Labor", description: "3 workers x 3 days", qty: 9, rate: 400 },
      { category: "Hauling", description: "10 loads", qty: 10, rate: 850 },
      { category: "Equipment", description: "20K excavator, skid steer, breaker, fuel (balance to session cost)", qty: 1, rate: 2800 },
    ] }],
    markup: 1.4,
    final_price: 29800,
  });
  assert.strictEqual(r.total_cost, 14900);
  assert.strictEqual(r.computed_price, 35760);
  assert.strictEqual(r.final_price, 29800);
  assert.strictEqual(r.effective_markup, 1);
  assert.strictEqual(r.margin, 0.5);
});

test("duplex: demo and grading priced as separate scopes", () => {
  const demoCost = 25800;
  const demoPrice = demoCost + 15000; // fixed dollar add
  const gradingPrice = 10000;         // placeholder: grading not priced in the session
  const r = computeEstimate({
    sections: [{ name: "Exterior", lines: [
      { category: "Labor", description: "4 workers x 7 days", qty: 28, rate: 400 },
      { category: "Hauling", description: "14 loads", qty: 14, rate: 850 },
      { category: "Equipment", description: "20K excavator, skid steer (balance to session cost)", qty: 1, rate: 2700 },
    ] }],
    final_price: demoPrice + gradingPrice,
    scopes: [
      { name: "DEMOLITION", lines: ["Demo duplex"], price: demoPrice },
      { name: "GRADING", lines: ["Grade lot"], price: gradingPrice },
    ],
  });
  assert.strictEqual(r.total_cost, demoCost);
  assert.strictEqual(demoPrice, 40800);
  assert.strictEqual(Math.round((demoPrice / demoCost - 1) * 100), 58);
  // scope prices that don't add up to the total are rejected
  assert.throws(() => computeEstimate({ ...r, sections: r.sections, final_price: 40000 }));
});

test("basement excavation: demo + grading add up exactly to the total", () => {
  const grading = {
    sections: [{ name: "Grading", lines: [
      { category: "Labor", description: "4 workers x 3 weeks (60 worker-days)", qty: 60, rate: 400 },
      { category: "Hauling", description: "Subcontract haul, 240 super ten loads", qty: 240, rate: 500 },
      { category: "Equipment", description: "Large excavator, 1 month (verify quote)", qty: 1, rate: 56000 },
      { category: "Fuel", description: "Job fuel allowance", qty: 1, rate: 2000 },
    ] }],
  };
  const r = computeEstimate({
    ...grading,
    final_price: 294000,
    scopes: [
      { name: "DEMOLITION", lines: ["Full demolition of structure and foundation"], price: 31400 },
      { name: "BASEMENT EXCAVATION/GRADING", lines: ["Excavate basement"], price: 262600 },
    ],
  });
  assert.strictEqual(r.total_cost, 202000);
  assert.strictEqual(r.final_price, 294000);
  assert.throws(() => computeEstimate({ ...grading, final_price: 294000, scopes: [
    { name: "DEMOLITION", lines: [], price: 31400 },
    { name: "GRADING", lines: [], price: 260000 },
  ] }));
});
