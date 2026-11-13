"""Vector evidence rules. Unsupported vectors and scans remain manual."""
import re
from math import dist
import cv2
import numpy as np
import pymupdf as pdf
from pydantic import BaseModel, Field
from .domain import Calibration, Measurement, StyleRule, SCOPES, quantities

TAG = re.compile(r"A2Z TAKEOFF:\s*(\w+)(?:\s+THICKNESS=(\d+(?:\.\d+)?)IN)?", re.I)
BAR = re.compile(r"A2Z SCALE BAR:\s*(\d+(?:\.\d+)?)\s*FT", re.I)
LEGEND = re.compile(r"A2Z LEGEND:\s*(\w+)(?:\s+THICKNESS=(\d+(?:\.\d+)?)IN)?", re.I)
SCOPE_NOTE = re.compile(r"\b(?:DEMO(?:LISH|LITION)?|REMOVE|SAW\s*CUT|SCALE)\b", re.I)

class Run(BaseModel):
    calibration: Calibration | None = None
    rules: list[StyleRule] = Field(default_factory=list, max_length=30)

def read_sheet(page):
    matrix = page.rotation_matrix
    def point(p):
        p = pdf.Point(p) * matrix
        return (round(p.x, 4), round(p.y, 4))
    def bounds(r):
        return list(pdf.Rect(r) * matrix)
    def items(entries):
        result = []
        for kind, *args in entries:
            if kind == "re":
                rect = args[0]
                coords = [point(p) for p in (rect.tl, rect.tr, rect.br, rect.bl)]
            elif kind == "qu":
                q = args[0]
                coords = [point(p) for p in (q.ul, q.ur, q.lr, q.ll)]
            else:
                coords = [point(p) for p in args if isinstance(p, pdf.Point)]
            result.append((kind, coords))
        return result
    paths = []
    for path in page.get_drawings():
        color = path.get("color")
        color = "#" + "".join(f"{round(c * 255):02x}" for c in color) if color else None
        paths.append({"seq": path.get("seqno"), "color": color, "dashed": bool(
            re.search(r"\[\s*\d", path.get("dashes") or "")), "bounds": bounds(path["rect"]),
            "closed": bool(path.get("closePath")), "items": items(path["items"])})
    labels = []
    for block in page.get_text("dict", flags=pdf.TEXTFLAGS_DICT & ~pdf.TEXT_PRESERVE_IMAGES)["blocks"]:
        for line in block.get("lines", []):
            label = "".join(span["text"] for span in line["spans"]).strip()
            if label:
                labels.append({"text": label, "bounds": bounds(line["bbox"])})
    annots = [{"type": a.type[1], "text": a.info.get("content", "").strip(),
               "bounds": bounds(a.rect), "vertices": [point(p) for p in (a.vertices or [])]
               if a.type[1] in {"Line", "PolyLine", "Polygon"} else [],
               "xref": a.xref} for a in page.annots()]
    return {"paths": paths, "labels": labels, "annotations": annots}

def vector_geometry(path, unit):
    entries = path["items"]
    if len(entries) == 1 and entries[0][0] in {"re", "qu"}:
        pts = entries[0][1]
        if unit == "EA":
            return "count", [tuple(sum(p[i] for p in pts)/4 for i in range(2))]
        if unit == "SF":
            return "polygon", pts
        return None
    if unit == "EA" or not entries or any(kind != "l" for kind, _ in entries):
        return None
    pts = entries[0][1][:]
    for _, (a, b) in entries[1:]:
        if dist(pts[-1], a) > 0.01:
            return None
        pts.append(b)
    closed = dist(pts[0], pts[-1]) <= 0.01 or path["closed"]
    if unit == "SF" and closed:
        if dist(pts[0], pts[-1]) <= 0.01:
            pts.pop()
        return "polygon", pts
    if unit == "LF" and not closed:
        return ("line" if len(pts) == 2 else "polyline"), pts
    return None

def process(page, run):
    data = read_sheet(page)
    warnings = []
    scales = []
    for a in data["annotations"]:
        match = BAR.fullmatch(a["text"])
        if match and a["type"] == "Line" and len(a["vertices"]) == 2 and float(match[1]) > 0:
            bar = Calibration(points=a["vertices"], feet=float(match[1]), source=f"Scale bar xref {a['xref']}")
            if bar.factor:
                scales.append(bar)
    cal = run.calibration
    if not cal and len(scales) == 1:
        cal = scales[0]
        yield "scale", cal.model_dump()
    if not cal or not cal.factor:
        warnings.append("Calibrate this sheet with two points and a known distance. Printed scale text alone is insufficient.")
    if len(scales) > 1:
        warnings.append("Multiple tagged scale bars. Confirm scale and use a separate project for mixed-scale views.")
    factor = cal.factor if cal else None
    mappings = {}
    for rule in run.rules:
        mappings.setdefault((rule.color.lower(), rule.dashed), set()).add((rule.scope, None))
    legend_paths = set()
    for label in data["labels"]:
        m = LEGEND.fullmatch(label["text"])
        if not m or m[1].lower() not in SCOPES:
            continue
        x0, y0, _, y1 = label["bounds"]
        candidates = [p for p in data["paths"] if p["color"] and
                      0 <= x0 - p["bounds"][2] <= 36 and
                      y0 <= (p["bounds"][1] + p["bounds"][3])/2 <= y1]
        if len(candidates) != 1:
            legend_paths.update(p["seq"] for p in candidates)
            warnings.append(f"Legend swatch ambiguous or absent for {label['text']}.")
            continue
        p = candidates[0]
        legend_paths.add(p["seq"])
        mappings.setdefault((p["color"], p["dashed"]), set()).add(
            (m[1].lower(), float(m[2]) if m[2] else None))
    seen = set()
    def make(scope, geometry, source, key, thickness):
        if not geometry:
            warnings.append(f"{source}: unsupported geometry for {scope}.")
            return
        tool, points = geometry
        if not points or any(not (0 <= x <= page.rect.width and 0 <= y <= page.rect.height)
                             for x, y in points):
            warnings.append(f"{source}: empty geometry or outside the displayed crop.")
            return
        if thickness is not None and thickness <= 0:
            warnings.append(f"{source}: thickness must be positive.")
            thickness = None
        item = Measurement(id=f"auto-{page.number}-{key}", sheet=page.number, scope=scope,
                           tool=tool, points=points, source=source, thickness=thickness)
        check = quantities(item, factor or 1)
        if not check:
            warnings.append(f"{source}: invalid geometry for {scope}.")
            return
        signature = (scope, tuple(sorted(item.points)))
        if signature in seen:
            warnings.append(f"{source}: duplicate geometry omitted.")
            return
        seen.add(signature)
        if scope == "slab" and not thickness:
            warnings.append(f"{source}: slab volume requires measured thickness in inches.")
        return item.model_dump()
    for a in data["annotations"]:
        m = TAG.fullmatch(a["text"])
        if not m:
            if a["text"].upper().startswith("A2Z TAKEOFF"):
                warnings.append(f"Annotation xref {a['xref']}: malformed takeoff tag.")
            continue
        scope = m[1].lower()
        if scope not in SCOPES:
            warnings.append(f"Unknown annotation scope {scope}.")
            continue
        tool = {"Line":"line", "PolyLine":"polyline", "Polygon":"polygon",
                "Square":"rect", "Circle":"count"}.get(a["type"])
        x0,y0,x1,y1 = a["bounds"]
        points = ([(x0,y0),(x1,y1)] if tool == "rect" else
                  [((x0+x1)/2,(y0+y1)/2)] if tool == "count" else a["vertices"])
        # PDF Square annotation /Rect can include border padding. Require polygon vertices.
        geom = (tool, points) if tool in {"line", "polyline", "polygon", "count"} else None
        result = make(scope, geom, f"Tagged annotation xref {a['xref']}", f"a{a['xref']}",
                      float(m[2]) if m[2] else None)
        if result:
            yield "measurement", result
    for p in data["paths"]:
        candidates = mappings.get((p["color"], p["dashed"]))
        if not candidates or p["seq"] in legend_paths:
            continue
        if len(candidates) != 1:
            warnings.append(f"Vector {p['seq']}: style maps to competing rules.")
            continue
        scope, thickness = next(iter(candidates))
        result = make(scope, vector_geometry(p, SCOPES[scope][1]),
                      f"Style rule {p['color']} {'dashed' if p['dashed'] else 'solid'}, vector {p['seq']}",
                      f"v{p['seq']}", thickness)
        if result:
            yield "measurement", result
    for label in data["labels"]:
        if SCOPE_NOTE.search(label["text"]) and not label["text"].upper().startswith("A2Z LEGEND:"):
            warnings.append(f"Plan text for manual cross-check: {label['text'][:160]}")
    raster_backdrop = any(
        abs(pdf.Rect(image["bbox"]) & (page.rect * page.derotation_matrix)) >= abs(page.rect) * 0.5
        for image in page.get_image_info()
    )
    if raster_backdrop:
        zoom = min(1.0, 1800 / max(page.rect.width, page.rect.height))
        raster = page.get_pixmap(matrix=pdf.Matrix(zoom, zoom), colorspace=pdf.csGRAY)
        gray = np.frombuffer(raster.samples, np.uint8).reshape(raster.height, raster.width)
        edges = cv2.Canny(gray, 60, 150)
        lines = cv2.HoughLinesP(edges, 1, np.pi / 180, 45, minLineLength=40, maxLineGap=4)
        count = len(lines) if lines is not None else 0
        warnings.append(f"Raster sheet: OpenCV found {count} unclassified line candidates. Trace and assign scope manually.")
    if not seen:
        warnings.append("No supported demolition geometry matched. Use manual tools or define a verified vector style rule.")
    unique = list(dict.fromkeys(warnings))
    yield "warnings", unique[:150] + ([f"{len(unique)-150} additional warnings."] if len(unique)>150 else [])
