// Team activity for Admin: per-user counts and sign-in history (same as the Estimating Desk).
// All in the Netlify Blobs store "a2z-estimating-bot-admin":
//   stats/<YYYY-MM>/<key>      per-user daily counters (autopilot drafts, files made, saves, sends)
//   signins/<YYYY-MM-DD>/...   one blob per sign-in (repeat loads within 30 min are skipped)

const crypto = require("node:crypto");


const norm = (v) => String(v || "").trim().toLowerCase();
const store = (event) => require("./auth").adminStore(event);
const rand = () => crypto.randomBytes(3).toString("hex");
const safe = (v) => encodeURIComponent(norm(v)).replace(/%/g, "_");

/* ---------- Dated lists ---------- */

async function listDated(event, prefix, { days = 30, limit = 500 } = {}) {
  const st = store(event);
  const keys = [];
  const now = Date.now();
  for (let d = 0; d < days && keys.length < limit; d++) {
    const day = new Date(now - d * 86400000).toISOString().slice(0, 10);
    const { blobs } = await st.list({ prefix: `${prefix}/${day}/` }).catch(() => ({ blobs: [] }));
    keys.push(...(blobs || []).map((b) => b.key).sort().reverse());
  }
  const picked = keys.slice(0, limit);
  const rows = await Promise.all(picked.map(async (k) => {
    const v = await st.get(k, { type: "json" }).catch(() => null);
    return v ? { ...v, key: k } : null;
  }));
  return rows.filter(Boolean).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

async function writeDated(event, prefix, entry) {
  const at = entry.at || new Date().toISOString();
  await store(event).setJSON(`${prefix}/${at.slice(0, 10)}/${at}-${rand()}`, { ...entry, at });
}

/* ---------- Per-user counters ---------- */

const METRICS = {
  autopilots: "Autopilot drafts",
  saves: "Estimates saved",
  files: "Proposal + job costing files made",
  sends: "Sent to Make",
};

// Which audit entries count toward which metric (successful ones only).
function metricFor(entry) {
  if (!entry || !entry.ok) return null;
  if (entry.action === "Ran autopilot") return "autopilots";
  if (entry.action === "Saved estimate") return "saves";
  if (entry.action === "Made files") return "files";
  if (entry.action === "Sent to Make") return "sends";
  return null;
}

async function bumpStat(event, actor, metric, at, { skipBackfill = false } = {}) {
  const who = (actor && (actor.email || actor.id)) || "";
  if (!who || !METRICS[metric]) return;
  try {
    const when = at || new Date().toISOString();
    // First counter ever written: count older audit history first (only
    // entries before this one, so nothing is counted twice).
    if (!skipBackfill) await backfillStats(event, when);
    const key = `stats/${when.slice(0, 7)}/${safe(who)}`;
    const st = store(event);
    const doc = (await st.get(key, { type: "json" }).catch(() => null)) || { email: norm(actor.email || who), name: actor.name || "", days: {} };
    const day = when.slice(0, 10);
    doc.name = actor.name || doc.name;
    doc.days[day] = doc.days[day] || {};
    doc.days[day][metric] = (doc.days[day][metric] || 0) + 1;
    await st.setJSON(key, doc);
  } catch (e) {
    console.error("Stat bump failed", e);
  }
}

// One-time: count what the audit log already held before live counters existed.
let backfillDone = false;
async function backfillStats(event, beforeIso) {
  if (backfillDone) return;
  const st = store(event);
  if (await st.get("stats/backfilled-v1", { type: "json" }).catch(() => null)) { backfillDone = true; return; }
  await st.setJSON("stats/backfilled-v1", { at: new Date().toISOString(), before: beforeIso });
  backfillDone = true;
  const entries = await listDated(event, "audit", { days: 120, limit: 5000 });
  for (const e of entries.reverse()) {
    if (String(e.at) >= beforeIso) continue;
    const metric = metricFor(e);
    if (metric) await bumpStat(event, e.actor, metric, e.at, { skipBackfill: true });
  }
}

async function statsByUser(event, days) {
  await backfillStats(event, new Date().toISOString()).catch((e) => console.error("Stat backfill failed", e));
  const st = store(event);
  const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  const months = new Set();
  for (let d = 0; d < days; d++) months.add(new Date(Date.now() - d * 86400000).toISOString().slice(0, 7));
  const byEmail = {};
  for (const m of months) {
    const { blobs } = await st.list({ prefix: `stats/${m}/` }).catch(() => ({ blobs: [] }));
    const docs = await Promise.all((blobs || []).map((b) => st.get(b.key, { type: "json" }).catch(() => null)));
    for (const doc of docs.filter(Boolean)) {
      const row = byEmail[doc.email] || (byEmail[doc.email] = { email: doc.email, name: doc.name, ...Object.fromEntries(Object.keys(METRICS).map((k) => [k, 0])) });
      if (doc.name) row.name = doc.name;
      for (const [day, counts] of Object.entries(doc.days || {})) {
        if (day < since) continue;
        for (const [k, n] of Object.entries(counts)) if (k in row) row[k] += n;
      }
    }
  }
  return Object.values(byEmail);
}

/* ---------- Sign-in history ---------- */

async function recordSignin(event, { user, result, error = "" }) {
  try {
    await writeDated(event, "signins", {
      user: user ? { id: user.id || "", name: user.name || "", email: user.email || "" } : { id: "", name: "Unknown", email: "" },
      result, error: String(error || "").slice(0, 200),
    });
  } catch (e) {
    console.error("Sign-in log failed", e);
  }
}

module.exports = {
  METRICS,
  bumpStat,
  listDated,
  metricFor,
  recordSignin,
  statsByUser,
  writeDated,
};
