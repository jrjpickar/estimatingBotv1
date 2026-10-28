#!/usr/bin/env node
// Run A2Z's estimating rules on an estimate. No AI involved.
// Usage: node bin/check.js estimate.json [--json]
// Exit code 0 = no BLOCK items, 1 = at least one BLOCK, 2 = bad usage.
"use strict";
const fs = require("fs");
const E = require("..");
const args = process.argv.slice(2);
const inp = args.find((a) => !a.startsWith("--"));
if (!inp) { console.error("Usage: node bin/check.js estimate.json [--json]"); process.exit(2); }
try {
  const res = E.checkEstimate(JSON.parse(fs.readFileSync(inp, "utf8")), { rates: E.loadAssets().rates });
  if (args.includes("--json")) console.log(JSON.stringify({ ok: res.ok, issues: res.issues }, null, 1));
  else {
    if (res.priced) console.log(E.formatEstimate(res.priced) + "\n");
    console.log(E.formatIssues(res));
  }
  process.exit(res.ok ? 0 : 1);
} catch (e) { console.error("ERROR: " + e.message); process.exit(2); }
