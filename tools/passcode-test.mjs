// Tests the passcode edge function in Node (fakes Netlify's env and context). Run: node tools/passcode-test.mjs
import assert from "node:assert";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const src = readFileSync(new URL("../netlify/edge-functions/passcode.js", import.meta.url), "utf8");
const file = join(mkdtempSync(join(tmpdir(), "gate-")), "passcode.mjs");
writeFileSync(file, src);
const { default: gate, config } = await import(pathToFileURL(file));
assert.strictEqual(config.path, "/*");

let PASS = "";
globalThis.Netlify = { env: { get: (k) => (k === "ESTIMATING_BOT_PASSCODE" ? PASS : undefined) } };
const ctx = { next: async () => new Response("PAGE", { status: 200, headers: { "content-type": "text/html" } }) };
const req = (path, init = {}) => new Request("https://bot.example.com" + path, init);

// unset env var: locked
let r = await gate(req("/"), ctx); assert.strictEqual(r.status, 503);
r = await gate(req("/.netlify/functions/estimate-check", { method: "POST" }), ctx); assert.strictEqual(r.status, 503);

PASS = "demo-1234";
// no auth: login page / 401 json
r = await gate(req("/"), ctx); assert.strictEqual(r.status, 401); assert.match(await r.text(), /Enter the passcode/);
r = await gate(req("/.netlify/functions/estimate-check", { method: "POST" }), ctx); assert.strictEqual(r.status, 401); assert.match((await r.json()).error, /Passcode required/);

// wrong passcode
const form = (p, next = "/") => req("/__login", { method: "POST", body: new URLSearchParams({ passcode: p, next }) });
r = await gate(form("nope"), ctx); assert.strictEqual(r.status, 401); assert.match(await r.text(), /isn't right/);

// right passcode: cookie + redirect to next (only same-site paths)
r = await gate(form("demo-1234", "/?theme=color"), ctx);
assert.strictEqual(r.status, 303); assert.strictEqual(r.headers.get("location"), "/?theme=color");
const cookie = r.headers.get("set-cookie"); assert.match(cookie, /HttpOnly; Secure; SameSite=None; Partitioned/);
r = await gate(form("demo-1234", "//evil.com"), ctx); assert.strictEqual(r.headers.get("location"), "/");

// cookie gets in
const c = cookie.split(";")[0];
r = await gate(req("/", { headers: { cookie: c } }), ctx); assert.strictEqual(await r.text(), "PAGE");
// old cookie dies when the passcode changes
PASS = "new-5678"; r = await gate(req("/", { headers: { cookie: c } }), ctx); assert.strictEqual(r.status, 401); PASS = "demo-1234";

// ?key= link
r = await gate(req("/?key=demo-1234&theme=color"), ctx); assert.strictEqual(await r.text(), "PAGE"); assert.match(r.headers.get("set-cookie"), /a2z_bot_auth=/);
r = await gate(req("/?key=wrong"), ctx); assert.strictEqual(r.status, 401);

// webhooks: header or bearer
r = await gate(req("/.netlify/functions/estimate-check", { method: "POST", headers: { "x-bot-passcode": "demo-1234" } }), ctx); assert.strictEqual(r.status, 200);
r = await gate(req("/.netlify/functions/estimate-check", { method: "POST", headers: { authorization: "Bearer demo-1234" } }), ctx); assert.strictEqual(r.status, 200);
r = await gate(req("/.netlify/functions/estimate-check", { method: "POST", headers: { "x-bot-passcode": "demo-12345" } }), ctx); assert.strictEqual(r.status, 401);

// logout
r = await gate(req("/__logout"), ctx); assert.strictEqual(r.status, 303); assert.match(r.headers.get("set-cookie"), /Max-Age=0/);
console.log("passcode gate: all checks passed");
