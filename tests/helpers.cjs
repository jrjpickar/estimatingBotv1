// Shared test setup: in-memory Netlify Blobs, env vars, GHL encrypted user context.
const path = require("node:path");
const crypto = require("node:crypto");
const stores = new Map();
function memStore(name) {
  if (!stores.has(name)) stores.set(name, new Map());
  const m = stores.get(name);
  return {
    async get(key, opts) { if (!m.has(key)) return null; const v = m.get(key); return opts && opts.type === "json" ? JSON.parse(v) : v; },
    async setJSON(key, v) { m.set(key, JSON.stringify(v)); },
    async set(key, v) { m.set(key, v); },
    async delete(key) { m.delete(key); },
    async list({ prefix = "" } = {}) { return { blobs: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), directories: [] }; },
  };
}
const blobsPath = path.join(__dirname, "../netlify/lib/blobs-lite.js");
require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true, exports: { connectLambda() {}, getStore: (n) => memStore(typeof n === "string" ? n : n.name) } };

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
process.env.GHL_APP_SHARED_SECRET = process.env.GHL_APP_SHARED_SECRET || "shared-secret-from-marketplace";
process.env.ESTIMATING_BOT_PASSCODE = process.env.ESTIMATING_BOT_PASSCODE || "correct-horse-battery-7";
const LOC = "QUcu2PEAxPV1sQm1GQCq";

function encrypt(obj, pass = process.env.GHL_APP_SHARED_SECRET) {
  const salt = crypto.randomBytes(8); const blocks = []; let prev = Buffer.alloc(0);
  while (Buffer.concat(blocks).length < 48) { prev = crypto.createHash("md5").update(Buffer.concat([prev, Buffer.from(pass), salt])).digest(); blocks.push(prev); }
  const km = Buffer.concat(blocks); const c = crypto.createCipheriv("aes-256-cbc", km.subarray(0, 32), km.subarray(32, 48));
  return Buffer.concat([Buffer.from("Salted__"), salt, c.update(JSON.stringify(obj)), c.final()]).toString("base64");
}
const ghlContext = (user) => encrypt({ userId: user.id, userName: user.name, email: user.email, activeLocation: LOC, role: "user", type: "location" });
const post = (body, headers = {}) => ({ httpMethod: "POST", headers, body: JSON.stringify(body), queryStringParameters: {} });
const get = (qs = {}, headers = {}) => ({ httpMethod: "GET", headers, queryStringParameters: qs, body: "" });
const fn = (name) => require(path.join(__dirname, "../netlify/functions", name + ".js")).handler;
const body = (res) => JSON.parse(res.body || "{}");

module.exports = { stores, encrypt, ghlContext, post, get, fn, body, LOC };
