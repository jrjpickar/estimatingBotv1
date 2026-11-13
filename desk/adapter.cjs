'use strict';
const { parseStackCsv, prepareLibrary } = require('./lib/common');
const { autopilot } = require('./lib/autopilot');
const { checkEstimate } = require('./lib/checks');
const { findComps } = require('./lib/comps');
const { learnedJobs } = require('./lib/learn');
const { proposalFields } = require('./lib/proposalData');
const { slotMap } = require('./lib/costsheet');
const { reviewSheet } = require('./lib/auto');
const { runAutoEstimateWith } = require('./lib/autoRun');
const decisions = require('./lib/decisions');
const rates = require('./data/rates.json');
const production = require('./data/production.json');
const defaults = require('./data/defaults.json');
const style = require('./data/house_style.json');

const engine = { parseStackCsv, autopilot, checkEstimate, findComps, learnedJobs, proposalFields, slotMap, reviewSheet };
const assets = { rates, production, defaults, style, library: prepareLibrary({jobs: []}) };

function price({ csv, markup, name }) {
  const items = parseStackCsv(csv);
  if (!items.length) return null;
  const result = runAutoEstimateWith(engine, decisions, assets, {
    takeoffCsv: csv, markup, job: {name},
  });
  return {
    cost: result.price.cost, bid: result.price.bid, markup: result.price.markup,
    sections: result.sections.map(section => ({
      ...section, subtotal: result.costSheet.sections.find(s => s.section === section.name)?.subtotal ?? 0,
    })),
    scopeLines: result.scopeLines, proposalFields: result.proposalFields, items,
    warnings: [...new Set([...result.warnings, ...result.issues.map(issue => issue.message)])],
    questions: result.questions, costSheet: result.costSheet,
  };
}
module.exports = { price };
