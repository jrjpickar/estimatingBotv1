#!/usr/bin/env node
// Fill A2Z's two templates from a priced estimate.
// Usage: node bin/build.js priced.json [--comps comps.json] [--outdir OUT]
//   -> "<Job> - Proposal.docx" (A2Z proposal template) + "<Job> - Job Costing.xlsx" (Worksheet V3)
"use strict";
const fs = require("fs");
const path = require("path");
const E = require("..");
const args = process.argv.slice(2);
const val = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const inp = args.find((a, i) => !a.startsWith("--") && !["--comps", "--outdir"].includes(args[i - 1]));
if (!inp) { console.error("Usage: node bin/build.js priced.json [--comps comps.json] [--outdir OUT] [--force]"); process.exit(2); }
try {
  const priced = JSON.parse(fs.readFileSync(inp, "utf8"));
  const comps = val("--comps") ? JSON.parse(fs.readFileSync(val("--comps"), "utf8")) : null;
  const outdir = val("--outdir") || ".";
  fs.mkdirSync(outdir, { recursive: true });
  const job = priced.job || {};
  const name = String(job.name || job.location || "Estimate").replace(/[^A-Za-z0-9 ,#&._-]+/g, "").trim().slice(0, 80);
  const assets = E.loadAssets();
  const chk = E.checkEstimate(priced, { rates: assets.rates });
  console.log(E.formatIssues(chk));
  if (!chk.ok && !args.includes("--force")) { console.error("ERROR: fix the BLOCK items above before building (or pass --force for a draft)."); process.exit(1); }
  const docs = E.buildDocuments(priced, comps, assets);
  const p = path.join(outdir, `${name} - Proposal.docx`), c = path.join(outdir, `${name} - Job Costing.xlsx`);
  fs.writeFileSync(p, docs.proposal);
  fs.writeFileSync(c, docs.costing);
  console.log(p); console.log(c);
  for (const n of docs.notes) console.log("NOTE: " + n);
} catch (e) { console.error("ERROR: " + e.message); process.exit(1); }
