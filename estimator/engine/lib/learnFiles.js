"use strict";
// Read training files: proposal .docx -> text lines, job costing .xlsx -> cells.
// Buffer in, record out (lib/learn.js does the parsing). Node only (uses the bundled PizZip).
const PizZip = require("../vendor/docx-vendor").PizZip;
const { proposalFromLines, costSheetFromCells } = require("./learn");

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

// cells of the "Job Costing" sheet (or the first sheet)
function xlsxCells(buffer, wanted = /job\s*cost/i) {
  const zip = new PizZip(buffer);
  const read = (n) => (zip.file(n) ? zip.file(n).asText() : "");
  const shared = [...read("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => decode([...m[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((x) => x[1]).join("")));
  const wb = read("xl/workbook.xml"), rels = read("xl/_rels/workbook.xml.rels");
  const sheets = [...wb.matchAll(/<sheet\b[^>]*name="([^"]*)"[^>]*r:id="([^"]*)"/g)].map((m) => ({ name: decode(m[1]), rid: m[2] }));
  const pick = sheets.find((s) => wanted.test(s.name)) || sheets[0];
  let path = "xl/worksheets/sheet1.xml";
  if (pick) { const r = rels.match(new RegExp(`Id="${pick.rid}"[^>]*Target="([^"]+)"`)) || rels.match(new RegExp(`Target="([^"]+)"[^>]*Id="${pick.rid}"`)); if (r) path = "xl/" + r[1].replace(/^\/?xl\//, ""); }
  const xml = read(path);
  const cells = {};
  for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const ref = (m[1].match(/\br="([A-Z]+\d+)"/) || [])[1];
    if (!ref || !m[2]) continue;
    const type = (m[1].match(/\bt="([^"]+)"/) || [])[1];
    const v = (m[2].match(/<v>([\s\S]*?)<\/v>/) || [])[1];
    if (type === "s") cells[ref] = shared[Number(v)] ?? "";
    else if (type === "inlineStr") cells[ref] = decode([...m[2].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((x) => x[1]).join(""));
    else if (type === "str" || type === "e") cells[ref] = v != null ? decode(v) : "";
    else if (v != null) cells[ref] = Number(v);
  }
  return { cells, sheet: pick ? pick.name : "" };
}

const costSheetFromXlsx = (buffer, meta) => { const { cells } = xlsxCells(buffer); return costSheetFromCells((ref) => (ref in cells ? cells[ref] : null), meta); };

module.exports = { docxLines, proposalFromDocx, xlsxCells, costSheetFromXlsx };
