"use strict";
// Find the closest past A2Z jobs to a new STACK takeoff.
//
// Scoring (deterministic):
//   - Library jobs WITH a STACK takeoff: 0.75 x cosine similarity of log-quantities
//     by (activity group, unit) + 0.25 x overlap of groups. The size ratio in shared
//     buckets (sizeMatch) is reported for explanation, not scored: weighting it did
//     not improve the backtest.
//   - Library jobs WITHOUT a takeoff: overlap of groups found in the proposal scope
//     text, scaled by 0.6 (no quantities to compare).
// Backtest (2026-10-16, leave-one-out, 36 jobs with takeoffs): median of the top-3
// comps within +/-50% of the real sent total on 14/36, within 2x on 22/36.
// Comps are context and a sanity range, never a price.
const C = require("./common");

function scoreJob(newProf, newGroups, job) {
  if (job.takeoff && job.takeoff.length) {
    const jp = C.profile(job.takeoff);
    const jg = C.groupsOf(jp);
    return { score: 0.75 * C.cosine(newProf, jp) + 0.25 * C.jaccard(newGroups, jg), jp, jg, basis: "takeoff" };
  }
  const tg = C.textGroups(job.scopeText);
  return { score: 0.6 * C.jaccard(newGroups, tg), jp: new Map(), jg: tg, basis: "scope text only" };
}

const r1 = (x) => Math.round(x * 10) / 10;

function findComps(items, library, { top = 5, exclude = [] } = {}) {
  if (!items.length) throw new Error("No usable takeoff lines found.");
  const newProf = C.profile(items);
  const newGroups = C.groupsOf(newProf);
  const scored = [];
  for (const job of library.jobs) {
    if (exclude.some((x) => job.name.toLowerCase().includes(String(x).toLowerCase()))) continue;
    const { score, jp, jg, basis } = scoreJob(newProf, newGroups, job);
    if (score <= 0) continue;
    const qtyCompare = [];
    for (const k of [...newProf.keys()].sort()) {
      if (!jp.has(k)) continue;
      const [group, unit] = k.split("|");
      const q = newProf.get(k), cq = jp.get(k);
      qtyCompare.push({ group, unit, new: r1(q), comp: r1(cq), ratio: cq ? Math.round((q / cq) * 100) / 100 : null });
    }
    scored.push({
      name: job.name, customer: job.customer || "", date: job.date || "",
      sentTotal: job.sentTotal, outcome: job.outcome, stages: job.stages || [], priceStatus: job.priceStatus,
      score: Math.round(score * 1000) / 1000, basis,
      sharedGroups: [...newGroups].filter((g) => jg.has(g)).sort(),
      onlyInNew: [...newGroups].filter((g) => !jg.has(g)).sort(),
      onlyInComp: [...jg].filter((g) => !newGroups.has(g)).sort(),
      qtyCompare, sizeMatch: jp.size ? Math.round(C.scaleMatch(newProf, jp) * 100) / 100 : null,
      scopeTotals: job.scopeTotals || [], scopeText: String(job.scopeText || "").slice(0, 1200),
      takeoff: (job.takeoff || []).slice(0, 40),
    });
  }
  scored.sort((a, b) => b.score - a.score);
  const comps = scored.slice(0, top);
  const prices = comps.map((c) => c.sentTotal);
  const won = comps.filter((c) => c.outcome === "won").map((c) => c.sentTotal);
  return {
    newJob: {
      lines: items.length, groups: [...newGroups].sort(),
      profile: [...newProf.entries()].sort().map(([k, q]) => ({ group: k.split("|")[0], unit: k.split("|")[1], qty: r1(q) })),
      items,
    },
    comps,
    range: {
      min: prices.length ? Math.min(...prices) : null, max: prices.length ? Math.max(...prices) : null,
      wonMin: won.length ? Math.min(...won) : null, wonMax: won.length ? Math.max(...won) : null,
    },
    librarySize: library.jobs.length, libraryVersion: library.version,
  };
}

function formatComps(res) {
  const L = [];
  L.push(`New job: ${res.newJob.lines} takeoff lines in groups: ${res.newJob.groups.join(", ")}`);
  L.push(`Library: ${res.librarySize} priced past jobs (version ${res.libraryVersion})`, "");
  L.push("| # | Past job | Sent total | Outcome | Match | Basis | Shared scope | Only in new job |", "|---|---|---|---|---|---|---|---|");
  res.comps.forEach((r, n) => L.push(`| ${n + 1} | ${r.name} | ${C.money0(r.sentTotal)} | ${r.outcome} | ${r.score.toFixed(2)} | ${r.basis} | ${r.sharedGroups.join(", ") || "-"} | ${r.onlyInNew.join(", ") || "-"} |`));
  L.push("", "Quantity comparison (new vs comp) for shared groups:");
  for (const r of res.comps) if (r.qtyCompare.length) L.push(`- ${r.name}: ` + r.qtyCompare.map((q) => `${q.group} ${q.new} vs ${q.comp} ${q.unit}`).join("; "));
  const g = res.range;
  L.push("", `Comp price range: ${C.money0(g.min)} to ${C.money0(g.max)}` + (g.wonMin != null ? ` | won comps: ${C.money0(g.wonMin)} to ${C.money0(g.wonMax)}` : " | no won comps in shortlist"));
  return L.join("\n");
}

module.exports = { findComps, formatComps, scoreJob };
