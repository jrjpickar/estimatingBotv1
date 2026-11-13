"use strict";
// A2Z Master Job List (the "Master Job Cost Database" Google Sheet, CSV export)
// -> past jobs for Auto Estimate's closest past bids (comps). Code only, no AI.
//
// Columns are matched by header name, so order does not matter:
//   Job / Address, Client, Estimator, Estimate #, Date, Doc Type / Version,
//   Job Status, Scope(s) Named, Direct Costs, Markups, Cost-Sheet Total ($),
//   Sent Proposal Total ($), Data Quality Flag, Notes
// A title row above the header is skipped.
//
// Every row gets a stable key (address + client + date + doc type + price), so
// the same sheet can be sent every week: rows already loaded are skipped.
// Revisions: a "Revised" row replaces the earlier rows of the same job group
// (address + client + bid/CO number) as a comp, so one job is not counted 3 times.
// Rows with no usable price (no price entered, merge failure, a total that
// doesn't match its own scopes, possible double billing, a cost sheet with no
// margin or a split bid) are kept for dedupe but never used as a comp.
const C = require("./common");

const HEADERS = {
  address: ["jobaddress", "job", "address", "jobname", "project"],
  client: ["client", "customer", "gc"],
  estimator: ["estimator"],
  estimate: ["estimate", "estimatenumber", "estimateno"],
  date: ["date", "proposaldate"],
  docType: ["doctypeversion", "doctype", "type", "version"],
  status: ["jobstatus", "status"],
  scope: ["scopesnamed", "scopenamed", "scope", "scopes", "scopeofwork"],
  direct: ["directcosts", "directcost"],
  markups: ["markups", "markup"],
  costTotal: ["costsheettotal", "costsheettotal$"],
  sentTotal: ["sentproposaltotal", "senttotal", "proposaltotal", "total"],
  flag: ["dataqualityflag", "flag", "flags"],
  notes: ["notes", "note"],
};
const normH = (h) => String(h || "").replace(/^\uFEFF/, "").toLowerCase().replace(/\(\$\)/g, "").replace(/[^a-z0-9]/g, "");

function mapHeaders(row) {
  const map = {};
  row.forEach((h, i) => {
    const n = normH(h);
    const key = Object.keys(HEADERS).find((k) => HEADERS[k].includes(n));
    if (key && map[key] === undefined) map[key] = i;
  });
  return map;
}

// "$9,715.20", "5,625", "(13,045.00)", 788.6 -> number; "-", "N/A ..." -> null.
function money(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s || /^n\/?a\b/i.test(s) || s === "-") return null;
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s);
  const n = parseFloat(s.replace(/[^0-9.]/g, ""));
  if (!isFinite(n)) return null;
  return neg ? -n : n;
}
// "2026-06-25", "7/10/2026", "2026-05-20 to 2026-06-05" -> "YYYY-MM-DD" (first date).
function isoDate(v) {
  const s = String(v || "").trim();
  let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) return `${m[3].length === 2 ? "20" + m[3] : m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return "";
}
const blankish = (v) => /^\(?(not filled in|not stated in doc|placeholder)/i.test(String(v || "").trim()) ? "" : String(v || "").trim();

const SKIP_WORDS = new Set(["n", "s", "e", "w", "north", "south", "east", "west", "calle", "el", "la", "via", "the"]);
// "14851 Yorba St, Tustin CA" and "Calle El Perfecto, 32891" -> "14851 yorba", "32891 perfecto".
function addressKey(address) {
  const head = String(address || "").split(/\s[\u2013\u2014-]\s/)[0].toLowerCase();
  // Leading street number ("4 Merrimac"), else the first 2 to 6 digit number.
  const num = (head.match(/^\s*(\d{1,6})\b/) || head.match(/\b(\d{2,6})\b/) || [])[1] || "";
  const words = head.replace(/\(.*?\)/g, " ").split(/[^a-z]+/).filter((w) => w.length > 1 && !SKIP_WORDS.has(w));
  return `${num} ${words[0] || ""}`.trim();
}
const clientKey = (c) => String(c || "").toLowerCase().replace(/\b(inc|llc|co|corp|construction|builders?|contractors?|carpentry|design)\b/g, "").replace(/[^a-z0-9]/g, "").slice(0, 12);

// Which document of the job: a change order (with its number), a numbered bid, or the proposal.
function docClass(row) {
  const text = `${row.address} ${row.docType} ${row.scope}`;
  const co = text.match(/\bCO\s*#?\s*(\d+)/i);
  if (/change order/i.test(row.docType) || co) {
    if (co) return `co${co[1]}`;
    return "co:" + String(row.scope || "").toLowerCase().replace(/[^a-z ]/g, "").split(/\s+/).filter(Boolean).slice(0, 3).join("-");
  }
  const bid = text.match(/\bBid\s*#\s*(\d+)/i);
  return bid ? `bid${bid[1]}` : "proposal";
}

// Flags that make the price unusable as a comp.
const BAD_PRICE = /TOTAL MISMATCH|NO PRICE|MERGE FAILURE|DUPLICATE BILLING|ZERO MARGIN|SPLIT-BID/i;

function outcomeOf(status) {
  const s = String(status || "").toLowerCase();
  if (/active|completed|won|awarded|billed|accepted/.test(s)) return "won";
  if (/lost|declined|cancel/.test(s)) return "lost";
  return "open";
}

function hashKey(s) {
  // FNV-1a 32 bit, base 36 (short and stable; no crypto needed in the engine).
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

// CSV text -> { rows: [master row], header: bool, skipped: [{line, reason}] }
function parseMasterCsv(text) {
  const table = C.parseCsv(String(text || "").replace(/^\uFEFF/, ""), { raw: true }).filter((r) => r.some((v) => String(v).trim()));
  let at = table.findIndex((r) => { const m = mapHeaders(r); return m.address !== undefined && (m.sentTotal !== undefined || m.costTotal !== undefined); });
  if (at < 0) return { rows: [], header: false, skipped: [] };
  const map = mapHeaders(table[at]);
  const get = (cells, k) => (map[k] === undefined ? "" : String(cells[map[k]] == null ? "" : cells[map[k]]).replace(/\s+/g, " ").trim());
  const rows = [], skipped = [];
  table.slice(at + 1).forEach((cells, i) => {
    const line = at + i + 2;
    const address = get(cells, "address");
    if (!address) { skipped.push({ line, reason: "no job / address" }); return; }
    const row = {
      address, client: blankish(get(cells, "client")), estimator: blankish(get(cells, "estimator")),
      estimate: blankish(get(cells, "estimate")), date: isoDate(get(cells, "date")), docType: get(cells, "docType"),
      status: get(cells, "status"), scope: get(cells, "scope"), direct: money(get(cells, "direct")), markups: money(get(cells, "markups")),
      costTotal: money(get(cells, "costTotal")), sentTotal: money(get(cells, "sentTotal")), flag: get(cells, "flag"), notes: get(cells, "notes"),
      line,
    };
    row.key = "m" + hashKey([addressKey(row.address) || row.address.toLowerCase(), clientKey(row.client), row.date, normH(row.docType), docClass(row), row.sentTotal ?? "", row.costTotal ?? ""].join("|"));
    row.group = [addressKey(row.address) || row.address.toLowerCase().replace(/[^a-z0-9]/g, ""), clientKey(row.client), docClass(row)].join("|");
    row.revision = /revis/i.test(`${row.docType} ${row.address}`);
    const sent = row.sentTotal != null && row.sentTotal > 0 ? row.sentTotal : null;
    const cost = row.costTotal != null && row.costTotal > 0 ? row.costTotal : null;
    row.price = BAD_PRICE.test(row.flag) ? null : (sent ?? cost);
    row.priceFrom = row.price == null ? "" : sent != null ? "sent proposal" : "cost sheet";
    rows.push(row);
  });
  return { rows, header: true, skipped };
}

// Same rows in one file (same key) are kept once.
function uniqueRows(rows) {
  const seen = new Set();
  return rows.filter((r) => (seen.has(r.key) ? false : (seen.add(r.key), true)));
}

// A master row -> a library job (comps shape, see job_library.json).
function rowToJob(r) {
  return {
    id: "master:" + r.key,
    name: r.address.toUpperCase(),
    customer: r.client,
    date: r.date,
    sentTotal: r.price,
    priceSource: `master job list (${r.priceFrom || "no price"})`,
    priceStatus: r.flag ? `flag: ${r.flag}` : "master",
    outcome: outcomeOf(r.status),
    stages: r.status ? [r.status] : [],
    scopeTotals: [],
    scopeText: r.scope,
    takeoff: [],
    source: "master",
    group: r.group,
    revision: r.revision,
    docType: r.docType,
    costTotal: r.costTotal,
    directCosts: r.direct,
    markups: r.markups,
  };
}

// Library jobs from master rows: priced rows only, revisions replace the
// earlier rows of their group, ids unique. Non-master jobs pass through.
function mergeMasterJobs(jobs) {
  const out = [], seenIds = new Set();
  const byGroup = new Map();
  for (const j of jobs || []) {
    if (!j || seenIds.has(j.id)) continue;
    seenIds.add(j.id);
    if (j.source !== "master") { out.push(j); continue; }
    if (j.sentTotal == null || !(j.sentTotal > 0)) continue;
    const list = byGroup.get(j.group) || [];
    list.push(j);
    byGroup.set(j.group, list);
  }
  for (const list of byGroup.values()) {
    list.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    // The latest revision wins; rows after it (non revisions) still count.
    let lastRev = -1;
    list.forEach((j, i) => { if (j.revision) lastRev = i; });
    list.forEach((j, i) => {
      if (lastRev >= 0 && i < lastRev) return; // replaced by a later revision
      out.push(j);
    });
  }
  return out;
}

module.exports = { parseMasterCsv, uniqueRows, rowToJob, mergeMasterJobs, addressKey, mapHeaders, money, isoDate };
