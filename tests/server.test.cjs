// Sign-in (GHL + passcode), roles, admin, saved estimates and the protected estimating functions.
const test = require("node:test");
const assert = require("node:assert/strict");
const H = require("./helpers.cjs");
const fs = require("node:fs");
const path = require("node:path");

const GHL_USERS = [
  { id: "neeX5r7tAWikhEMzrFEC", name: "Jesse Pickar", email: "jesse@a2zcs.net" },
  { id: "IVFHrDqUqc7tkWwtmiXc", name: "Andie LaRue", email: "andie@a2zcs.net" },
  { id: "OUTSIDER000000000001", name: "Not Listed", email: "nobody@a2zcs.net" },
];
process.env.GHL_PIT_TOKEN = "pit";
global.fetch = async (url) => {
  if (String(url).includes("/users/?locationId=")) return { ok: true, status: 200, json: async () => ({ users: GHL_USERS }) };
  throw new Error("unexpected fetch " + url);
};

const session = H.fn("session"), admin = H.fn("admin"), estimates = H.fn("estimates"), data = H.fn("bot-data"), docs = H.fn("estimate-docs"), auto = H.fn("estimate-auto");
const as = (token) => ({ "x-a2z-session": token });
async function ghlSignIn(user) { return session(H.post({ action: "ghl", encryptedData: H.ghlContext(user) })); }
const CSV = fs.readFileSync(path.join(__dirname, "../tools/sample-takeoff.csv"), "utf8");

let jesse, andie, pass;
test("GHL sign-in: Jesse is senior admin, Andie estimator, outsiders turned away", async () => {
  let r = await ghlSignIn(GHL_USERS[0]); assert.equal(r.statusCode, 200);
  const j = H.body(r); jesse = j.token;
  assert.equal(j.isAdmin, true); assert.equal(j.isSenior, true); assert.match(r.headers["Set-Cookie"], /a2z_bot_session=.*HttpOnly; Secure; SameSite=None; Partitioned/);
  r = await ghlSignIn(GHL_USERS[1]); andie = H.body(r).token;
  assert.equal(H.body(r).role, "estimator"); assert.equal(H.body(r).isAdmin, false);
  r = await ghlSignIn(GHL_USERS[2]); assert.equal(r.statusCode, 403); assert.equal(H.body(r).auth, "no_access");
  r = await session(H.post({ action: "ghl", encryptedData: H.encrypt({ userId: "x", email: "a@b.c", activeLocation: H.LOC }, "wrong-secret") }));
  assert.equal(r.statusCode, 401);
});

test("passcode sign-in: right passcode + name works, estimator only; wrong passcode refused", async () => {
  let r = await session(H.post({ action: "passcode", name: "Field laptop", passcode: "nope" })); assert.equal(r.statusCode, 401);
  r = await session(H.post({ action: "passcode", name: "", passcode: process.env.ESTIMATING_BOT_PASSCODE })); assert.equal(r.statusCode, 400);
  r = await session(H.post({ action: "passcode", name: "Field laptop", passcode: process.env.ESTIMATING_BOT_PASSCODE }));
  assert.equal(r.statusCode, 200); const b = H.body(r); pass = b.token;
  assert.equal(b.role, "estimator"); assert.equal(b.isAdmin, false); assert.equal(b.via, "passcode");
  r = await session(H.get({}, as(pass))); assert.equal(H.body(r).signedIn, true); assert.equal(H.body(r).user.name, "Field laptop");
  r = await admin(H.get({ view: "access" }, as(pass))); assert.equal(r.statusCode, 403, "passcode users never get Admin");
});

test("everything is locked without a session; X-Bot-Passcode header works for webhooks", async () => {
  let r = await data(H.get()); assert.equal(r.statusCode, 401);
  r = await auto(H.post({ takeoffCsv: CSV })); assert.equal(r.statusCode, 401);
  r = await auto(H.post({ takeoffCsv: CSV }, { "x-bot-passcode": process.env.ESTIMATING_BOT_PASSCODE })); assert.equal(r.statusCode, 200);
  r = await auto(H.post({ takeoffCsv: CSV }, { "x-bot-passcode": "wrong" })); assert.equal(r.statusCode, 401);
  r = await data(H.get({}, as(andie))); assert.equal(r.statusCode, 200);
  const d = H.body(r); assert.ok(d.library.jobs.length > 50 && d.rates && d.production && d.style.estimators["Jesse Pickar"]);
});

test("changing the passcode signs passcode sessions out (GHL sessions stay)", async () => {
  const old = process.env.ESTIMATING_BOT_PASSCODE;
  process.env.ESTIMATING_BOT_PASSCODE = "a-new-longer-passcode-9";
  let r = await data(H.get({}, as(pass))); assert.equal(r.statusCode, 401);
  r = await data(H.get({}, as(jesse))); assert.equal(r.statusCode, 200);
  process.env.ESTIMATING_BOT_PASSCODE = old;
});

let savedId;
test("saved estimates: save, list, versions, reopen; delete is admin-only", async () => {
  let r = await auto(H.post({ takeoffCsv: CSV, job: { name: "Sample TI" } }, as(andie)));
  const est = H.body(r).estimate;
  r = await estimates(H.post({ action: "save", estimate: est, note: "first draft" }, as(andie)));
  assert.equal(r.statusCode, 200); savedId = H.body(r).id; assert.equal(H.body(r).version, 1);
  assert.equal(H.body(r).record.name, "Sample TI"); assert.equal(H.body(r).record.draft, true);
  est.markup = 1.5;
  r = await estimates(H.post({ action: "save", id: savedId, estimate: est }, as(jesse)));
  assert.equal(H.body(r).version, 2); assert.equal(H.body(r).record.updatedBy.name, "Jesse Pickar"); assert.equal(H.body(r).record.createdBy.name, "Andie LaRue");
  r = await estimates(H.get({}, as(pass ? jesse : jesse)));
  const list = H.body(r).estimates; assert.equal(list.length, 1); assert.equal(list[0].versionCount, 2); assert.ok(!("estimate" in list[0]));
  r = await estimates(H.get({ id: savedId }, as(andie))); assert.equal(H.body(r).estimate.markup, 1.5);
  r = await estimates(H.get({ id: savedId, v: "1" }, as(andie))); assert.equal(H.body(r).estimate.markup, 1.3);
  r = await estimates(H.post({ action: "delete", id: savedId }, as(andie))); assert.equal(r.statusCode, 403);
});

test("files are made from the edited estimate and audited; admin views work", async () => {
  let r = await estimates(H.get({ id: savedId }, as(jesse)));
  const est = H.body(r).estimate;
  est.job.estimator = "Jesse Pickar"; est.scopes[0].lines.push("Properly remove (E) door & frame (per plans A1.0)");
  r = await docs(H.post({ estimate: est, force: true }, as(jesse)));
  assert.equal(r.statusCode, 200); assert.match(H.body(r).proposalFileName, /^DRAFT - Sample TI - Proposal\.docx$/);
  r = await admin(H.get({ view: "audit" }, as(jesse)));
  const actions = H.body(r).entries.map((e) => e.action);
  for (const a of ["Saved estimate", "Ran autopilot", "Made files"]) assert.ok(actions.includes(a), a);
  r = await admin(H.get({ view: "access" }, as(jesse)));
  const me = H.body(r).users.find((u) => u.email === "jesse@a2zcs.net"); assert.equal(me.senior, true);
  r = await admin(H.get({ view: "health" }, as(jesse))); assert.equal(r.statusCode, 200);
  const ids = H.body(r).checks.map((c) => c.id); for (const id of ["signin", "passcode", "blobs", "engine", "estimates", "errors"]) assert.ok(ids.includes(id), id);
  r = await admin(H.get({ view: "activity", days: "30" }, as(jesse)));
  const row = H.body(r).byUser.find((u) => u.email === "jesse@a2zcs.net"); assert.ok(row.saves >= 1 && row.files >= 1);
  r = await admin(H.post({ action: "add", userId: "OUTSIDER000000000001", role: "estimator" }, as(jesse))); assert.equal(r.statusCode, 200);
  r = await admin(H.post({ action: "remove", email: "jesse@a2zcs.net" }, as(jesse))); assert.equal(r.statusCode, 409, "senior admin can't be removed");
  r = await estimates(H.post({ action: "delete", id: savedId }, as(jesse))); assert.equal(r.statusCode, 200);
});
