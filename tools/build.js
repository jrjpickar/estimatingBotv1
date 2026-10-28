#!/usr/bin/env node
// Builds public/checker.html: inlines the estimator engine's price.js + checks.js and rates.json
// into one self-contained page (no CDN, no installs). Re-run after changing a rule.
// Usage: node tools/build.js <path to estimate-job folder> <out dir>
"use strict";
const fs = require("fs"), path = require("path");
const [skillDir, outDir] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!skillDir || !outDir) { console.error("Usage: node tools/build.js <estimate-job dir> <out dir>"); process.exit(2); }
const lib = (f) => fs.readFileSync(path.join(skillDir, "engine", "lib", f), "utf8");
const mod = (name, src) => `"${name}": function (module, exports, require) {\n${src}\n}`;
const engine = `(function () {
var defs = {\n${mod("./common", lib("common.js"))},\n${mod("./price", lib("price.js"))},\n${mod("./checks", lib("checks.js"))},\n${mod("./comps", lib("comps.js"))},\n${mod("./auto", lib("auto.js"))},\n${mod("./plans", lib("plans.js"))},\n${mod("./autopilot", lib("autopilot.js"))},\n${mod("./costsheet", lib("costsheet.js"))},\n${mod("./proposalData", lib("proposalData.js"))}\n};
var cache = {};
function req(n) { if (cache[n]) return cache[n].exports; var m = cache[n] = { exports: {} }; defs[n](m, m.exports, req); return m.exports; }
var price = req("./price"), checks = req("./checks"), common = req("./common"), comps = req("./comps"), auto = req("./auto"), plans = req("./plans"), autopilot = req("./autopilot"), costsheet = req("./costsheet"), pd = req("./proposalData");
window.A2ZEstimator = { computeEstimate: price.computeEstimate, checkEstimate: checks.checkEstimate, RULES: checks.RULES, parseStackCsv: common.parseStackCsv, prepareLibrary: common.prepareLibrary, findComps: comps.findComps, autoEstimate: auto.autoEstimate, analyzePlans: plans.analyzePlans, autopilot: autopilot.autopilot, slotMap: costsheet.slotMap, LAYOUT: costsheet.LAYOUT, proposalData: pd.proposalData };
})();`;
const rates = fs.readFileSync(path.join(skillDir, "data", "rates.json"), "utf8");
const library = fs.readFileSync(path.join(skillDir, "data", "job_library.json"), "utf8");
const defaults = fs.readFileSync(path.join(skillDir, "data", "defaults.json"), "utf8");
const production = fs.readFileSync(path.join(skillDir, "data", "production.json"), "utf8");
const tpl = fs.readFileSync(path.join(__dirname, "..", "src", "checker.template.html"), "utf8");
const inline = process.argv.includes("--inline-data"); // sandbox only: the live site loads data after sign-in
const style = fs.readFileSync(path.join(skillDir, "data", "house_style.json"), "utf8");
let html = tpl.replace("/*__ENGINE__*/", () => engine);
if (inline) html = html.replace("/*__LIBRARY__*/null", () => JSON.stringify(JSON.parse(library))).replace("/*__DEFAULTS__*/null", () => JSON.stringify(JSON.parse(defaults))).replace("/*__PRODUCTION__*/null", () => JSON.stringify(JSON.parse(production))).replace("/*__RATES__*/null", () => JSON.stringify(JSON.parse(rates))).replace("/*__STYLE__*/null", () => JSON.stringify(JSON.parse(style)));
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "checker.html"), html);
fs.writeFileSync(path.join(outDir, "index.html"), html);
console.log("wrote " + path.join(outDir, "checker.html") + " (" + Math.round(html.length / 1024) + " KB)");
