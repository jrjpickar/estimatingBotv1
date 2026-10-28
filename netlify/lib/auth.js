// Estimating Bot sign-in, access list, audit log. Same code and rules as the
// A2Z Estimating Desk (and the Dispatch Board / Triple Line dialer), plus a
// passcode sign-in for use outside GHL.
//
// Automatic (inside GHL): the desk runs as a Custom Page of A2Z's private GHL
// Marketplace app. On load it asks its GHL parent frame for REQUEST_USER_DATA;
// GHL answers with the logged-in user's details encrypted with the app's
// Shared Secret. session.js decrypts that with GHL_APP_SHARED_SECRET, checks
// the A2Z location and the Estimating access list, and issues a signed
// session. Nobody can fake it without the Shared Secret.
//
// Outside GHL (bookmark): a session issued inside GHL keeps working for 7
// days. Without one, the bot asks for the passcode (ESTIMATING_BOT_PASSCODE).
// A passcode session is estimator-level: it can use the bot but never the
// Admin view, and changing the passcode signs every passcode session out.
// Server-to-server calls (Make, GHL workflows) can send the passcode in an
// X-Bot-Passcode header instead of a session.
//
// The session travels as a signed token in the X-A2Z-Session header (GHL's
// iframe can block cookies) plus an HttpOnly cookie as a backup.
//
// Access: only people on the Estimating access list can use the desk. Admins
// manage that list; senior admins (jesse@a2zcs.net, always, plus
// SENIOR_ADMINS) are the only ones who can make or remove admins, and can
// never be removed or demoted. Removing someone cuts them off within ~30s.
//
// Storage: Netlify Blobs store "a2z-estimating-admin".
//   access/users            the access list
//   seen/<email>            last sign-in per user
//   audit/<YYYY-MM-DD>/...  one blob per audit entry
//   health/<name>           heartbeats (e.g. the hourly reminder run)

const crypto = require("node:crypto");
const { connectLambda, getStore } = require("./blobs-lite");

const STORE_NAME = "a2z-estimating-bot-admin";
const ACCESS_KEY = "access/users";
const SESSION_HEADER = "x-a2z-session";
const SESSION_COOKIE = "a2z_bot_session";
const SESSION_TTL = 7 * 24 * 3600;
const DEFAULT_LOCATION_ID = "QUcu2PEAxPV1sQm1GQCq";
const OWNER_EMAIL = "jesse@a2zcs.net";

// First-run seed: the four people who had the hardcoded ALLOWED_EMAILS
// access before the access list existed.
const SEED_USERS = [
  { email: "jesse@a2zcs.net", userId: "neeX5r7tAWikhEMzrFEC", name: "Jesse Pickar", role: "admin" }, // senior admin (owner failsafe below)
  { email: "andie@a2zcs.net", userId: "IVFHrDqUqc7tkWwtmiXc", name: "Andie LaRue", role: "estimator" },
  { email: "artjr@a2zcs.net", userId: "f0F0V9svKgyPNLzpOF0O", name: "Art Vasquez Jr", role: "estimator" },
  { email: "zeth@a2zcs.net", userId: "fNhN4arY1FHzT8QgSBn1", name: "Zeth Vasquez", role: "estimator" },
];

class AuthError extends Error {
  constructor(message, status = 400, code = "") { super(message); this.status = status; this.code = code; }
}

const norm = (v) => String(v || "").trim().toLowerCase();
const locationId = () => String(process.env.GHL_LOCATION_ID || DEFAULT_LOCATION_ID).trim();
const authEnforced = () => norm(process.env.AUTH_ENFORCE) !== "off";

/* ---------- Blobs ---------- */

function adminStore(event) {
  if (event && event.blobs) {
    try { connectLambda(event); } catch (e) { /* fall through to env fallback */ }
  }
  const siteID = process.env.BLOBS_SITE_ID;
  const token = process.env.BLOBS_TOKEN;
  if ((!event || !event.blobs) && siteID && token) return getStore({ name: STORE_NAME, siteID, token });
  return getStore(STORE_NAME);
}

/* ---------- Signed sessions ---------- */

function sessionSecret() {
  const value = String(process.env.SESSION_SECRET || "").trim();
  if (!value) throw new AuthError("SESSION_SECRET is not set in Netlify, so sign-in is off.", 503, "config");
  return value;
}
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
const sign = (body) => crypto.createHmac("sha256", "estimating-bot-session:" + sessionSecret()).update(body).digest("base64url");

function signSession(user, extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = b64({ uid: user.id, name: user.name, email: user.email, via: "ghl_sso", iat: now, exp: now + SESSION_TTL, ...extra });
  return `${body}.${sign(body)}`;
}

function verifySession(token) {
  const [body, signature] = String(token || "").split(".");
  if (!body || !signature) return null;
  let expected;
  try { expected = sign(body); } catch (e) { return null; }
  const a = Buffer.from(signature), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch (e) { return null; }
  if (!payload || !payload.uid || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function header(event, name) {
  const h = (event && event.headers) || {};
  const want = name.toLowerCase();
  for (const k of Object.keys(h)) if (k.toLowerCase() === want) return h[k];
  return "";
}
function readCookie(event, name) {
  for (const part of String(header(event, "cookie") || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return "";
}
const tokenFromEvent = (event) => header(event, SESSION_HEADER) || readCookie(event, SESSION_COOKIE);

// SameSite=None + Partitioned so the cookie also works inside GHL's iframe.
const sessionCookie = (token) => `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_TTL}; HttpOnly; Secure; SameSite=None; Partitioned`;
const clearSessionCookie = () => `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None; Partitioned`;

/* ---------- GHL encrypted user context ---------- */

// CryptoJS AES ("Salted__" + OpenSSL EVP_BytesToKey), same as the dialer's
// decryptGhlUserData and the Dispatch Board's lib/session.mjs.
function decryptGhlUserData(encryptedData, passphrase) {
  const raw = Buffer.from(String(encryptedData || ""), "base64");
  if (raw.length < 17 || raw.subarray(0, 8).toString("ascii") !== "Salted__") throw new Error("Invalid encrypted context");
  const salt = raw.subarray(8, 16), password = Buffer.from(passphrase), blocks = [];
  let previous = Buffer.alloc(0);
  while (Buffer.concat(blocks).length < 48) {
    previous = crypto.createHash("md5").update(Buffer.concat([previous, password, salt])).digest();
    blocks.push(previous);
  }
  const material = Buffer.concat(blocks);
  const decipher = crypto.createDecipheriv("aes-256-cbc", material.subarray(0, 32), material.subarray(32, 48));
  return Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString("utf8");
}

function ghlUserFromContext(encryptedData) {
  const secretValue = String(process.env.GHL_APP_SHARED_SECRET || "").trim();
  if (!secretValue) throw new AuthError("GHL_APP_SHARED_SECRET is not set in Netlify, so automatic GHL sign-in is off.", 503, "config");
  if (typeof encryptedData !== "string" || !encryptedData || encryptedData.length > 20000) throw new AuthError("Encrypted GHL user context is required.", 400);
  let user;
  try { user = JSON.parse(decryptGhlUserData(encryptedData, secretValue)); }
  catch (e) { throw new AuthError("GHL user context could not be verified. Check GHL_APP_SHARED_SECRET matches the Marketplace app.", 401, "bad_context"); }
  if (!user || !user.userId || !user.email) throw new AuthError("GHL user context is incomplete.", 401, "bad_context");
  if (!user.activeLocation || user.activeLocation !== locationId()) throw new AuthError("This GHL user is not in the A2Z location.", 403, "wrong_location");
  return { id: String(user.userId), name: String(user.userName || user.email), email: norm(user.email) };
}

/* ---------- Access list ---------- */

// Same rules as the Dispatch Board's lib/session.mjs: SENIOR_ADMINS (or the
// older name BOOTSTRAP_ADMINS) lists names, emails or GHL user ids. A blank
// env var counts as unset. Failsafe: the owner (jesse@a2zcs.net, GHL user
// neeX5r7tAWikhEMzrFEC, "Jesse Pickar") is ALWAYS a senior admin, even if the
// env var is deleted, blanked or typed wrong.
const OWNER_KEYS = [OWNER_EMAIL, "neeX5r7tAWikhEMzrFEC", "jesse pickar"].map(norm);
function seniorKeys() {
  const configured = [process.env.SENIOR_ADMINS, process.env.BOOTSTRAP_ADMINS].find((v) => String(v || "").trim());
  const list = String(configured || "").split(",").map(norm).filter(Boolean);
  return [...new Set([...OWNER_KEYS, ...list])];
}
const seniorEmails = () => seniorKeys().filter((k) => k.includes("@"));
// Accepts a user/session/access entry, or a bare email string.
function isSenior(who) {
  if (!who) return false;
  const keys = seniorKeys();
  if (typeof who === "string") return keys.includes(norm(who));
  return [who.email, who.userId, who.id, who.uid, who.name].some((v) => v && keys.includes(norm(v)));
}

function withSeniors(users) {
  const list = (users || []).map((u) => ({ ...u, email: norm(u.email) }));
  // Anyone matching a senior key by name or GHL id is admin too.
  for (const u of list) if (isSenior(u)) u.role = "admin";
  for (const email of seniorEmails()) {
    const found = list.find((u) => u.email === email);
    if (found) found.role = "admin";
    else {
      const seed = SEED_USERS.find((u) => u.email === email);
      list.push({ email, userId: seed ? seed.userId : "", name: seed ? seed.name : email, role: "admin", addedBy: "senior", addedAt: new Date().toISOString() });
    }
  }
  return list;
}

let accessCache = { at: 0, users: null };
async function readAccess(event, { fresh = false } = {}) {
  if (!fresh && accessCache.users && Date.now() - accessCache.at < 30 * 1000) return accessCache.users;
  const store = adminStore(event);
  let doc = await store.get(ACCESS_KEY, { type: "json" }).catch(() => null);
  if (!doc || !Array.isArray(doc.users)) {
    doc = { users: SEED_USERS.map((u) => ({ ...u, addedBy: "seed", addedAt: new Date().toISOString() })), updatedAt: new Date().toISOString() };
    await store.setJSON(ACCESS_KEY, doc);
  }
  const users = withSeniors(doc.users);
  accessCache = { at: Date.now(), users };
  return users;
}
async function writeAccess(event, users) {
  const clean = withSeniors(users);
  await adminStore(event).setJSON(ACCESS_KEY, { users: clean, updatedAt: new Date().toISOString() });
  accessCache = { at: Date.now(), users: clean };
  return clean;
}
function findAccess(users, { id, uid, email }) {
  const e = norm(email), i = String(id || uid || "");
  return users.find((u) => (e && u.email === e) || (i && u.userId && u.userId === i)) || null;
}

/* ---------- Passcode (outside GHL) ---------- */

const passcodeValue = () => String(process.env.ESTIMATING_BOT_PASSCODE || "").trim();
// A short fingerprint of the current passcode rides in the session, so changing
// the passcode signs every passcode session out.
const passcodePrint = () => crypto.createHmac("sha256", "bot-passcode:" + sessionSecret()).update(passcodeValue()).digest("base64url").slice(0, 16);
function sameText(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function passcodeUser(name, code) {
  if (!passcodeValue()) throw new AuthError("The passcode isn't set up (ESTIMATING_BOT_PASSCODE in Netlify). Open the bot from GHL instead.", 503, "config");
  if (!sameText(code, passcodeValue())) throw new AuthError("That passcode isn't right.", 401, "bad_passcode");
  const clean = String(name || "").trim().slice(0, 60);
  if (!clean) throw new AuthError("Enter your name so the audit log shows who did what.", 400, "name");
  return { id: "passcode:" + norm(clean).replace(/[^a-z0-9]+/g, "-"), name: clean, email: "" };
}
function signPasscodeSession(user) { return signSession(user, { via: "passcode", pv: passcodePrint() }); }

/* ---------- Guards ---------- */

function authJson(statusCode, body, extraHeaders = {}) {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extraHeaders }, body: JSON.stringify(body) };
}

// Resolves the caller's session against the live access list.
async function currentSession(event) {
  // Server-to-server: X-Bot-Passcode header (Make, GHL workflows).
  const headerCode = header(event, "x-bot-passcode");
  if (headerCode && passcodeValue() && sameText(headerCode, passcodeValue())) {
    return { uid: "webhook", name: "Webhook (passcode)", email: "", via: "passcode_header", role: "estimator", senior: false };
  }
  const payload = verifySession(tokenFromEvent(event));
  if (!payload) return null;
  if (payload.via === "passcode") {
    if (!passcodeValue() || payload.pv !== passcodePrint()) return null; // passcode changed or removed
    return { ...payload, role: "estimator", senior: false };
  }
  const users = await readAccess(event);
  const entry = findAccess(users, payload);
  if (!entry) return { ...payload, role: null, senior: false };
  const senior = isSenior(payload) || isSenior(entry);
  return { ...payload, role: senior || entry.role === "admin" ? "admin" : "estimator", senior };
}

// Returns { session } or { response } (a ready 401/403/503 to return).
async function guard(event, { admin = false } = {}) {
  let session;
  try { session = await currentSession(event); }
  catch (e) {
    if (e instanceof AuthError) return { response: authJson(e.status, { error: e.message, auth: e.code || "error" }) };
    return { response: authJson(500, { error: "Sign-in check failed", detail: String(e.message || e), auth: "error" }) };
  }
  if (!session && !authEnforced() && !admin) {
    // Break-glass: AUTH_ENFORCE=off lets the desk run unsigned (never admin).
    return { session: { uid: "", name: "Unsigned (AUTH_ENFORCE=off)", email: "", role: "estimator", senior: false, bypass: true } };
  }
  if (!session) return { response: authJson(401, { error: "Sign in to the Estimating Bot first: open it from GHL, or use the passcode.", auth: "signin" }) };
  if (!session.role) return { response: authJson(403, { error: "You don't have Estimating Bot access. Ask an A2Z admin to add you.", auth: "no_access" }) };
  if (admin && session.role !== "admin") return { response: authJson(403, { error: "Only admins can do that.", auth: "not_admin" }) };
  return { session };
}

// Wraps an existing Lambda-style handler with the sign-in check and an
// optional audit entry. The inner handler runs unchanged; event.a2zSession
// carries the signed-in user.
//   open(event)  -> true to skip the check (e.g. Make's secret-gated POSTs)
//   admin        -> boolean or (event) => boolean
//   audit(event, res, session) -> an audit entry or null
function protect(inner, { open = null, admin = false, audit = null } = {}) {
  return async function (event, context) {
    if (event.httpMethod === "OPTIONS") return inner(event, context);
    if (open && open(event)) return inner(event, context);
    const needAdmin = typeof admin === "function" ? !!admin(event) : !!admin;
    const auth = await guard(event, { admin: needAdmin });
    if (auth.response) return auth.response;
    event.a2zSession = auth.session;
    const res = await inner(event, context);
    if (audit) {
      let entry = null;
      try { entry = audit(event, res, auth.session); } catch (e) { entry = null; }
      if (entry) await logAudit(event, auth.session, entry);
    }
    return res;
  };
}

/* ---------- Audit log ---------- */

function parseBody(event) {
  try { return JSON.parse(event.body || "{}") || {}; } catch (e) { return {}; }
}
function resOk(res) { return !!res && res.statusCode >= 200 && res.statusCode < 300; }
function resError(res) {
  if (resOk(res)) return "";
  try { const b = JSON.parse(res.body || "{}"); return String(b.error || b.detail || `HTTP ${res.statusCode}`).slice(0, 300); }
  catch (e) { return `HTTP ${res && res.statusCode}`; }
}

// Never throws - a failed audit write must not block the real action.
async function logAudit(event, session, { action, target = "", detail = {}, ok = true, error = "" }) {
  try {
    const at = new Date().toISOString();
    const entry = {
      at,
      actor: { id: (session && session.uid) || "", name: (session && session.name) || "", email: (session && session.email) || "" },
      action: String(action || "").slice(0, 80),
      target: String(target || "").slice(0, 200),
      ok: !!ok,
      error: String(error || "").slice(0, 300),
      detail: detail && typeof detail === "object" ? detail : {},
    };
    const key = `audit/${at.slice(0, 10)}/${at}-${crypto.randomBytes(3).toString("hex")}`;
    await adminStore(event).setJSON(key, entry);
    // Per-user counters for Admin -> Team activity.
    const activity = require("./activity");
    const metric = activity.metricFor(entry);
    if (metric) await activity.bumpStat(event, entry.actor, metric, at);
  } catch (e) {
    console.error("Audit log write failed", e);
  }
}

// Entries come back newest first, each with its blob `key` (used to acknowledge it).
async function listAudit(event, { limit = 200, days = 60 } = {}) {
  return require("./activity").listDated(event, "audit", { limit, days });
}

// Sign-in events aren't system errors; they live in Admin -> Sign-ins.
const SIGNIN_ACTIONS = new Set(["Signed in", "Access denied", "Sign-in rejected"]);
const isOpenError = (e) => !!e && !e.ok && !e.ack && !SIGNIN_ACTIONS.has(e.action);

// Marks failed audit entries as acknowledged so they drop off the Health panel.
async function ackAudit(event, session, keys) {
  const store = adminStore(event);
  const by = { name: (session && session.name) || "", email: (session && session.email) || "", at: new Date().toISOString() };
  let count = 0;
  for (const key of keys) {
    if (typeof key !== "string" || !/^audit\/\d{4}-\d{2}-\d{2}\//.test(key)) continue;
    const entry = await store.get(key, { type: "json" }).catch(() => null);
    if (!entry || entry.ok || entry.ack) continue;
    entry.ack = by;
    await store.setJSON(key, entry);
    count++;
  }
  return count;
}

/* ---------- Last seen + heartbeats ---------- */

const seenKey = (email) => `seen/${encodeURIComponent(norm(email)).replace(/%/g, "_")}`;
async function readSeen(event, email) {
  return adminStore(event).get(seenKey(email), { type: "json" }).catch(() => null);
}
async function markSeen(event, user, extra = {}) {
  await adminStore(event).setJSON(seenKey(user.email), { at: new Date().toISOString(), id: user.id, name: user.name, ...extra }).catch(() => {});
}
async function writeHeartbeat(event, name, data) {
  try { await adminStore(event).setJSON(`health/${name}`, { at: new Date().toISOString(), ...data }); }
  catch (e) { console.error("Heartbeat write failed", e); }
}
async function readHeartbeat(event, name) {
  return adminStore(event).get(`health/${name}`, { type: "json" }).catch(() => null);
}

module.exports = {
  AuthError,
  OWNER_EMAIL,
  SESSION_HEADER,
  adminStore,
  authEnforced,
  authJson,
  clearSessionCookie,
  currentSession,
  decryptGhlUserData,
  findAccess,
  ghlUserFromContext,
  guard,
  isSenior,
  listAudit,
  ackAudit,
  isOpenError,
  locationId,
  logAudit,
  markSeen,
  parseBody,
  passcodeUser,
  passcodeValue,
  protect,
  readAccess,
  readHeartbeat,
  readSeen,
  resError,
  resOk,
  seniorEmails,
  sessionCookie,
  signPasscodeSession,
  signSession,
  verifySession,
  writeAccess,
  writeHeartbeat,
};
