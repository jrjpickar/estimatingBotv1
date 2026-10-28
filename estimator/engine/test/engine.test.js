"use strict";
// npm test   (or: node --test test/engine.test.js)
const test = require("node:test");
const assert = require("node:assert/strict");
const { PizZip } = require("../vendor/docx-vendor");
const E = require("..");

const assets = E.loadAssets();
const CSV = [
  '"Takeoff Name","Takeoff Description","Sq Ft","Ln Ft","Cu Yd","EA","Marker Count","Drop Count","Takeoff Quantity","Takeoff Unit","Scale","Plan Name"',
  '"demo metal stud walls","","0","53.27","0","8","0","0","53.27","Ln Ft","1/4"" = 1\'","A101 - DEMO FLOOR PLAN"',
  '"cut and demo floor carpet","","1783.81","384.41","0","1","0","0","1783.81","Sq Ft","1/4"" = 1\'","A101 - DEMO FLOOR PLAN"',
  '"remove millwork","","66.61","60.01","0","1","0","0","66.61","Sq Ft","1/4"" = 1\'","A101 - DEMO FLOOR PLAN"',
  '"demo sink","","0","0","0","1","0","0","1","EA","1/4"" = 1\'","A101 - DEMO FLOOR PLAN"',
].join("\n");

// 600 PCH, Seal Beach: the real cost sheet and sent proposal (092426JP).
const EST = {
  job: { name: "600 PCH, Seal Beach", customer: "CRM CONSTRUCTION", location: "600 PACIFIC COAST HWY SEAL BEACH", estimator: "Jesse Pickar", estimate_number: "092426JP", date: "Sep 24, 2026" },
  sections: [{ name: "Interior", lines: [
    { category: "Labor", description: "four guys two days", qty: 2, rate: 1600 },
    { category: "Hauling", description: "three trucks", qty: 3, rate: 850 },
    { category: "Equipment", description: "floor scraper", qty: 1, rate: 575 },
    { category: "Equipment", description: "quickie saw", qty: 1, rate: 135 }] }],
  markup: 2.5, final_price: 21454,
  scopes: [{ name: "Demolition", lines: ["Properly remove cabinetry per plans (A101)", "Properly demolish metal stud walls and wall segment per plans (A101)", "Properly cut and remove carpet per plans (A101)"] }],
};

const docText = (buf, part) => new PizZip(buf).file(part).asText().replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, "")
  .replace(/<\/w:p>/g, "\n").replace(/<w:br\/>/g, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&");

test("parses the STACK export", () => {
  const items = E.parseStackCsv(CSV);
  assert.equal(items.length, 4);
  assert.deepEqual(items.map((i) => [i.item, i.qty, i.unit, i.group]), [
    ["demo metal stud walls", 53.27, "LF", "walls_partitions"],
    ["cut and demo floor carpet", 1783.81, "SF", "flooring"],
    ["remove millwork", 66.61, "SF", "millwork_casework"],
    ["demo sink", 1, "EA", "plumbing_fixtures"]]);
});

test("comps for 600 PCH (itself excluded)", () => {
  const r = E.findComps(E.parseStackCsv(CSV), assets.library, { top: 5, exclude: ["600 PAC"] });
  assert.equal(r.comps[0].name, "20 City Blvd West, Orange");
  assert.equal(r.comps[0].score, 0.743);
  assert.ok(r.range.min <= 21454 && 21454 <= r.range.max, "real price sits inside the comp range");
});

test("pricing matches the real 600 PCH cost sheet", () => {
  const p = E.computeEstimate(EST);
  assert.equal(p.total_cost, 6460);
  assert.equal(p.computed_price, 22610);
  assert.equal(p.final_price, 21454);
  assert.equal(p.effective_markup, 2.3211);
});

test("no markup and no final price is refused", () => {
  assert.throws(() => E.computeEstimate({ ...EST, markup: undefined, final_price: undefined }), /markup or a final_price/);
});

test("proposal is the Make template, filled", () => {
  const p = E.computeEstimate(EST);
  const buf = E.fillProposal(assets.proposalTemplate, E.proposalData(p, assets.style));
  const body = docText(buf, "word/document.xml"), head = docText(buf, "word/header1.xml");
  assert.match(head, /ESTIMATE: 092426JP/);
  assert.match(head, /CRM CONSTRUCTION/);
  assert.match(body, /DEMOLITION TOTAL:\s+\$21,454\.00/);
  assert.match(body, /TOTAL:\s+\$21,454\.00/);
  assert.doesNotMatch(body + head, /\{\{/);
  // every part without tags is byte-identical to the template
  const t = new PizZip(assets.proposalTemplate), o = new PizZip(buf);
  for (const n of Object.keys(t.files)) {
    if (t.files[n].dir || n === "word/document.xml" || n === "word/header1.xml") continue;
    assert.deepEqual(Buffer.from(o.file(n).asUint8Array()), Buffer.from(t.file(n).asUint8Array()), n);
  }
});

test("alternates print but stay out of TOTAL", () => {
  const est = { ...EST, final_price: 21454, scopes: [
    { name: "Demolition", lines: ["a"], price: 21454 },
    { name: "ALTERNATE #1 - SAWCUT & DEMOLISH", lines: ["b"], price: 4995, alternate: true }] };
  const p = E.computeEstimate(est);
  const body = docText(E.fillProposal(assets.proposalTemplate, E.proposalData(p, assets.style)), "word/document.xml");
  assert.match(body, /ALTERNATE #1 TOTAL:\s+\$4,995\.00/);
  assert.match(body, /\nTOTAL:\s+\$21,454\.00/);
});

test("job costing fills Worksheet V3 input cells only", () => {
  const p = E.computeEstimate(EST);
  const comps = E.findComps(E.parseStackCsv(CSV), assets.library, { exclude: ["600 PAC"] });
  const { buffer, notes } = E.fillJobCosting(assets.costingTemplate, p, comps);
  assert.deepEqual(notes, []);
  const z = new PizZip(buffer), t = new PizZip(assets.costingTemplate);
  const s1 = z.file("xl/worksheets/sheet1.xml").asText();
  const cell = (ref) => (s1.match(new RegExp(`<c r="${ref}"[^>]*>([\\s\\S]*?)</c>`)) || [])[1] || "";
  assert.match(cell("B8"), /four guys two days/);
  assert.match(cell("C10"), /<v>3<\/v>/);
  assert.match(cell("D10"), /<v>850<\/v>/);
  assert.match(cell("E8"), /<f[^>]*>C8\*D8<\/f><v>3200<\/v>/);
  assert.match(cell("E37"), /<v>6460<\/v>/);
  assert.match(cell("E39"), /<f>E37\*\(1\+E38\)<\/f><v>21454(\.\d+)?<\/v>/);
  const changed = Object.keys(t.files).filter((n) => !t.files[n].dir && Buffer.compare(Buffer.from(z.file(n).asUint8Array()), Buffer.from(t.file(n).asUint8Array())) !== 0);
  assert.deepEqual(changed.sort(), ["xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml", "xl/worksheets/sheet3.xml"]);
});

test("equipment overflow goes to Misc and is reported", () => {
  const est = { ...EST, sections: [{ name: "Interior", lines: [
    { category: "Equipment", description: "a", qty: 1, rate: 10 }, { category: "Equipment", description: "b", qty: 1, rate: 20 },
    { category: "Equipment", description: "c", qty: 1, rate: 30 }] }], markup: 1, final_price: undefined, scopes: [{ name: "X", lines: ["x"] }] };
  const { notes } = E.fillJobCosting(assets.costingTemplate, E.computeEstimate(est), null);
  assert.match(notes[0], /Misc row/);
});
