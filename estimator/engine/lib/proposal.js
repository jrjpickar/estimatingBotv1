"use strict";
// Fill A2Z's proposal template (A2Z_Proposal_Template.docx, docxtemplater {{ }} tags) with the same
// engine Make's template step uses. Buffer in, buffer out (no file system).
const PizZip = require("../vendor/docx-vendor").PizZip;
const Docxtemplater = require("../vendor/docx-vendor").Docxtemplater;

const { proposalData, proposalFields } = require("./proposalData");

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

module.exports = { proposalData, proposalFields, fillProposal };
