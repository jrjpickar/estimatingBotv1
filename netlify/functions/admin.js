// Admin view: access list, audit log, health, team activity, sign-ins (same as the Estimating Desk).
//
//   GET  ?view=access              -> { users, seniors, ghlUsers }             (admins)
//   GET  ?view=audit&limit=200     -> { entries }                              (admins)
//   GET  ?view=health              -> { overall, checks }                      (admins)
//   POST { action: "add", userId, role }       add a GHL user                  (admins; role "admin" = senior only)
//   POST { action: "remove", email }           remove access                   (admins; admins = senior only)
//   POST { action: "set_role", email, role }   estimator <-> admin             (senior admins)
//   GET  ?view=activity&days=30    -> { byUser, signins, metrics }             (admins)
//   POST { action: "ack", keys: [...] }        acknowledge failed audit entries (admins)
//   POST { action: "ack_all" }                 acknowledge every open error     (admins)
//   POST { action: "client_event", name, ok, target, detail, error }
//        logs a browser-side step (an autopilot run in the page) - any signed-in user
//
// The health panel reports whether each connection works right now. It does
// not show or manage token rotation.

const {
  protect, authJson, parseBody, readAccess, writeAccess, findAccess, isSenior, seniorEmails,
  logAudit, listAudit, ackAudit, isOpenError, readSeen, readHeartbeat, adminStore, authEnforced, locationId,
} = require("../lib/auth");
const { METRICS, listDated, statsByUser } = require("../lib/activity");
const { fetchLocationUsers } = require("../lib/ghl-users");
const { getAssets } = require("../lib/engine");
const { estimateStore } = require("../lib/estimates");

const CLIENT_EVENTS = new Set(["Ran autopilot"]);

const norm = (v) => String(v || "").trim().toLowerCase();
const isClientEvent = (event) => event.httpMethod === "POST" && parseBody(event).action === "client_event";

async function inner(event) {
  const session = event.a2zSession;
  try {
    if (event.httpMethod === "GET") {
      const view = (event.queryStringParameters || {}).view || "access";
      if (view === "access") return authJson(200, await accessView(event));
      if (view === "audit") {
        const limit = Math.min(500, Math.max(1, Number((event.queryStringParameters || {}).limit) || 200));
        return authJson(200, { entries: await listAudit(event, { limit }) });
      }
      if (view === "health") return authJson(200, await healthView(event));
      if (view === "activity") return authJson(200, await activityView(event));
      return authJson(400, { error: "Unknown view" });
    }
    if (event.httpMethod !== "POST") return authJson(405, { error: "GET or POST only" });
    const body = parseBody(event);
    if (body.action === "client_event") return await clientEvent(event, session, body);
    if (body.action === "add") return await addUser(event, session, body);
    if (body.action === "remove") return await removeUser(event, session, body);
    if (body.action === "set_role") return await setRole(event, session, body);
    if (body.action === "ack" || body.action === "ack_all") return await acknowledge(event, session, body);
    return authJson(400, { error: "Unknown admin action" });
  } catch (e) {
    return authJson(e.status || 500, { error: String(e.message || e) });
  }
}

exports.handler = protect(inner, { admin: (event) => !isClientEvent(event) });

/* ---------- Access ---------- */

async function accessView(event) {
  const users = await readAccess(event, { fresh: true });
  const withSeen = await Promise.all(users.map(async (u) => {
    const seen = await readSeen(event, u.email);
    return { ...u, lastSeenAt: seen ? seen.at : "", senior: isSenior(u) };
  }));
  withSeen.sort((a, b) => (a.role === b.role ? String(a.name).localeCompare(String(b.name)) : a.role === "admin" ? -1 : 1));
  let ghlUsers = [], ghlError = "";
  try { ghlUsers = (await fetchLocationUsers()).map((u) => ({ ...u, hasAccess: !!findAccess(users, u) })); }
  catch (e) { ghlError = String(e.message || e); }
  return { users: withSeen, seniors: seniorEmails(), ghlUsers, ghlError };
}

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

async function addUser(event, session, body) {
  const role = body.role === "admin" ? "admin" : "estimator";
  if (role === "admin" && !session.senior) throw fail("Only a senior admin can add admins.", 403);
  const id = String(body.userId || "").trim();
  if (!id) throw fail("Pick a GHL user.");
  const ghl = (await fetchLocationUsers()).find((u) => u.id === id);
  if (!ghl) throw fail("That GHL user was not found on the A2Z location.", 404);
  if (!ghl.email) throw fail("That GHL user has no email, so they can't sign in.");
  const users = await readAccess(event, { fresh: true });
  if (findAccess(users, ghl)) throw fail(`${ghl.name} already has Estimating Bot access.`, 409);
  const next = await writeAccess(event, [...users, { email: ghl.email, userId: ghl.id, name: ghl.name, role, addedBy: session.name, addedAt: new Date().toISOString() }]);
  await logAudit(event, session, { action: "Granted access", target: ghl.name, detail: { email: ghl.email, role } });
  return authJson(200, { ok: true, users: next });
}

async function removeUser(event, session, body) {
  const email = norm(body.email);
  const users = await readAccess(event, { fresh: true });
  const entry = users.find((u) => u.email === email);
  if (!entry) throw fail("That person isn't on the access list.", 404);
  if (isSenior(entry)) throw fail(`${entry.name} is a senior admin and can't be removed.`, 409);
  if (email === norm(session.email)) throw fail("You can't remove your own access.", 409);
  if (entry.role === "admin" && !session.senior) throw fail("Only a senior admin can remove an admin.", 403);
  const next = await writeAccess(event, users.filter((u) => u !== entry));
  await logAudit(event, session, { action: "Removed access", target: entry.name, detail: { email, role: entry.role } });
  return authJson(200, { ok: true, users: next });
}

async function setRole(event, session, body) {
  if (!session.senior) throw fail("Only a senior admin can change admin rights.", 403);
  const email = norm(body.email);
  const role = body.role === "admin" ? "admin" : "estimator";
  const users = await readAccess(event, { fresh: true });
  const entry = users.find((u) => u.email === email);
  if (!entry) throw fail("That person isn't on the access list.", 404);
  if (isSenior(entry) && role !== "admin") throw fail(`${entry.name} is a senior admin and always keeps admin rights.`, 409);
  if (entry.role === role) return authJson(200, { ok: true, users });
  const next = await writeAccess(event, users.map((u) => (u === entry ? { ...u, role } : u)));
  await logAudit(event, session, { action: role === "admin" ? "Made admin" : "Removed admin", target: entry.name, detail: { email } });
  return authJson(200, { ok: true, users: next });
}

async function clientEvent(event, session, body) {
  const name = String(body.name || "");
  if (!CLIENT_EVENTS.has(name)) return authJson(400, { error: "Unknown client event" });
  const detail = body.detail && typeof body.detail === "object" ? body.detail : {};
  await logAudit(event, session, { action: name, target: body.target, ok: body.ok !== false, error: body.error, detail: { ...detail, reportedBy: "browser" } });
  return authJson(200, { ok: true });
}

/* ---------- Health ---------- */

const envSet = (name) => !!String(process.env[name] || "").trim();

async function timed(fn) {
  const t = Date.now();
  try { const value = await fn(); return { ok: true, ms: Date.now() - t, value }; }
  catch (e) { return { ok: false, ms: Date.now() - t, error: String(e.message || e) }; }
}

function check(id, label, status, summary, items = []) { return { id, label, status, summary, items }; }
const item = (label, status, value) => ({ label, status, value });

async function healthView(event) {
  const since24h = Date.now() - 24 * 3600 * 1000;
  const audit = await listAudit(event, { limit: 400, days: 14 }).catch(() => []);
  const checks = await Promise.all([
    signinCheck(event),
    passcodeCheck(),
    ghlCheck(),
    blobsCheck(event),
    engineCheck(),
    estimatesCheck(event),
  ]);
  const openErrors = audit.filter(isOpenError);
  const recent = openErrors.filter((e) => Date.parse(e.at) >= since24h).length;
  const errCard = check("errors", "Open errors",
    openErrors.length ? (recent ? "bad" : "warn") : "ok",
    openErrors.length ? `${openErrors.length} failed action${openErrors.length === 1 ? "" : "s"} not yet acknowledged${recent ? ` (${recent} in the last 24 hours)` : ""}` : "Nothing open - failed actions show here until acknowledged",
    openErrors.slice(0, 12).map((e) => ({ ...item(`${e.action}${e.target ? " · " + e.target : ""}`, "bad", `${fmtPT(e.at)} · ${e.actor && e.actor.name ? e.actor.name + " · " : ""}${e.error || "failed"}`), key: e.key })));
  errCard.ackable = true;
  errCard.more = Math.max(0, openErrors.length - 12);
  checks.push(errCard);
  const rank = { ok: 0, warn: 1, bad: 2 };
  const worst = checks.reduce((w, c) => (rank[c.status] > rank[w] ? c.status : w), "ok");
  return { checkedAt: new Date().toISOString(), overall: worst, checks };
}

async function signinCheck(event) {
  const shared = envSet("GHL_APP_SHARED_SECRET"), sess = envSet("SESSION_SECRET"), enforced = authEnforced();
  const users = await readAccess(event).catch(() => []);
  const admins = users.filter((u) => u.role === "admin").length;
  const status = !shared || !sess || !enforced ? "bad" : "ok";
  return check("signin", "GHL auto sign-in", status,
    !enforced ? "AUTH_ENFORCE=off - anyone with the link can use the bot" : !shared || !sess ? "Sign-in is not configured" : `On · ${users.length} people with access (${admins} admin${admins === 1 ? "" : "s"})`,
    [
      item("GHL_APP_SHARED_SECRET", shared ? "ok" : "bad", shared ? "Set" : "Missing - GHL sign-in can't verify users"),
      item("SESSION_SECRET", sess ? "ok" : "bad", sess ? "Set" : "Missing - sessions can't be signed"),
      item("AUTH_ENFORCE", enforced ? "ok" : "bad", enforced ? "On" : "Off (break-glass mode)"),
      item("Location", "ok", locationId()),
    ]);
}

function passcodeCheck() {
  const on = envSet("ESTIMATING_BOT_PASSCODE");
  const len = String(process.env.ESTIMATING_BOT_PASSCODE || "").trim().length;
  const status = !on ? "warn" : len < 12 ? "warn" : "ok";
  return check("passcode", "Passcode sign-in (outside GHL)", status,
    !on ? "Off - only GHL sign-in works" : len < 12 ? "On, but the passcode is short (use 12+ characters)" : "On",
    [item("ESTIMATING_BOT_PASSCODE", on ? (len < 12 ? "warn" : "ok") : "warn", on ? `Set (${len} characters)` : "Not set"),
     item("Passcode sessions", "ok", "Estimator-level, no Admin; changing the passcode signs them out")]);
}

async function ghlCheck() {
  if (!envSet("GHL_PIT_TOKEN")) return check("ghl", "GHL users API", "warn", "GHL_PIT_TOKEN not set - add people by GHL user isn't available", [item("Needed for", "warn", "Admin -> Access: the list of GHL users to add")]);
  const users = await timed(fetchLocationUsers);
  return check("ghl", "GHL users API", users.ok ? "ok" : "bad", users.ok ? `Connected · ${users.value.length} users · ${users.ms} ms` : users.error);
}

function engineCheck() {
  try {
    const a = getAssets();
    return check("engine", "Estimating engine data", "ok", `Loaded · ${a.library.jobs.length} past jobs · default markup ${Math.round(a.defaults.markup * 100)}%`, [
      item("Job library", "ok", `${a.library.jobs.length} priced bids (${a.library.version || "?"})`),
      item("Production table", "ok", "Starter numbers (estimator/data/production.json)"),
      item("Templates", "ok", "Make master proposal v17 · Job Costing Worksheet V3"),
    ]);
  } catch (e) {
    return check("engine", "Estimating engine data", "bad", String(e.message || e));
  }
}

async function estimatesCheck(event) {
  const r = await timed(async () => (await estimateStore(event).list({ prefix: "estimates/" })).blobs.length);
  return check("estimates", "Saved estimates", r.ok ? "ok" : "bad", r.ok ? `${r.value} saved estimate${r.value === 1 ? "" : "s"}` : r.error);
}

async function blobsCheck(event) {
  // Netlify Blobs reads are eventually consistent by default: a read right
  // after a write can come back from the edge cache with the PREVIOUS value
  // for up to ~60s. That used to show up here as a red "Read-back did not
  // match" even though storage was fine. Read with strong consistency when
  // the runtime supports it, retry briefly, and only go red when the write
  // or the read actually fails.
  const r = await timed(async () => {
    const store = adminStore(event);
    const key = "health/probe";
    const stamp = new Date().toISOString();
    await store.setJSON(key, { stamp });
    const read = async () => {
      try { return await store.get(key, { type: "json", consistency: "strong" }); }
      catch (e) { return await store.get(key, { type: "json" }); }
    };
    let back = await read();
    for (let i = 0; i < 3 && (!back || back.stamp !== stamp); i++) {
      await new Promise((res) => setTimeout(res, 400));
      back = await read();
    }
    if (!back || !back.stamp) throw new Error("Wrote a test value but couldn't read anything back");
    return { fresh: back.stamp === stamp };
  });
  if (!r.ok) {
    return check("blobs", "Netlify Blobs storage", "bad", r.error,
      [item("Stores", "bad", "Saved estimates, access list, audit log")]);
  }
  const fresh = r.value.fresh;
  return check("blobs", "Netlify Blobs storage", "ok",
    fresh ? `Read/write OK · ${r.ms} ms` : `Read/write OK · ${r.ms} ms (read served from cache, catches up within a minute)`,
    [item("Stores", "ok", "Saved estimates, access list, audit log")]);
}

/* ---------- Acknowledge errors ---------- */

async function acknowledge(event, session, body) {
  let keys = Array.isArray(body.keys) ? body.keys.slice(0, 500) : [];
  if (body.action === "ack_all") {
    const audit = await listAudit(event, { limit: 1000, days: 14 });
    keys = audit.filter(isOpenError).map((e) => e.key);
  }
  if (!keys.length) return authJson(200, { ok: true, acknowledged: 0 });
  const count = await ackAudit(event, session, keys);
  if (count) await logAudit(event, session, { action: "Acknowledged errors", target: `${count} error${count === 1 ? "" : "s"}` });
  return authJson(200, { ok: true, acknowledged: count });
}

/* ---------- Team activity ---------- */

async function activityView(event) {
  const days = [7, 30, 90].includes(Number((event.queryStringParameters || {}).days)) ? Number(event.queryStringParameters.days) : 30;
  const [counts, signins, access] = await Promise.all([
    statsByUser(event, days),
    listDated(event, "signins", { days, limit: 500 }),
    readAccess(event).catch(() => []),
  ]);
  // Everyone on the access list gets a row, even with zero activity.
  const byEmail = Object.fromEntries(counts.map((r) => [r.email, r]));
  for (const u of access) {
    if (!byEmail[u.email]) byEmail[u.email] = { email: u.email, name: u.name, ...Object.fromEntries(Object.keys(METRICS).map((k) => [k, 0])) };
  }
  const signinBy = {};
  for (const e of signins) {
    const k = norm(e.user && e.user.email) || "unknown";
    const row = signinBy[k] || (signinBy[k] = { count: 0, denied: 0, last: "" });
    if (e.result === "ok") { row.count++; if (!row.last) row.last = e.at; } else row.denied++;
  }
  const byUser = Object.values(byEmail).map((r) => ({ ...r, signins: (signinBy[r.email] || {}).count || 0, lastSignin: (signinBy[r.email] || {}).last || "" }))
    .sort((a, b) => (b.autopilots + b.files + b.saves) - (a.autopilots + a.files + a.saves) || String(a.name).localeCompare(String(b.name)));
  return { days, metrics: METRICS, byUser, signins: signins.map(({ key, ...e }) => e) };
}

