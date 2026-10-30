#!/usr/bin/env node
// Training: read past proposals (.docx, .pdf) and job costing sheets (.xlsx or .csv, V3 or any older layout), learn A2Z's
// scope wording, scope names and cost line items, and write the model.
// Usage: node bin/learn.js FILE... [--out learned.json] [--add learned.json]
//   --add merges with the records already in an existing learned.json.
// Then: node bin/auto.js TAKEOFF.csv --learned learned.json ...
"use strict";
const fs = require("fs");
const path = require("path");
const L = require("../lib/learn");
const LF = require("../lib/learnFiles");
const args = process.argv.slice(2);
const val = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const files = args.filter((a, i) => !a.startsWith("--") && !["--out", "--add"].includes(args[i - 1]));
if (!files.length) { console.error("Usage: node bin/learn.js FILE... [--out learned.json] [--add learned.json]"); process.exit(2); }
const out = val("--out") || "learned.json";
const prev = val("--add") && fs.existsSync(val("--add")) ? JSON.parse(fs.readFileSync(val("--add"), "utf8")).records || [] : [];
const records = [...prev];
for (const f of files) {
  const ext = path.extname(f).toLowerCase(), meta = { file: path.basename(f) };
  try {
    let r;
    if (ext === ".docx") r = LF.proposalFromDocx(fs.readFileSync(f), meta);
    else if (ext === ".xlsx") r = LF.costSheetFromXlsx(fs.readFileSync(f), meta);
    else if (ext === ".csv") r = LF.costSheetFromCsv(fs.readFileSync(f, "utf8"), meta);
    else if (ext === ".pdf") {
      const t = require("child_process").execFileSync("pdftotext", ["-raw", f, "-"], { encoding: "utf8", maxBuffer: 1 << 26 });
      r = L.proposalFromLines(t.split(/\r?\n/), meta);
    } else { console.log(`skip ${f} (use .docx or .pdf proposals, .xlsx or .csv cost sheets)`); continue; }
    if (r.layout === "other") console.log(`  (older layout${r.sheet ? ", sheet " + r.sheet : ""}: read by column headers and wording)`);
    const what = r.kind === "proposal" ? `${r.scopes.length} scopes, ${r.scopes.reduce((t, s) => t + s.bullets.length, 0)} lines, total ${r.total ?? "?"}` : `${r.lines.length} cost lines`;
    console.log(`${r.kind === "proposal" ? "proposal " : "cost sheet"}  ${meta.file}: ${what}`);
    records.push(r);
  } catch (e) { console.log(`FAILED ${f}: ${e.message}`); }
}
const model = L.learnModel(records);
fs.writeFileSync(out, JSON.stringify({ ...model, records }, null, 1));
console.log(`Learned from ${model.counts.proposals} proposals and ${model.counts.costsheets} cost sheets: ${model.phrases.length} scope phrasings, ${model.lineItems.length} line items -> ${out}`);
