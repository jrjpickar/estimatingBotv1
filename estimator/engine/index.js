"use strict";
// A2Z Estimator engine. Plain JavaScript (Node 18+), only dependencies are
// docxtemplater + pizzip. Every function takes data/Buffers and returns
// data/Buffers, so it runs the same in the Cowork plugin (bin/ CLIs) and in a
// Netlify function (require this file and pass the uploaded CSV / templates).
const fs = require("fs");
const path = require("path");
const common = require("./lib/common");
const { findComps, formatComps } = require("./lib/comps");
const { computeEstimate, formatEstimate, STANDARD_RATES } = require("./lib/price");
const { proposalData, fillProposal } = require("./lib/proposal");
const { fillJobCosting } = require("./lib/jobCosting");
const { checkEstimate, formatIssues, RULES } = require("./lib/checks");
const { autoEstimate, reviewSheet } = require("./lib/auto");
const { analyzePlans, pagesFromPdftotext } = require("./lib/plans");

const DATA = path.join(__dirname, "..", "data");

// Bundled assets (override any of them when calling from a Netlify function).
function loadAssets(dir = DATA) {
  return {
    library: common.prepareLibrary(JSON.parse(fs.readFileSync(path.join(dir, "job_library.json"), "utf8"))),
    style: JSON.parse(fs.readFileSync(path.join(dir, "house_style.json"), "utf8")),
    rates: JSON.parse(fs.readFileSync(path.join(dir, "rates.json"), "utf8")),
    proposalTemplate: fs.readFileSync(path.join(dir, "templates", "A2Z_Make_Master_Proposal_Template_v17.docx")),
    costingTemplate: fs.readFileSync(path.join(dir, "templates", "Job_Costing_Worksheet_V3.xlsx")),
  };
}

// One call for everything: priced estimate + comps -> both documents.
function buildDocuments(priced, comps, assets) {
  const proposal = fillProposal(assets.proposalTemplate, proposalData(priced, assets.style));
  const costing = fillJobCosting(assets.costingTemplate, priced, comps);
  return { proposal, costing: costing.buffer, notes: costing.notes };
}

module.exports = {
  loadAssets, buildDocuments, STANDARD_RATES,
  parseStackCsv: common.parseStackCsv, findComps, formatComps,
  computeEstimate, formatEstimate, checkEstimate, formatIssues, RULES, autoEstimate, reviewSheet, analyzePlans, pagesFromPdftotext, proposalData, fillProposal, fillJobCosting,
};
