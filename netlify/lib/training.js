"use strict";
// Training uploads (Netlify Blobs store "a2z-estimating-bot-training"):
//   records/<id>   one parsed proposal or cost sheet (what was learned from one file)
//   model          the learned model built from every record (lib/learn.js learnModel)
const crypto = require("node:crypto");
const { connectLambda, getStore } = require("./blobs-lite");
const { E } = require("./engine");

const STORE_NAME = "a2z-estimating-bot-training";
function trainingStore(event) {
  if (event && event.blobs) { try { connectLambda(event); } catch (e) { /* fall through */ } }
  const siteID = process.env.BLOBS_SITE_ID, token = process.env.BLOBS_TOKEN;
  if ((!event || !event.blobs) && siteID && token) return getStore({ name: STORE_NAME, siteID, token });
  return getStore(STORE_NAME);
}
const newRecordId = () => Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex");
const validRecordId = (id) => /^[0-9a-z]{6,12}-[0-9a-f]{6}$/.test(String(id || ""));

async function listRecords(store) {
  const { blobs } = await store.list({ prefix: "records/" });
  const rows = await Promise.all((blobs || []).map((b) => store.get(b.key, { type: "json" }).catch(() => null)));
  return rows.filter(Boolean);
}
async function rebuildModel(store) {
  const records = await listRecords(store);
  const model = E.learnModel(records);
  await store.setJSON("model", model);
  return { model, records };
}
// the learned model for autopilot (null when nothing has been trained yet)
async function readModel(event) {
  try {
    const m = await trainingStore(event).get("model", { type: "json" });
    return m && m.counts && (m.counts.proposals || m.counts.costsheets) ? m : null;
  } catch (e) { return null; }
}
module.exports = { trainingStore, newRecordId, validRecordId, listRecords, rebuildModel, readModel, STORE_NAME };
