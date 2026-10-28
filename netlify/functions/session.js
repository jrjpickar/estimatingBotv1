// Estimating Bot sign-in (see netlify/lib/auth.js). Same as the Estimating Desk, plus the passcode.
//
//   GET  /.netlify/functions/session                          -> { signedIn, user, role, isAdmin, isSenior }
//   POST /.netlify/functions/session { action: "ghl", encryptedData }   (GHL Custom Page REQUEST_USER_DATA)
//   POST /.netlify/functions/session { action: "passcode", name, passcode }   (outside GHL; estimator-level)
//   POST /.netlify/functions/session { action: "signout" }

const {
  AuthError, authJson, authEnforced, currentSession, ghlUserFromContext, readAccess, writeAccess, findAccess,
  isSenior, signSession, signPasscodeSession, passcodeUser, passcodeValue, sessionCookie, clearSessionCookie, readSeen, markSeen, parseBody,
} = require("../lib/auth");
const { recordSignin } = require("../lib/activity");

// Sign-in history (Admin -> Sign-ins) skips repeat page loads within 30 minutes.
const SIGNIN_LOG_EVERY_MS = 30 * 60 * 1000;

function info(session) {
  if (!session) return { signedIn: false, user: null, role: null, isAdmin: false, isSenior: false, authEnforced: authEnforced(), passcodeOn: !!passcodeValue() };
  return {
    signedIn: true,
    user: { id: session.uid, name: session.name, email: session.email },
    via: session.via || "ghl_sso",
    role: session.role,
    hasAccess: !!session.role,
    isAdmin: session.role === "admin",
    isSenior: !!session.senior && session.role === "admin",
    authEnforced: authEnforced(),
    passcodeOn: !!passcodeValue(),
  };
}

exports.handler = async function (event) {
  try {
    if (event.httpMethod === "GET") return authJson(200, info(await currentSession(event)));
    if (event.httpMethod !== "POST") return authJson(405, { error: "GET or POST only" });
    const body = parseBody(event);
    if (body.action === "signout") return authJson(200, { ok: true, signedIn: false }, { "Set-Cookie": clearSessionCookie() });
    if (body.action === "passcode") {
      let user;
      try { user = passcodeUser(body.name, body.passcode); }
      catch (e) {
        if (e instanceof AuthError && e.code === "bad_passcode") {
          await new Promise((r) => setTimeout(r, 600)); // slow down guessing
          await recordSignin(event, { user: { id: "", name: String(body.name || "Unknown").slice(0, 60), email: "" }, result: "rejected", error: "Wrong passcode" });
        }
        throw e;
      }
      await recordSignin(event, { user: { ...user, email: "passcode" }, result: "ok" });
      const token = signPasscodeSession(user);
      return authJson(200, { ok: true, token, ...info({ uid: user.id, name: user.name, email: "", via: "passcode", role: "estimator", senior: false }) }, { "Set-Cookie": sessionCookie(token) });
    }
    if (body.action !== "ghl") return authJson(400, { error: "Unknown session action" });

    let user;
    try { user = ghlUserFromContext(body.encryptedData); }
    catch (e) {
      if (e instanceof AuthError && e.code !== "config") {
        await recordSignin(event, { user: null, result: "rejected", error: e.message });
      }
      throw e;
    }

    const users = await readAccess(event, { fresh: true });
    const entry = findAccess(users, { id: user.id, email: user.email });
    const seen = await readSeen(event, user.email);
    const quiet = seen && Date.now() - Date.parse(seen.at) < SIGNIN_LOG_EVERY_MS;

    if (!entry) {
      if (!quiet) await recordSignin(event, { user, result: "denied", error: "Not on the Estimating Bot access list" });
      await markSeen(event, user, { denied: true });
      return authJson(403, { error: "You don't have Estimating Bot access. Ask an A2Z admin to add you.", auth: "no_access", user });
    }

    // Keep the access list's name / GHL id current with what GHL says.
    if (entry.name !== user.name || entry.userId !== user.id) {
      const next = users.map((u) => (u === entry ? { ...u, name: user.name, userId: user.id } : u));
      await writeAccess(event, next).catch(() => {});
    }
    if (!quiet || (seen && seen.denied)) await recordSignin(event, { user, result: "ok" });
    await markSeen(event, user);

    const token = signSession(user);
    const session = { uid: user.id, name: user.name, email: user.email, role: entry.role === "admin" ? "admin" : "estimator", senior: isSenior(user) || isSenior(entry) };
    return authJson(200, { ok: true, token, ...info(session) }, { "Set-Cookie": sessionCookie(token) });
  } catch (e) {
    if (e instanceof AuthError) return authJson(e.status, { error: e.message, auth: e.code || "error" });
    return authJson(500, { error: "Sign-in failed", detail: String(e.message || e) });
  }
};
