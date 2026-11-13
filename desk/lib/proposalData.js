"use strict";
// Proposal fields for A2Z's proposal template (A2Z_Proposal_Template.docx).
// Pure (no file access) so the page's Proposal tab shows exactly what goes in the file.
//
// The template uses the same flat merge fields as the "Estimating" custom-field
// group in GHL and the Estimating Desk's Proposal Details form:
//   proposal_date, customer_company, job_address, estimate_number,
//   estimator_name, estimator_phone, estimator_email (header)
//   scope_name, scope_bullets1, scope_total1, scope_name2 ... scope_total3, exclusions, total_price
// The template holds at most 3 scopes. Notes, the standard exclusions list, terms
// and the signature block are fixed text in the template.
//
// proposalFields(p, style) -> { fields, doc, scopes, warnings }
//   fields: the Desk / GHL values (same formats the Desk writes: whole-dollar totals,
//           "• " bullets one per line, scope names / customer / address in caps)
//   doc:    what goes into the .docx ({{scope_total1}} "$18,228.00", "Total: ${{total_price}}" "18,228.00")
// proposalData(p, style) -> doc (kept for buildDocuments / fillProposal)
const { money2 } = require("./common");

const MAX_SCOPES = 3;
const FIELD_KEYS = ["proposal_date", "customer_company", "scope_name", "scope_name2", "scope_name3",
  "scope_bullets1", "scope_bullets2", "scope_bullets3", "total_price", "estimate_number", "exclusions",
  "scope_total1", "scope_total2", "scope_total3", "job_address"];
const UPPER = new Set(["scope_name", "scope_name2", "scope_name3", "customer_company", "job_address"]);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function proposalDate(v, now = new Date()) {
  const s = String(v || "").trim();
  let d = null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) d = new Date(+m[1], +m[2] - 1, +m[3]);
  else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/))) d = new Date(+m[3] < 100 ? 2000 + +m[3] : +m[3], +m[1] - 1, +m[2]);
  else if (s) { const t = Date.parse(s); if (!isNaN(t)) d = new Date(t); else return s; }
  else d = now;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

const bullet = (line) => "• " + String(line).replace(/^\s*(?:[•·\-*]|\d+[.)])\s*/, "").trim();
const bulletsText = (lines) => (lines || []).map((l) => String(l || "").trim()).filter(Boolean).map(bullet).join("\n");
const whole = (n) => (n == null || n === "" || isNaN(Number(n)) ? "" : String(Math.round(Number(n))));

function extraExclusions(p, style) {
  if (p.exclusions_extra_text != null) return String(p.exclusions_extra_text).trim();
  const base = String((style.template && style.template.exclusions_base) || style.exclusions || "").toLowerCase();
  const extra = [...new Set((p.extra_exclusions || []).map((x) => String(x).trim()).filter(Boolean))]
    .filter((x) => !base.includes(x.toLowerCase()));
  if (!extra.length) return "";
  const t = extra.join(", ");
  return /[.!]$/.test(t) ? t : t + ".";
}

function proposalFields(p, style = {}, { now = new Date() } = {}) {
  const job = p.job || {};
  const est = (style.estimators || {})[job.estimator || ""] || {};
  const warnings = [];
  const all = (p.scopes || []).filter((s) => s && (s.name || (s.lines || []).length));
  const alts = all.filter((s) => s.alternate);
  const base = all.filter((s) => !s.alternate);
  if (alts.length) warnings.push(`The proposal template has no alternate section, so ${alts.map((s) => s.name).join(", ")} is left off. Make it one of the scopes or a note.`);
  if (base.length > MAX_SCOPES) warnings.push(`The proposal template holds ${MAX_SCOPES} scopes; ${base.slice(MAX_SCOPES).map((s) => s.name).join(", ")} won't print. Combine scopes.`);
  const scopes = base.slice(0, MAX_SCOPES).map((s) => ({ ...s }));
  if (scopes.length === 1 && scopes[0].price == null) scopes[0].price = p.final_price;
  const total = p.final_price != null ? Number(p.final_price) : scopes.reduce((t, s) => t + Number(s.price || 0), 0);
  if (scopes.length > 1 && scopes.some((s) => s.price == null)) warnings.push("Give each scope a price when there are several scopes.");
  const sum = scopes.reduce((t, s) => t + Number(s.price || 0), 0);
  if (scopes.length > 1 && Math.abs(sum - total) > 0.5) warnings.push("Scope prices don't add up to the total.");

  const f = {
    proposal_date: proposalDate(job.date, now),
    customer_company: job.customer || "",
    estimate_number: job.estimate_number || "",
    exclusions: extraExclusions(p, style),
    total_price: whole(total),
    job_address: job.location || job.address || "",
  };
  const nameKey = (i) => (i === 0 ? "scope_name" : `scope_name${i + 1}`);
  for (let i = 0; i < MAX_SCOPES; i++) {
    const s = scopes[i];
    f[nameKey(i)] = s ? String(s.name || "") : "";
    f[`scope_bullets${i + 1}`] = s ? bulletsText(s.lines) : "";
    f[`scope_total${i + 1}`] = s ? whole(s.price) : "";
  }
  for (const k of UPPER) f[k] = String(f[k] || "").toUpperCase();
  const fields = {};
  for (const k of FIELD_KEYS) fields[k] = f[k] == null ? "" : f[k];

  const doc = {
    ...fields,
    estimator_name: job.estimator || "",
    estimator_phone: job.estimator_phone || est.phone || "",
    estimator_email: job.estimator_email || est.email || "",
    total_price: fields.total_price === "" ? "" : money2(Number(fields.total_price)).replace(/^\$/, ""),
  };
  for (let i = 1; i <= MAX_SCOPES; i++) doc[`scope_total${i}`] = fields[`scope_total${i}`] === "" ? "" : money2(Number(fields[`scope_total${i}`]));
  return { fields, doc, scopes, warnings };
}

const proposalData = (p, style, opts) => proposalFields(p, style, opts).doc;

module.exports = { proposalFields, proposalData, proposalDate, FIELD_KEYS, MAX_SCOPES };
