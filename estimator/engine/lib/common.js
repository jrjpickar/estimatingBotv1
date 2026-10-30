"use strict";
// Shared helpers: activity groups, STACK CSV parsing, library profile math.
// Pure functions (no file system) so the same code runs in the Cowork plugin
// and in a Netlify function.

// Activity groups, checked in order; first match wins. Patterns run on the
// lower-cased STACK item name (and on proposal scope text for jobs without a takeoff).
const GROUPS = [
  ["erosion_control", /sand ?bag|gravel bag|silt fence|erosion|swppp|se-\d|tc-\d|wm-\d|ns-\d|straw|waddle|construction (exit|entrance)|gravel entry/],
  ["grading_excavation", /grading|excavat|over.?ex|export|import|cut dirt|fill dirt|dig |trench(?!ing for)|backfill|compact|pad sqft|site sqft|new pad|footing dig|shoring/],
  ["concrete_sawcut_slab", /saw ?cut|slab|concrete|core drill|drill .*concrete|pour|rebar|dowel|footing|electric(al)? box(es)? in slab|raised floor/],
  ["hardscape_site", /hardscape|softscape|sidewalk|driveway|aproch|approach|paver|asphalt|paving|planter|vegetation|landscap|tree|stump|bollard|coping|curb|gutter/],
  ["block_wall_fence", /block wall|cmu|site wall|fence|gate|guard ?rail|railing/],
  ["whole_structure", /house demo|whole house|building demo|structure|demolish (the )?(house|building)|in its entirety|garage demo|gazebo|patio cover|canop|shed|cabana|deck/],
  ["roofing", /roof|rtu|membrane|membrain|hatch|skylight/],
  ["exterior_finishes", /stucco|siding|veneer|cladding|exterior wall|ext walls|fascia|trim|awning|brick/],
  ["windows_storefront", /window|storefront|glazing|glass|slider|sliding door|shopwindow/],
  ["doors", /door|frame/],
  ["walls_partitions", /wall|partition|stud|gypsum|drywall|gyp|closet|soffit|column/],
  ["ceilings", /ceiling|t ?bar|acoustic|tile ceiling/],
  ["flooring", /floor|carpet|tile|vct|vinyl|hardwood|wood floor|base(board)?|scrape|stripping|thinset|adhesive|glue/],
  ["plumbing_fixtures", /plumbing|sink|toilet|lav|urinal|fixture|restroom|bathroom|drinking fountain|shower|tub/],
  ["millwork_casework", /millwork|cabinet|cabnet|counter|casework|shelv|cashwrap|bar |vanity|fireplace|staircase|stair/],
  ["mep_electrical_hvac", /light|electric|conduit|panel|duct|diffuser|grill|hvac|exhaust|vent|thermostat|speaker|camera|security|telecom|sconce|meter|fan/],
  ["signage_specialties", /sign|billboard|fire extinguisher|safe|access panel|curtain|film|satellite|dock|compactor/],
  ["furniture_contents", /furniture|appliance|fridge|microwave|contents|bench|racks?\b|fixtures and/],
  ["haul_containers", /haul|container|low ?boy|dump|truck|load|trash/],
  ["labor_equipment", /labor|guys|equipment|fuel|lift|scraper|rental/],
];
const NOISE = /^(ruler|area ruler|check( ?off)?|checkmark|count|area|keynote check|note check off|sf|lf|floor area|bathrooms|columns measurement)\b/i;
const UNIT_MAP = { "sq ft": "SF", sf: "SF", "ln ft": "LF", lf: "LF", ea: "EA", each: "EA", "cu yd": "CY", cy: "CY" };

function groupFor(name) {
  const n = " " + String(name || "").toLowerCase() + " ";
  for (const [g, re] of GROUPS) if (re.test(n)) return g;
  return "other";
}

function normUnit(u) {
  const k = String(u || "").trim().toLowerCase();
  return UNIT_MAP[k] || (String(u || "").trim().toUpperCase() || "EA");
}

// RFC 4180 CSV parser (quoted fields, embedded commas/quotes/newlines).
function parseCsv(text, { raw = false } = {}) {
  text = String(text).replace(/^﻿/, "");
  const rows = [];
  let row = [], field = "", i = 0, q = false;
  while (i < text.length) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        q = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { q = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  if (raw) return rows;
  if (!rows.length) return [];
  const hdr = rows[0].map((h) => h.trim());
  return rows.slice(1).filter((r) => r.some((v) => v !== "")).map((r) => Object.fromEntries(hdr.map((h, k) => [h, r[k] ?? ""])));
}

const num = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };

// STACK "Takeoff Quantity" CSV export -> normalized items.
function parseStackCsv(text) {
  const items = [];
  for (const r of parseCsv(text)) {
    const name = String(r["Takeoff Name"] ?? r.item ?? "").split(/\s+/).filter(Boolean).join(" ");
    const qty = num(r["Takeoff Quantity"] ?? r.qty);
    if (!name || qty <= 0 || NOISE.test(name)) continue;
    items.push({
      item: name,
      description: String(r["Takeoff Description"] || "").trim(),
      qty: Math.round(qty * 100) / 100,
      unit: normUnit(r["Takeoff Unit"] ?? r.unit),
      plan: String(r["Plan Name"] || "").trim(),
      sqft: num(r["Sq Ft"]), lnft: num(r["Ln Ft"]), each: num(r.EA),
      group: groupFor(name),
    });
  }
  return items;
}

function prepareLibrary(lib) {
  for (const j of lib.jobs) for (const i of j.takeoff || []) { i.unit = normUnit(i.unit); i.group = groupFor(i.item); }
  return lib;
}

// Map of "group|unit" -> total qty.
function profile(items) {
  const out = new Map();
  for (const i of items) {
    const k = `${i.group}|${i.unit}`;
    out.set(k, (out.get(k) || 0) + Number(i.qty));
  }
  return out;
}

const groupsOf = (prof) => new Set([...prof.keys()].map((k) => k.split("|")[0]));

function textGroups(text) {
  const found = new Set();
  for (const line of String(text || "").toLowerCase().split(/[\n.;]/)) {
    if (!line.trim()) continue;
    const g = groupFor(line);
    if (g !== "other") found.add(g);
  }
  return found;
}

function cosine(a, b) {
  const keys = new Set([...a.keys(), ...b.keys()]);
  let dot = 0, na = 0, nb = 0;
  for (const k of keys) {
    const x = Math.log1p(a.get(k) || 0), y = Math.log1p(b.get(k) || 0);
    dot += x * y; na += x * x; nb += y * y;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function jaccard(a, b) {
  const u = new Set([...a, ...b]);
  if (!u.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / u.size;
}

function scaleMatch(a, b) {
  const shared = [...a.keys()].filter((k) => b.has(k));
  if (!shared.length) return 0;
  const s = shared.reduce((t, k) => t + Math.abs(Math.log((a.get(k) + 1) / (b.get(k) + 1))), 0);
  return Math.exp(-s / shared.length);
}

const money0 = (v) => (v == null ? "-" : "$" + Math.round(v).toLocaleString("en-US"));
const money2 = (v) => "$" + Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

module.exports = { GROUPS, groupFor, normUnit, parseCsv, parseStackCsv, prepareLibrary, profile, groupsOf, textGroups, cosine, jaccard, scaleMatch, money0, money2 };
