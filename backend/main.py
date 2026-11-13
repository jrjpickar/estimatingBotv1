"""Local API. PDFs are immutable. Saved revisions use optimistic locking."""
import csv
import io
import json
import logging
import re
import sqlite3
import subprocess
from contextlib import closing
from math import isfinite
from pathlib import Path
from uuid import uuid4

import pymupdf as pdf
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .domain import Revision, SCOPES, quantities
from .extract import Run, process, read_sheet

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
DB = DATA / "projects.sqlite3"

def initialize_storage(directory):
    global DATA, DB
    DATA = Path(directory)
    DATA.mkdir(parents=True, exist_ok=True)
    DB = DATA / "projects.sqlite3"
    with closing(sqlite3.connect(DB)) as conn, conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, sheets TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS revisions(project TEXT NOT NULL, number INTEGER NOT NULL,
                state TEXT NOT NULL, PRIMARY KEY(project, number));
        """)

app = FastAPI(title="A2Z Takeoff Sandbox")

def connection():
    if not DB.exists():
        initialize_storage(DATA)
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    return conn

def project(project_id):
    with closing(connection()) as conn:
        row = conn.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Project not found.")
        return {"id": row["id"], "name": row["name"], "sheets": json.loads(row["sheets"])}

def sheet_for(p, sheet):
    if not 0 <= sheet < len(p["sheets"]):
        raise HTTPException(404, "Sheet not found.")
    return p["sheets"][sheet]

def validate(p, state):
    def inside(sheet, points):
        if any(not (0 <= x <= sheet["width"] + 0.001 and 0 <= y <= sheet["height"] + 0.001)
               for x, y in points):
            raise HTTPException(422, "Geometry must stay within the sheet.")
    for index, rules in state.rules.items():
        sheet_for(p, index)
        if len(rules) > 30:
            raise HTTPException(422, "Use at most 30 style rules per sheet.")
    ids = set()
    for index, scale in state.scales.items():
        inside(sheet_for(p, index), scale.points)
        if not scale.factor or not isfinite(scale.factor):
            raise HTTPException(422, "Calibration requires distinct points and a finite scale.")
    for item in state.items:
        inside(sheet_for(p, item.sheet), item.points)
        if item.id in ids:
            raise HTTPException(422, "Measurement IDs must be unique.")
        ids.add(item.id)
        result = measure(state, item)
        if any(not isfinite(q) for q in result.values()):
            raise HTTPException(422, "Measurement quantity exceeds the supported range.")
        if item.status == "approved" and not result:
            raise HTTPException(422, "An approved item needs valid geometry and scale.")

def measure(state, item):
    scale = state.scales.get(item.sheet)
    try:
        return quantities(item, scale.factor if scale else None)
    except OverflowError:
        return {"invalid": float("inf")}

def csv_for(p, state):
    out = io.StringIO(newline="")
    w = csv.writer(out)
    w.writerow(["Takeoff Name", "Takeoff Description", "Sq Ft", "Ln Ft", "Cu Yd", "EA",
                "Marker Count", "Drop Count", "Takeoff Quantity", "Takeoff Unit", "Scale", "Plan Name"])
    totals = {}
    unit_names = {"SF": "Sq Ft", "LF": "Ln Ft", "EA": "EA"}
    for item in state.items:
        if item.status != "approved":
            continue
        name, unit, _ = SCOPES[item.scope]
        scale = state.scales.get(item.sheet)
        key = (item.sheet, name, unit)
        values, ids = totals.setdefault(key, ({}, []))
        for u, q in measure(state, item).items():
            values[u] = values.get(u, 0) + q
        ids.append(item.id)
    for (sheet, name, unit), (values, ids) in totals.items():
        scale = state.scales.get(sheet)
        w.writerow([name, f"Measurement IDs: {', '.join(ids)}",
                    *[f"{values.get(u, 0):.6f}" for u in ("SF", "LF", "CY", "EA")],
                    0, 0, f"{values[unit]:.6f}", unit_names[unit],
                    f"{scale.factor:.10g} ft/pt" if scale else "", p["sheets"][sheet].get("planName", p["sheets"][sheet]["name"])])
    return out.getvalue()

@app.get("/api/projects")
def list_projects():
    with closing(connection()) as conn:
        return [dict(row) for row in conn.execute("SELECT id,name FROM projects ORDER BY rowid DESC")]

def import_pdf(contents, name):
    if not contents.startswith(b"%PDF-"):
        raise HTTPException(422, "Upload a PDF.")
    try:
        with pdf.open(stream=contents, filetype="pdf") as doc:
            if doc.needs_pass or not 1 <= len(doc) <= 300:
                raise ValueError()
            sheets = []
            for i, page in enumerate(doc):
                label = page.get_label()
                sheet_name = f"Sheet {i+1} ({label})" if label else f"Sheet {i+1}"
                code = re.match(r"^[A-Z]{1,3}[-.]?\d{1,3}(?:\.\d+)?[A-Z]?\b", label)
                sheets.append({"name": sheet_name, "planName": f"{label} - Sheet {i+1}" if code else sheet_name,
                               "width": page.rect.width, "height": page.rect.height})
    except (ValueError, RuntimeError):
        raise HTTPException(422, "Use an unlocked, readable PDF with 1–300 sheets.") from None
    identifier = uuid4().hex
    DATA.mkdir(parents=True, exist_ok=True)
    path = DATA / f"{identifier}.pdf"
    path.write_bytes(contents)
    try:
        with closing(connection()) as conn, conn:
            conn.execute("INSERT INTO projects VALUES (?,?,?)",
                         (identifier, Path(name).name[:250], json.dumps(sheets)))
            conn.execute("INSERT INTO revisions VALUES (?,?,?)",
                         (identifier, 0, Revision(revision=0).model_dump_json()))
    except sqlite3.Error:
        path.unlink()
        raise
    return project(identifier)

@app.post("/api/projects")
def upload(file: UploadFile = File(...)):
    limit = 100 * 1024 * 1024
    contents = file.file.read(limit + 1)
    if len(contents) > limit:
        raise HTTPException(413, "PDF exceeds 100 MiB.")
    return import_pdf(contents, file.filename or "Plans.pdf")

@app.post("/api/sample")
def sample():
    return import_pdf((ROOT / "samples/interior-demo.pdf").read_bytes(), "Interior demolition sample.pdf")

@app.get("/api/projects/{project_id}")
def open_project(project_id: str, revision: int | None = None):
    p = project(project_id)
    with closing(connection()) as conn:
        if revision is None:
            row = conn.execute("SELECT state FROM revisions WHERE project=? ORDER BY number DESC LIMIT 1",
                               (project_id,)).fetchone()
        else:
            row = conn.execute("SELECT state FROM revisions WHERE project=? AND number=?",
                               (project_id, revision)).fetchone()
    if not row:
        raise HTTPException(404, "Revision not found.")
    return {**p, "state": json.loads(row["state"])}

@app.get("/api/projects/{project_id}/pdf")
def plans(project_id: str):
    p = project(project_id)
    return FileResponse(DATA / f"{p['id']}.pdf", media_type="application/pdf")

@app.get("/api/projects/{project_id}/sheets/{sheet}/vectors")
def inspect(project_id: str, sheet: int):
    p = project(project_id)
    sheet_for(p, sheet)
    with pdf.open(DATA / f"{p['id']}.pdf") as doc:
        return read_sheet(doc[sheet])

@app.put("/api/projects/{project_id}")
def save(project_id: str, state: Revision):
    p = project(project_id)
    validate(p, state)
    with closing(connection()) as conn, conn:
        conn.execute("BEGIN IMMEDIATE")
        current = conn.execute("SELECT MAX(number) FROM revisions WHERE project=?", (project_id,)).fetchone()[0]
        if current != state.revision:
            raise HTTPException(409, "A newer revision exists. Reopen the project before saving.")
        state.revision += 1
        conn.execute("INSERT INTO revisions VALUES (?,?,?)", (project_id, state.revision, state.model_dump_json()))
    return state

@app.post("/api/projects/{project_id}/sheets/{sheet}/run")
def run_engine(project_id: str, sheet: int, run: Run):
    p = project(project_id)
    view = sheet_for(p, sheet)
    if run.calibration:
        if not run.calibration.factor or not isfinite(run.calibration.factor) or any(
            not (0 <= x <= view["width"] and 0 <= y <= view["height"]) for x, y in run.calibration.points
        ):
            raise HTTPException(422, "Calibration is invalid or outside this sheet.")
    def events():
        def event(kind, data):
            return f"event: {kind}\ndata: {json.dumps(data, allow_nan=False)}\n\n"
        try:
            with pdf.open(DATA / f"{p['id']}.pdf") as doc:
                for kind, data in process(doc[sheet], run):
                    yield event(kind, data)
            yield event("done", {})
        except Exception:
            logging.exception("Takeoff extraction failed")
            yield event("failed", {"message": "Extraction failed. Existing measurements can still be edited manually."})
    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

@app.post("/api/projects/{project_id}/csv")
def export(project_id: str, state: Revision):
    p = project(project_id)
    validate(p, state)
    return Response(csv_for(p, state), media_type="text/csv",
                    headers={"Content-Disposition": 'attachment; filename="A2Z-STACK-takeoff.csv"'})

@app.post("/api/projects/{project_id}/price")
def price(project_id: str, state: Revision):
    p = project(project_id)
    validate(p, state)
    try:
        result = subprocess.run(["node", str(ROOT / "desk/cli.cjs")], capture_output=True,
                                text=True, input=json.dumps({"csv": csv_for(p, state),
                                "markup": state.markup, "name": p["name"]}), timeout=10, check=True)
        return json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        raise HTTPException(503, "Local Desk pricing is unavailable. Check that Node is installed.") from None

if (ROOT / "dist").is_dir():
    app.mount("/", StaticFiles(directory=ROOT / "dist", html=True))
