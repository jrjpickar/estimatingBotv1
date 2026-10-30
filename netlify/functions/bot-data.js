// The data the page needs after sign-in: past-job library, rates, defaults, production table, house style, learned model.
// Kept behind sign-in (the library has customer names and bid prices), so it isn't built into the page.
"use strict";
const { protect, authJson } = require("../lib/auth");
const { getAssets } = require("../lib/engine");
const { readModel } = require("../lib/training");

async function inner(event) {
  const a = getAssets();
  const learned = await readModel(event); // what Training learned (null until something is uploaded)
  return authJson(200, { library: a.library, rates: a.rates, defaults: a.defaults, production: a.production, style: a.style, learned });
}
exports.handler = protect(inner);
