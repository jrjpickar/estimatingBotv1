"use strict";
// Read training files: proposal .docx -> text lines, job costing .xlsx -> cells.
// Buffer in, record out (lib/learn.js does the parsing). Node only (uses the bundled PizZip).
const PizZip = require("../vendor/docx-vendor").PizZip;
const { proposalFromLines, costSheetFromCells, costSheetFromGrid, costSheetFromSheets } = require("./learn");

const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&");

// Paragraph text of one Word part. Text boxes appear twice (mc:Choice + mc:Fallback); keep one.
function partLines(xml) {
  const x = xml.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, "");
  const out = [];
  // split at paragraph ends; each chunk's text after its last paragraph start is one paragraph
  // (text-box paragraphs nested inside another paragraph come out on their own)
  for (const chunk of x.split("</w:p>")) {
    const starts = [...chunk.matchAll(/<w:p[ >]/g)];
    const inner = starts.length ? chunk.slice(starts[starts.length - 1].index) : chunk;
    let t = "";
    for (const m of inner.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:br\/>|<w:cr\/>|<w:tab\/>/g)) t += m[1] != null ? decode(m[1]) : m[0] === "<w:tab/>" ? " " : "\n";
    for (const l of t.split("\n")) if (l.trim()) out.push(l);
  }
  return out;
}

function docxLines(buffer) {
  const zip = new PizZip(buffer);
  const names = Object.keys(zip.files);
  const parts = [...names.filter((n) => /^word\/header\d*\.xml$/.test(n)).sort(), "word/document.xml"];
  const lines = [];
  for (const n of parts) if (zip.file(n)) lines.push(...partLines(zip.file(n).asText()));
  return lines;
}

const proposalFromDocx = (buffer, meta) => proposalFromLines(docxLines(buffer), meta);

// every sheet of a workbook: { name, cells: { A1: value }, rows: [[...]] }
const colIndex = (ref) => [...ref.match(/^[A-Z]+/)[0]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
function xlsxSheets(buffer) {
  const zip = new PizZip(buffer);
  const read = (n) => (zip.file(n) ? zip.file(n).asText() : "");
  if (!read("xl/workbook.xml")) throw new Error("This isn't an .xlsx workbook. Save old .xls files as .xlsx (or export Google Sheets as .xlsx) and try again.");
  const shared = [...read("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => decode([...m[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((x) => x[1]).join("")));
  const wb = read("xl/workbook.xml"), rels = read("xl/_rels/workbook.xml.rels");
  const out = [];
  for (const m of wb.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = decode((m[1].match(/name="([^"]*)"/) || [])[1] || ""), rid = (m[1].match(/r:id="([^"]*)"/) || [])[1];
    if (/state="(hidden|veryHidden)"/.test(m[1])) continue;
    const r = rels.match(new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"`)) || rels.match(new RegExp(`Target="([^"]+)"[^>]*Id="${rid}"`));
    if (!r) continue;
    const xml = read("xl/" + r[1].replace(/^\/?xl\//, ""));
    const cells = {}, rows = [];
    for (const c of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = (c[1].match(/\br="([A-Z]+\d+)"/) || [])[1];
      if (!ref || !c[2]) continue;
      const type = (c[1].match(/\bt="([^"]+)"/) || [])[1];
      const v = (c[2].match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let val;
      if (type === "s") val = shared[Number(v)] ?? "";
      else if (type === "inlineStr") val = decode([...c[2].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((x) => x[1]).join(""));
      else if (type === "str" || type === "e") val = v != null ? decode(v) : "";
      else if (type === "b") val = v === "1";
      else if (v != null) val = Number(v);
      else continue;
      cells[ref] = val;
      const ri = Number(ref.match(/\d+$/)[0]) - 1, ci = colIndex(ref);
      if (ri < 2000 && ci < 60) { (rows[ri] = rows[ri] || [])[ci] = val; }
    }
    out.push({ name, cells, rows: Array.from(rows, (r) => Array.from(r || [], (x) => (x === undefined ? null : x))) });
  }
  return out;
}

// cells of the "Job Costing" sheet (or the first sheet)
function xlsxCells(buffer, wanted = /job\s*cost/i) {
  const sheets = xlsxSheets(buffer);
  const pick = sheets.find((s) => wanted.test(s.name)) || sheets[0] || { cells: {}, name: "" };
  return { cells: pick.cells, sheet: pick.name };
}

// Job costing sheet, any layout: V3 by its labels, otherwise read loosely (lib/learn.js costSheetFromGrid)
function costSheetFromXlsx(buffer, meta) {
  const sheets = xlsxSheets(buffer).map((s) => ({ ...s, get: (ref) => (ref in s.cells ? s.cells[ref] : null) }));
  return costSheetFromSheets(sheets, meta);
}
// CSV export of a cost sheet (Google Sheets: File, Download, .csv)
function costSheetFromCsv(text, meta) {
  const C = require("./common");
  const rows = C.parseCsv(String(text), { raw: true });
  return costSheetFromGrid(rows, { ...meta, sheet: "csv" });
}

module.exports = { docxLines, proposalFromDocx, xlsxCells, xlsxSheets, costSheetFromXlsx, costSheetFromCsv };
