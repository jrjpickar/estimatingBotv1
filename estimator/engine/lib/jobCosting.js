"use strict";
// Fill A2Z's Job Costing Worksheet V3 (the real template). Only input cells' XML
// changes, so formats, formulas, merges, dropdowns and the reference tab stay exactly
// as-is. Formula results are written as cached values too (and the workbook is set to
// recalc on open). Buffer in, buffer out.
//
// Job Costing tab layout: Job Name C2 · Date C3 · Markup % E38 · price E39 = E37*(1+E38)
//   INTERIOR rows 8-14: Labor, Hotel, Hauling, Equipment, Equipment, Fuel, Misc   (subtotal E15)
//   EXTERIOR rows 19-25: Labor, Hauling, Equipment, Equipment, Equipment, Fuel, Misc (E26)
//   GRADING  rows 30-34: Labor, Hauling, Equipment, Fuel, Misc                     (E35)
// Input columns B (description), C (qty), D (rate); E = C*D.
const PizZip = require("../vendor/docx-vendor").PizZip;

const { LAYOUT, INTERIOR_GROUPS, GRADING_GROUPS, assignRows } = require("./costsheet");

// ---------- raw XML cell editing ----------
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const colNum = (ref) => [...ref.match(/^[A-Z]+/)[0]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const fmtNum = (v) => (Number.isInteger(v) ? String(v) : String(v)); // JS String() is shortest round-trip

function cellXml(ref, attrs, value) {
  if (value === null || value === undefined || value === "") return `<c r="${ref}"${attrs}/>`;
  if (typeof value === "number") return `<c r="${ref}"${attrs}><v>${fmtNum(value)}</v></c>`;
  return `<c r="${ref}"${attrs} t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

function setCell(xml, ref, { value, cached } = {}) {
  const re = new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>([\\s\\S]*?)</c>)`);
  const m = re.exec(xml);
  if (!m) {
    const row = ref.match(/\d+$/)[0];
    const rm = new RegExp(`<row r="${row}"[^>]*?(?:/>|>([\\s\\S]*?)</row>)`).exec(xml);
    if (!rm) throw new Error(`Template row ${row} not found for ${ref}.`);
    const neu = cellXml(ref, "", value);
    if (rm[0].endsWith("/>")) return xml.slice(0, rm.index) + rm[0].slice(0, -2) + ">" + neu + "</row>" + xml.slice(rm.index + rm[0].length);
    const inner = rm[1];
    const innerStart = rm.index + rm[0].indexOf(inner);
    let pos = inner.length;
    for (const c of inner.matchAll(/<c r="([A-Z]+)\d+"/g)) if (colNum(c[1]) > colNum(ref)) { pos = c.index; break; }
    return xml.slice(0, innerStart + pos) + neu + xml.slice(innerStart + pos);
  }
  const attrs = m[1].replace(/\s+t="[^"]*"/, "");
  const body = m[2] || "";
  let neu;
  if (cached !== undefined) {
    const f = /<f[^>]*?(?:\/>|>[\s\S]*?<\/f>)/.exec(body);
    neu = `<c r="${ref}"${attrs}>${f ? f[0] : ""}<v>${fmtNum(cached)}</v></c>`;
  } else {
    neu = cellXml(ref, attrs, value);
  }
  return xml.slice(0, m.index) + neu + xml.slice(m.index + m[0].length);
}

function fillJobCosting(templateBuffer, priced, comps, { now = new Date() } = {}) {
  const job = priced.job || {};
  const { cells, notes } = assignRows(priced.sections);
  const cost = priced.total_cost;
  const final = priced.final_price;
  let markup = cost ? final / cost - 1 : (priced.markup || 0);
  if (priced.markup != null && Math.abs(cost * (1 + priced.markup) - final) < 0.005) markup = priced.markup;

  const zip = new PizZip(templateBuffer);
  const read = (n) => zip.file(n).asText();

  // --- Job Costing (sheet1) ---
  let x = read("xl/worksheets/sheet1.xml");
  x = setCell(x, "C2", { value: job.name || job.location || "" });
  x = setCell(x, "C3", { value: job.date || now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) });
  for (const [ref, v] of Object.entries(cells)) x = setCell(x, ref, { value: v });
  let totalCost = 0;
  for (const lay of Object.values(LAYOUT)) {
    let tot = 0;
    lay.cats.forEach((_, i) => {
      const r = lay.start + i;
      const ext = (cells[`C${r}`] || 0) * (cells[`D${r}`] || 0);
      tot += ext;
      x = setCell(x, `E${r}`, { cached: ext });
    });
    x = setCell(x, `E${lay.sub}`, { cached: tot });
    totalCost += tot;
  }
  if (Math.abs(totalCost - cost) > 0.01) throw new Error(`Template total ${totalCost.toFixed(2)} doesn't match priced total ${cost.toFixed(2)}.`);
  x = setCell(x, "E37", { cached: totalCost });
  x = setCell(x, "E38", { value: markup });
  x = setCell(x, "E39", { cached: totalCost * (1 + markup) });
  zip.file("xl/worksheets/sheet1.xml", x);

  // --- Raw Takeoffs (sheet3): STACK lines into A-K, rows 6-155 ---
  const items = (comps && comps.newJob && comps.newJob.items) || [];
  if (items.length) {
    let y = read("xl/worksheets/sheet3.xml");
    items.slice(0, 150).forEach((it, n) => {
      const r = 6 + n;
      const g = it.group || "other";
      const section = GRADING_GROUPS.has(g) ? "Grading" : INTERIOR_GROUPS.has(g) ? "Interior" : "Exterior";
      const vals = { A: job.date || "", B: `${it.item}: ${it.description || ""}`, C: it.plan || "", D: Number(it.qty), E: it.unit, H: section, J: "New", K: g.replace(/_/g, " ") };
      for (const [col, v] of Object.entries(vals)) y = setCell(y, `${col}${r}`, { value: v });
    });
    if (items.length > 150) notes.push(`Raw Takeoffs holds 150 lines; ${items.length - 150} more are only in the comps list.`);
    zip.file("xl/worksheets/sheet3.xml", y);
  }

  // --- Comp Job (sheet2): one summary row like the existing comp step ---
  const cs = (comps && comps.comps) || [];
  if (cs.length) {
    let w = read("xl/worksheets/sheet2.xml");
    const best = cs[0], ru = cs[1];
    const ex = priced.comp_summary || {};
    const vals = {
      A2: now.toISOString().replace(/\.\d{3}Z$/, ".000Z"), B2: best.name, C2: job.estimate_number || "", D2: Number(best.sentTotal),
      E2: Math.round(best.score * 100), F2: ex.confidence || "", G2: ex.best_why || best.sharedGroups.join(", "),
      H2: ex.best_differences || "", I2: ex.runner_up_why || "", J2: ex.recommended_use || "",
      K2: ru ? ru.name : "", L2: ru ? Math.round(ru.score * 100) : "",
    };
    for (const [ref, v] of Object.entries(vals)) w = setCell(w, ref, { value: v });
    zip.file("xl/worksheets/sheet2.xml", w);
  }

  // recalc on open
  let wb = read("xl/workbook.xml");
  wb = wb.replace(/<calcPr([^>]*?)\/>/, (_, a) => `<calcPr${a.replace(/\s*fullCalcOnLoad="[^"]*"/, "")} fullCalcOnLoad="1"/>`);
  zip.file("xl/workbook.xml", wb);

  return { buffer: zip.generate({ type: "nodebuffer", compression: "DEFLATE" }), notes, markup };
}

module.exports = { fillJobCosting, assignRows, setCell, LAYOUT };
