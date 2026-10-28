#!/usr/bin/env node
// Usage: node bin/price.js estimate.json [--out priced.json]
"use strict";
const fs = require("fs");
const E = require("..");
const args = process.argv.slice(2);
const inp = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
if (!inp) { console.error("Usage: node bin/price.js estimate.json [--out priced.json]"); process.exit(2); }
try {
  const r = E.computeEstimate(JSON.parse(fs.readFileSync(inp, "utf8")));
  console.log(E.formatEstimate(r));
  if (out) fs.writeFileSync(out, JSON.stringify(r, null, 1));
} catch (e) { console.error("ERROR: " + e.message); process.exit(1); }
