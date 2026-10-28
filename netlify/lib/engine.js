// Shared loader for the functions: the estimator engine plus its data folder.
"use strict";
const fs = require("fs");
const path = require("path");
const E = require("../../estimator/engine");

let assets = null;
function dataDir() {
  const tries = [
    path.join(__dirname, "..", "..", "estimator", "data"),
    path.join(process.env.LAMBDA_TASK_ROOT || "", "estimator", "data"),
    path.join(process.cwd(), "estimator", "data"),
  ];
  const hit = tries.find((d) => fs.existsSync(path.join(d, "rates.json")));
  if (!hit) throw new Error("estimator/data not found. Check included_files in netlify.toml.");
  return hit;
}
function getAssets() {
  if (!assets) {
    const dir = dataDir();
    assets = E.loadAssets(dir); // includes defaults.json and production.json
  }
  return assets;
}
const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
function parse(event) {
  if (event.httpMethod !== "POST") throw Object.assign(new Error("POST only"), { code: 405 });
  try { return JSON.parse(event.body || "{}"); } catch (e) { throw Object.assign(new Error("Body must be JSON"), { code: 400 }); }
}
const fileName = (job) => String((job && (job.name || job.location)) || "Estimate").replace(/[^A-Za-z0-9 ,#&._-]+/g, "").trim().slice(0, 80);
module.exports = { E, getAssets, json, parse, fileName };
