// POST estimate JSON -> { ok, priced, issues }. A2Z's rules as code, no AI.
"use strict";
const { E, getAssets, json, parse } = require("../lib/engine");
exports.handler = async (event) => {
  try {
    const estimate = parse(event);
    return json(200, E.checkEstimate(estimate, { rates: getAssets().rates }));
  } catch (e) { return json(e.code || 400, { error: e.message }); }
};
