#!/usr/bin/env node
// Plan QC in code (no AI): reads the text of a digital plan set and checks it against the STACK takeoff.
// Usage: node bin/plans.js PLANS.pdf [TAKEOFF.csv] [--json plan_qc.json] [--facts plan_facts.json]
//   --facts writes the plan facts in the format auto.js --facts reads (with plan_flags included),
//   so the checker shows every plan flag as a QUESTION or CHECK.
// Needs pdftotext (poppler). Scanned sheets have no text; they are listed as unreadable.
"use strict";
const fs = require("fs");
const { execFileSync } = require("child_process");
const E = require("..");
const args = process.argv.slice(2);
const val = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const pos = args.filter((a, i) => !a.startsWith("--") && !["--json", "--facts"].includes(args[i - 1]));
const [pdf, csv] = pos;
if (!pdf) { console.error("Usage: node bin/plans.js PLANS.pdf [TAKEOFF.csv] [--json out.json] [--facts plan_facts.json]"); process.exit(2); }
try {
  const text = /\.txt$/i.test(pdf) ? fs.readFileSync(pdf, "utf8") : execFileSync("pdftotext", ["-layout", pdf, "-"], { encoding: "utf8", maxBuffer: 1 << 28 });
  const items = csv ? E.parseStackCsv(fs.readFileSync(csv, "utf8")) : [];
  const r = E.analyzePlans(E.pagesFromPdftotext(text), items);
  console.log(`Read ${r.stats.readable} of ${r.stats.pages} pages. ${r.stats.callouts} demo callouts, ${r.stats.matched} matched to the takeoff.`);
  console.log("Sheets: " + r.sheets.map((s) => `${s.code} (${s.kind})`).join(", "));
  for (const f of r.flags) console.log(`  ${f.level === "ask" ? "QUESTION" : "CHECK   "} ${f.message}`);
  if (val("--json")) fs.writeFileSync(val("--json"), JSON.stringify(r, null, 1));
  if (val("--facts")) fs.writeFileSync(val("--facts"), JSON.stringify({ ...r.facts, plan_flags: r.flags }, null, 1));
} catch (e) { console.error("ERROR: " + e.message); process.exit(1); }
