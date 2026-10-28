// The data the page needs after sign-in: past-job library, rates, defaults, production table, house style.
// Kept behind sign-in (the library has customer names and bid prices), so it isn't built into the page.
"use strict";
const { protect, authJson } = require("../lib/auth");
const { getAssets } = require("../lib/engine");

async function inner() {
  const a = getAssets();
  return authJson(200, { library: a.library, rates: a.rates, defaults: a.defaults, production: a.production, style: a.style });
}
exports.handler = protect(inner);
