#!/usr/bin/env node
// Auto mode: drop a STACK takeoff (+ plan facts + draft crew/haul/equipment) -> full draft estimate,
// checks, review sheet, and draft proposal + job costing files. No questions asked along the way.
//
// Usage: node bin/auto.js TAKEOFF.csv --outdir OUT [--plans A.pdf,B.pdf] [--facts plan_facts.json] [--inputs inputs.json]
//                         [--job job.json] [--markup 1.3] [--exclude "<address>"]
// AUTOPILOT: without --inputs, crew-days, loads and equipment are drafted by code (data/production.json)
// and --plans are read and checked by code (pdftotext). No AI needed.
// Writes OUT/comps.json, OUT/estimate.json, OUT/priced.json, OUT/review.md,
//        OUT/"DRAFT - <Job> - Proposal.docx", OUT/"DRAFT - <Job> - Job Costing.xlsx"
"use strict";
const fs = require("fs");
const path = require("path");
const E = require("..");
const A = require("../lib/auto");
const args = process.argv.slice(2);
const flags = ["--outdir", "--facts", "--inputs", "--job", "--markup", "--exclude", "--plans"];
const val = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const csv = args.find((a, i) => !a.startsWith("--") && !flags.includes(args[i - 1]));
if (!csv) { console.error("Usage: node bin/auto.js TAKEOFF.csv --outdir OUT [--facts f.json] [--inputs i.json] [--job j.json] [--markup 1.3]"); process.exit(2); }
const readJson = (p) => (p ? JSON.parse(fs.readFileSync(p, "utf8")) : {});
try {
  const outdir = val("--outdir") || "auto-out";
  fs.mkdirSync(outdir, { recursive: true });
  const assets = E.loadAssets();
  const defaults = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "data", "defaults.json"), "utf8"));
  const items = E.parseStackCsv(fs.readFileSync(csv, "utf8"));
  const comps = E.findComps(items, assets.library, { top: 5, exclude: val("--exclude") ? [val("--exclude")] : [] });
  fs.writeFileSync(path.join(outdir, "comps.json"), JSON.stringify(comps, null, 1));

  let facts = readJson(val("--facts"));
  let est;
  if (!val("--inputs")) {
    // autopilot: code drafts everything, plans read by code
    let pages = null;
    if (val("--plans")) {
      const { execFileSync } = require("child_process");
      pages = [];
      for (const f of val("--plans").split(",").map((x) => x.trim()).filter(Boolean)) {
        const t = execFileSync("pdftotext", ["-layout", f, "-"], { encoding: "utf8", maxBuffer: 1 << 28 });
        for (const p of E.pagesFromPdftotext(t)) pages.push({ n: pages.length + 1, lines: p.lines });
      }
    }
    const ap = E.autopilot({ items, pages, library: assets.library, rates: assets.rates, defaults, production: assets.production, job: readJson(val("--job")), markup: val("--markup") });
    est = ap.estimate;
    if (ap.planCheck) { facts = { ...ap.planCheck.facts, ...facts }; console.log(`Plans: read ${ap.planCheck.stats.readable} of ${ap.planCheck.stats.pages} pages, ${ap.planCheck.stats.callouts} demo callouts, ${ap.planCheck.stats.matched} matched.`); }
  } else {
    est = A.autoEstimate({ items, facts, inputs: readJson(val("--inputs")), job: readJson(val("--job")), defaults, rates: assets.rates, markup: val("--markup") });
  }
  const style = assets.style;
  if (est.extra_exclusions) est.exclusions = style.exclusions + " " + est.extra_exclusions.join(", ") + ".";
  if (est.extra_notes) est.notes = style.notes.concat(est.extra_notes);
  if (comps.comps.length) {
    const b = comps.comps[0], r = comps.comps[1];
    est.comp_summary = { confidence: b.score >= 0.6 ? "medium" : "low", best_why: b.sharedGroups.join(", "), best_differences: b.onlyInNew.length ? "only in new job: " + b.onlyInNew.join(", ") : "", runner_up_why: r ? r.sharedGroups.join(", ") : "", recommended_use: "sanity range only (auto draft)" };
  }
  fs.writeFileSync(path.join(outdir, "estimate.json"), JSON.stringify(est, null, 1));

  const chk = E.checkEstimate(est, { rates: assets.rates });
  const priced = chk.priced || est;
  fs.writeFileSync(path.join(outdir, "priced.json"), JSON.stringify(priced, null, 1));
  const review = A.reviewSheet(priced, chk, comps, facts);
  fs.writeFileSync(path.join(outdir, "review.md"), review);

  if (chk.priced) {
    const job = priced.job || {};
    const name = String(job.name || job.location || "Estimate").replace(/[^A-Za-z0-9 ,#&._-]+/g, "").trim().slice(0, 80);
    try {
      const docs = E.buildDocuments(priced, comps, assets);
      fs.writeFileSync(path.join(outdir, `${defaults.draft_prefix}${name} - Proposal.docx`), docs.proposal);
      fs.writeFileSync(path.join(outdir, `${defaults.draft_prefix}${name} - Job Costing.xlsx`), docs.costing);
      for (const n of docs.notes) console.log("NOTE: " + n);
    } catch (e) { console.log("Documents not built: " + e.message); }
  } else console.log("Not priced yet (no cost lines or a missing rate). Documents not built.");
  console.log(review);
  console.log("\n" + E.formatIssues(chk));
} catch (e) { console.error("ERROR: " + e.message); process.exit(1); }
