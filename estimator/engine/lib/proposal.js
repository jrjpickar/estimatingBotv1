"use strict";
// Fill A2Z's Make master proposal template (docxtemplater, {{ }} tags) with the same
// engine Make's template step uses. Buffer in, buffer out (no file system).
const PizZip = require("../vendor/docx-vendor").PizZip;
const Docxtemplater = require("../vendor/docx-vendor").Docxtemplater;
const { money2 } = require("./common");

// priced estimate + house style -> the template's data object.
function proposalData(p, style) {
  const job = p.job || {};
  const est = (style.estimators || {})[job.estimator || ""] || {};
  const scopes = (p.scopes || []).map((s) => ({ ...s }));
  const base = scopes.filter((s) => !s.alternate);
  if (!base.length) throw new Error("No scope sections to put on the proposal.");
  if (base.length === 1 && base[0].price == null) base[0].price = p.final_price;
  const missing = base.filter((s) => s.price == null).map((s) => s.name);
  if (missing.length) throw new Error(`Give each scope a price when there are several scopes (missing: ${missing.join(", ")}).`);
  const sum = base.reduce((t, s) => t + Number(s.price), 0);
  if (Math.abs(sum - Number(p.final_price)) > 0.5) throw new Error("Scope prices don't add up to the final price.");
  const sections = scopes.map((s) => {
    const sec = { heading: s.name, body: (s.lines || []).join("\n") };
    if (s.price != null) {
      const label = s.amount_label || (s.alternate ? s.name.split(" - ")[0].toUpperCase() : s.name.toUpperCase()) + " TOTAL:";
      Object.assign(sec, { amount_label: label, amount_display: money2(s.price) });
    }
    return sec;
  });
  return {
    estimate_number: job.estimate_number || "",
    proposal_date: job.date || "",
    customer_block: String(job.customer || "").toUpperCase(),
    job_location_block: String(job.location || "").toUpperCase(),
    estimator_name: job.estimator || "",
    estimator_phone: job.estimator_phone || est.phone || "",
    estimator_email: job.estimator_email || est.email || "",
    opening_paragraph: p.opening_paragraph || style.intro,
    scope_sections: sections,
    remain_groups: (p.remain || []).map((g) => ({ area: g.area, items_text: (g.items || []).join("\n") })),
    notes: (p.notes || style.notes).map((text) => ({ text })),
    exclusions_text: p.exclusions || style.exclusions,
    subtotal_label: p.subtotal_label || "",
    subtotal_display: p.subtotal != null ? money2(p.subtotal) : "",
    grand_total_label: "TOTAL:",
    grand_total_display: money2(p.final_price),
    validity_text: p.validity_text || style.terms[0],
    payment_terms: p.payment_terms || style.terms[1],
    legal_footer: p.legal_footer || style.terms[2],
  };
}

function fillProposal(templateBuffer, data) {
  const zip = new PizZip(templateBuffer);
  const doc = new Docxtemplater(zip, {
    delimiters: { start: "{{", end: "}}" },
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: () => "",
  });
  try {
    doc.render(data);
  } catch (e) {
    const errs = (e.properties && e.properties.errors) || [e];
    throw new Error("Template error: " + errs.map((x) => (x.properties && x.properties.explanation) || x.message).join("; "));
  }
  // Parts with no {{tags}} (footer, styles, media...) go back byte-for-byte,
  // so only the filled parts differ from A2Z's master file.
  const original = new PizZip(templateBuffer);
  const filled = doc.getZip();
  for (const name of Object.keys(original.files)) {
    const f = original.files[name];
    if (f.dir) continue;
    const text = /\.(xml|rels)$/.test(name) ? f.asText() : null;
    if (text === null || !text.includes("{{")) filled.file(name, f.asUint8Array());
  }
  return filled.generate({ type: "nodebuffer", compression: "DEFLATE" });
}

module.exports = { proposalData, fillProposal };
