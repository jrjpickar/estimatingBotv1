#!/usr/bin/env node
// Usage: node bin/comps.js TAKEOFF.csv [--top 5] [--exclude "600 PCH"]... [--json comps.json]
"use strict";
const fs = require("fs");
const E = require("..");
const args = process.argv.slice(2);
const opt = { top: 5, exclude: [] };
let csv, out;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--top") opt.top = Number(args[++i]);
  else if (args[i] === "--exclude") opt.exclude.push(args[++i]);
  else if (args[i] === "--json") out = args[++i];
  else csv = args[i];
}
if (!csv) { console.error("Usage: node bin/comps.js TAKEOFF.csv [--top 5] [--exclude NAME] [--json out.json]"); process.exit(2); }
try {
  const items = E.parseStackCsv(fs.readFileSync(csv, "utf8"));
  const res = E.findComps(items, E.loadAssets().library, opt);
  if (out) fs.writeFileSync(out, JSON.stringify(res, null, 1));
  console.log(E.formatComps(res));
} catch (e) { console.error("ERROR: " + e.message); process.exit(1); }
