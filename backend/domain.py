"""Canonical coordinates are displayed PDF points, from the crop's top left."""
from typing import Literal
from math import dist
from uuid import uuid4
from pydantic import BaseModel, Field, FiniteFloat
from shapely.geometry import Polygon

SCOPES = {
    "wall": ("Demo interior stud walls", "LF", "#b8363d"),
    "floor": ("Remove flooring", "SF", "#217a55"),
    "ceiling": ("Demo ceiling", "SF", "#754db6"),
    "slab": ("Remove concrete slab", "SF", "#bd581a"),
    "door": ("Remove doors", "EA", "#2662bb"),
    "fixture": ("Remove plumbing fixtures", "EA", "#a12273"),
    "sawcut": ("Sawcut concrete", "LF", "#00767f"),
    "millwork": ("Remove millwork", "LF", "#775b38"),
}
Point = tuple[FiniteFloat, FiniteFloat]
Tool = Literal["line", "polyline", "polygon", "rect", "count"]
Scope = Literal["wall", "floor", "ceiling", "slab", "door", "fixture", "sawcut", "millwork"]

class Measurement(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()), max_length=180)
    sheet: int = Field(ge=0)
    scope: Scope
    tool: Tool
    points: list[Point] = Field(min_length=1, max_length=5000)
    thickness: FiniteFloat | None = Field(default=None, gt=0)
    source: str = Field(default="Manual", max_length=600)
    status: Literal["review", "approved", "rejected"] = "review"
    edited: bool = False

class Calibration(BaseModel):
    points: tuple[Point, Point]
    feet: FiniteFloat = Field(gt=0)
    source: str = Field(default="Manual", max_length=200)

    @property
    def factor(self):
        length = dist(*self.points)
        return self.feet / length if length > 0 else None

class StyleRule(BaseModel):
    scope: Scope
    color: str = Field(pattern=r"^#[\da-fA-F]{6}$")
    dashed: bool = False

class Revision(BaseModel):
    revision: int = Field(ge=0)
    items: list[Measurement] = Field(default_factory=list, max_length=20000)
    scales: dict[int, Calibration] = Field(default_factory=dict)
    notes: dict[int, list[str]] = Field(default_factory=dict)
    rules: dict[int, list[StyleRule]] = Field(default_factory=dict)
    markup: FiniteFloat | None = Field(default=None, ge=0)

def quantities(item, scale):
    unit = SCOPES[item.scope][1]
    points = item.points
    if unit == "EA" and item.tool == "count" and len(points) == 1:
        return {"EA": 1}
    if unit == "LF" and ((item.tool == "line" and len(points) == 2) or
                         (item.tool == "polyline" and len(points) >= 2)):
        length = sum(dist(a, b) for a, b in zip(points, points[1:]))
        return {"LF": length * scale} if scale and length > 0 else {}
    if unit != "SF" or not scale:
        return {}
    if item.tool == "rect" and len(points) == 2:
        (x1, y1), (x2, y2) = points
        area = abs((x1-x2) * (y1-y2))
    elif item.tool == "polygon" and len(points) >= 3:
        poly = Polygon(points)
        area = poly.area if poly.is_valid else 0
    else:
        return {}
    if area <= 0:
        return {}
    result = {"SF": area * scale**2}
    if item.scope == "slab" and item.thickness:
        result["CY"] = result["SF"] * item.thickness / 324
    return result
