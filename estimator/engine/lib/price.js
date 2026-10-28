"use strict";
// Cost build-up and price. Pure arithmetic: every number comes from the estimator.
//
// estimate = {
//   job: { name, customer, location, estimator, estimate_number, date },
//   sections: [ { name: "Interior"|"Exterior"|"Grading",
//                 lines: [ { category: "Labor"|"Hotel"|"Hauling"|"Equipment"|"Fuel"|"Misc", description, qty, rate } ] } ],
//   markup: 2.32,          // price = cost x (1 + markup), as on the Job Costing sheet
//   final_price: 21454,    // optional: the estimator's chosen bid; overrides the computed price
//   scopes: [ { name, lines: [...], price, alternate } ],
//   flags, comp_summary, notes, exclusions, remain ...   (passed through for the documents)
// }
const STANDARD_RATES = { crew_day_4man: 1600, truck_load_all_in: 850 }; // confirmed by Jesse

const cents = (x) => Math.round(x * 100) / 100;

function computeEstimate(est) {
  let totalCost = 0;
  const sections = (est.sections || []).map((s) => {
    const lines = (s.lines || []).map((ln) => {
      if (ln.qty == null || ln.rate == null) throw new Error(`Missing qty or rate on line: ${JSON.stringify(ln)}`);
      return { ...ln, qty: Number(ln.qty), rate: Number(ln.rate), extended: cents(Number(ln.qty) * Number(ln.rate)) };
    });
    const subtotal = cents(lines.reduce((t, l) => t + l.extended, 0));
    totalCost += subtotal;
    return { name: s.name, lines, subtotal };
  });
  totalCost = cents(totalCost);
  if (est.markup == null && !est.final_price) throw new Error("Give either a markup or a final_price - the agent never picks one.");
  const markup = est.markup;
  const computed = markup != null ? cents(totalCost * (1 + Number(markup))) : null;
  const final = est.final_price ? Number(est.final_price) : computed;
  const eff = totalCost ? Math.round((final / totalCost - 1) * 10000) / 10000 : null;
  const margin = final ? Math.round(((final - totalCost) / final) * 10000) / 10000 : null;
  const base = (est.scopes || []).filter((s) => s.price != null && !s.alternate);
  if (base.length) {
    const sum = base.reduce((t, s) => t + Number(s.price), 0);
    if (Math.abs(sum - final) > 0.5) throw new Error(`Scope prices add to ${sum.toFixed(2)} but the total is ${final.toFixed(2)}.`);
  }
  return { ...est, sections, total_cost: totalCost, computed_price: computed, final_price: final, effective_markup: eff, margin };
}

function formatEstimate(r) {
  const m = (v) => "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const L = [];
  for (const s of r.sections) {
    L.push(s.name);
    for (const l of s.lines) L.push(`  ${l.category.padEnd(10)} ${String(l.description || "").padEnd(28)} ${String(l.qty).padStart(6)} x ${m(l.rate).padStart(10)} = ${m(l.extended).padStart(12)}`);
    L.push(`  ${"subtotal".padEnd(40)} ${m(s.subtotal).padStart(25)}`);
  }
  L.push(`TOTAL COST            ${m(r.total_cost)}`);
  if (r.computed_price != null) L.push(`Price at markup ${Math.round(r.markup * 100)}%: ${m(r.computed_price)}`);
  L.push(`FINAL PRICE           ${m(r.final_price)}  (effective markup ${Math.round(r.effective_markup * 100)}%, margin ${Math.round(r.margin * 100)}%)`);
  return L.join("\n");
}

module.exports = { computeEstimate, formatEstimate, STANDARD_RATES };
