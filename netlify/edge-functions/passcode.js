// Passcode gate for the whole site: the page and all three functions.
// Set ESTIMATING_BOT_PASSCODE in Netlify (Site configuration, Environment variables), then redeploy.
// If it isn't set, the site stays locked (fails closed).
//
// Ways in:
//   1. Browser: the login screen sets a signed cookie for 30 days. Changing the passcode logs everyone out.
//   2. Link with ?key=<passcode> (for a GHL menu link, where some browsers block iframe cookies).
//   3. Webhooks / Make / GHL workflows: header  x-bot-passcode: <passcode>  or  Authorization: Bearer <passcode>.
// /__logout clears the cookie.

const COOKIE = "a2z_bot_auth";
const MAX_AGE = 60 * 60 * 24 * 30;
const enc = new TextEncoder();

async function tokenFor(passcode) {
  const key = await crypto.subtle.importKey("raw", enc.encode(passcode), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode("a2z-estimating-bot-v1"));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function same(a, b) {
  a = String(a || ""); b = String(b || "");
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function readCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return "";
}

// SameSite=None + Partitioned so the cookie also works inside the GHL iframe where the browser allows it.
const setCookie = (value, maxAge) =>
  `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=None; Partitioned`;

const safeNext = (n) => (typeof n === "string" && n.startsWith("/") && !n.startsWith("//") ? n : "/");

function loginPage(next, message, status = 401) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>A2Z Estimating Bot</title><meta name="robots" content="noindex">
<style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#141210;color:#f2ede8;font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:16px}
form{width:100%;max-width:340px;background:#1b1816;border:1px solid #3a3430;border-radius:12px;padding:24px;display:grid;gap:12px}
h1{margin:0;font-size:18px}p{margin:0;color:#9d948c;font-size:13px}
input{font:inherit;width:100%;padding:10px 12px;border-radius:8px;border:1px solid #3a3430;background:#221f1c;color:#f2ede8}
input:focus-visible,button:focus-visible{outline:2px solid #f97316;outline-offset:1px}
button{font:inherit;font-weight:600;padding:10px 12px;border-radius:8px;border:1px solid #ea580c;background:#ea580c;color:#fff;cursor:pointer}
button:hover{background:#f97316}.err{color:#ff8f87}
</style></head><body>
<form method="post" action="/__login">
<h1>A2Z Estimating Bot</h1>
<p>Enter the passcode to continue.</p>
${message ? `<p class="err">${esc(message)}</p>` : ""}
<input type="password" name="passcode" autocomplete="current-password" autofocus required aria-label="Passcode">
<input type="hidden" name="next" value="${esc(next)}">
<button type="submit">Open</button>
</form></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

export default async (request, context) => {
  const url = new URL(request.url);
  const passcode = (globalThis.Netlify && Netlify.env.get("ESTIMATING_BOT_PASSCODE")) || "";
  const isApi = url.pathname.startsWith("/.netlify/functions/");

  if (!passcode) {
    const msg = "Locked: set ESTIMATING_BOT_PASSCODE in Netlify, then redeploy.";
    return isApi
      ? Response.json({ error: msg }, { status: 503 })
      : new Response(msg, { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const token = await tokenFor(passcode);

  if (url.pathname === "/__logout") {
    return new Response(null, { status: 303, headers: { location: "/", "set-cookie": setCookie("", 0) } });
  }

  if (url.pathname === "/__login" && request.method === "POST") {
    const form = await request.formData();
    const next = safeNext(form.get("next"));
    if (same(form.get("passcode"), passcode)) {
      return new Response(null, { status: 303, headers: { location: next, "set-cookie": setCookie(token, MAX_AGE), "cache-control": "no-store" } });
    }
    await new Promise((r) => setTimeout(r, 600)); // slow down guessing
    return loginPage(next, "That passcode isn't right. Try again.");
  }

  // Already signed in, or a webhook with the passcode in a header.
  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (same(readCookie(request, COOKIE), token) || same(request.headers.get("x-bot-passcode"), passcode) || (bearer && same(bearer, passcode))) {
    return context.next();
  }

  // Link with ?key=<passcode> (GHL menu link). Serve the page and try to set the cookie too.
  const key = url.searchParams.get("key");
  if (key && same(key, passcode)) {
    const res = await context.next();
    const out = new Response(res.body, res);
    out.headers.append("set-cookie", setCookie(token, MAX_AGE));
    out.headers.set("referrer-policy", "no-referrer");
    out.headers.set("cache-control", "no-store");
    return out;
  }

  if (isApi) return Response.json({ error: "Passcode required (x-bot-passcode header)." }, { status: 401 });
  return loginPage(url.pathname + url.search, "");
};

export const config = { path: "/*" };
