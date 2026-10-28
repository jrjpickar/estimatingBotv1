"use strict";
// Saved estimates (Netlify Blobs store "a2z-estimating-bot-estimates"):
//   estimates/<id>        latest estimate + summary + version list
//   versions/<id>/<n>     every saved version (full estimate)
const crypto = require("node:crypto");
const { connectLambda, getStore } = require("./blobs-lite");

const STORE_NAME = "a2z-estimating-bot-estimates";

function estimateStore(event) {
  if (event && event.blobs) {
    try { connectLambda(event); } catch (e) { /* fall through */ }
  }
  const siteID = process.env.BLOBS_SITE_ID, token = process.env.BLOBS_TOKEN;
  if ((!event || !event.blobs) && siteID && token) return getStore({ name: STORE_NAME, siteID, token });
  return getStore(STORE_NAME);
}

const newId = () => new Date().toISOString().slice(0, 10).replace(/-/g, "") + "-" + crypto.randomBytes(4).toString("hex");
const validId = (id) => /^[0-9]{8}-[0-9a-f]{8}$/.test(String(id || ""));

module.exports = { estimateStore, newId, validId, STORE_NAME };
