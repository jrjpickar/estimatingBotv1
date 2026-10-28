"use strict";
// Job Costing Worksheet V3 layout and the rule that puts estimate lines onto its fixed rows.
// Pure (no file access), so the page's Cost sheet tab shows exactly what the .xlsx will hold.
const LAYOUT = {
  Interior: { start: 8, cats: ["Labor", "Hotel", "Hauling", "Equipment", "Equipment", "Fuel", "Misc"], sub: 15 },
  Exterior: { start: 19, cats: ["Labor", "Hauling", "Equipment", "Equipment", "Equipment", "Fuel", "Misc"], sub: 26 },
  Grading: { start: 30, cats: ["Labor", "Hauling", "Equipment", "Fuel", "Misc"], sub: 35 },
};
const INTERIOR_GROUPS = new Set(["walls_partitions", "ceilings", "flooring", "plumbing_fixtures", "millwork_casework", "mep_electrical_hvac",
  "doors", "signage_specialties", "furniture_contents", "labor_equipment", "haul_containers", "other"]);
const GRADING_GROUPS = new Set(["grading_excavation", "erosion_control"]);
const title = (s) => String(s).trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

// Map priced sections onto the template's fixed rows -> { cells: {ref: value}, notes: [] }
function assignRows(sections) {
  const cells = {}, notes = [];
  for (const sec of sections) {
    const name = title(sec.name);
    const lay = LAYOUT[name];
    if (!lay) throw new Error(`Section '${sec.name}' isn't on the template (Interior, Exterior, Grading).`);
    const used = new Map();
    for (const ln of sec.lines) {
      const cat = title(ln.category);
      let slot = lay.cats.findIndex((c, i) => c === cat && !used.has(i));
      if (slot < 0 && cat !== "Misc") {
        slot = lay.cats.findIndex((c, i) => c === "Misc" && !used.has(i));
        if (slot >= 0) notes.push(`${name}: no free ${cat} row, put '${ln.description || ""}' on the Misc row.`);
      }
      if (slot < 0) {
        const same = lay.cats.map((c, i) => (c === cat ? i : -1)).filter((i) => i >= 0);
        slot = same.length ? same[same.length - 1] : lay.cats.indexOf("Misc");
        const prev = used.get(slot);
        const ext = prev.qty * prev.rate + Number(ln.qty) * Number(ln.rate);
        used.set(slot, { description: `${prev.description} + ${ln.description || ""} (${ln.qty} x $${Math.round(ln.rate).toLocaleString("en-US")})`, qty: 1, rate: ext });
        notes.push(`${name}: combined '${ln.description || ""}' into row ${lay.start + slot} as a lump sum (template has no spare ${cat} row).`);
        continue;
      }
      used.set(slot, { description: ln.description || "", qty: Number(ln.qty), rate: Number(ln.rate) });
    }
    for (const [i, v] of used) {
      const r = lay.start + i;
      cells[`B${r}`] = v.description;
      cells[`C${r}`] = v.qty;
      cells[`D${r}`] = v.rate;
    }
  }
  return { cells, notes };
}


// Same placement rule as assignRows, but keeps which estimate line sits on each row,
// so the Cost sheet tab can edit the right line.
//   -> [ { section, rows: [ { row, cat, line: index | null, merged: [indexes] } ], sub } ]
function slotMap(sections) {
  const out = [];
  for (const name of Object.keys(LAYOUT)) {
    const lay = LAYOUT[name];
    const sec = (sections || []).find((s) => title(s.name) === name);
    const rows = lay.cats.map((cat, i) => ({ row: lay.start + i, cat, line: null, merged: [] }));
    if (sec) {
      (sec.lines || []).forEach((ln, idx) => {
        const cat = title(ln.category);
        let slot = rows.findIndex((r) => r.cat === cat && r.line === null);
        if (slot < 0 && cat !== "Misc") slot = rows.findIndex((r) => r.cat === "Misc" && r.line === null);
        if (slot < 0) {
          const same = rows.map((r, i) => (r.cat === cat ? i : -1)).filter((i) => i >= 0);
          slot = same.length ? same[same.length - 1] : rows.findIndex((r) => r.cat === "Misc");
          rows[slot].merged.push(idx);
          return;
        }
        rows[slot].line = idx;
      });
    }
    out.push({ section: name, rows, sub: lay.sub, present: !!sec });
  }
  return out;
}

module.exports = { LAYOUT, INTERIOR_GROUPS, GRADING_GROUPS, assignRows, slotMap, title };
