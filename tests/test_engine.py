import csv
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

import pymupdf as pdf
from fastapi.testclient import TestClient
from backend.domain import Calibration, Measurement, quantities
from backend.extract import Run, process

ROOT = Path(__file__).resolve().parent.parent
SAMPLE = ROOT / "samples/interior-demo.pdf"
TRUTH = json.loads((ROOT / "samples/ground-truth.json").read_text())

class GeometryTests(unittest.TestCase):
    def test_controlled_accuracy_and_coverage(self):
        measured, maximum_error, coverage = 0, 0, 0
        with pdf.open(SAMPLE) as doc:
            for index, scopes in TRUTH["supported"].items():
                events = list(process(doc[int(index)], Run()))
                self.assertEqual(events[0][0], "scale")
                scale = Calibration.model_validate(events[0][1])
                results = [Measurement.model_validate(value) for event, value in events if event=="measurement"]
                self.assertEqual(len(results), len(scopes))
                self.assertEqual({r.scope for r in results}, set(scopes))
                for result in results:
                    self.assertEqual(result.status, "review")
                    expected = scopes[result.scope]
                    actual = quantities(result, scale.factor)
                    self.assertEqual(actual.keys(), expected.keys())
                    for unit, value in expected.items():
                        maximum_error = max(maximum_error, abs(actual[unit]-value)/value)
                        measured += 1
                    coverage += 1
            for index in TRUTH["manual_only"]:
                events = dict(process(doc[int(index)], Run()))
                self.assertNotIn("measurement", events)
                self.assertNotIn("scale", events)
                self.assertTrue(events["warnings"])
        self.assertEqual((coverage, measured), (9,10))
        self.assertLessEqual(maximum_error, .000001)
        manual = sum(sum(s.values()) for s in TRUTH["manual_only"].values())
        print(f"\nSynthetic: {measured} quantities, max relative error {maximum_error:.9%}; "
              f"{coverage}/{coverage} supported objects, {coverage}/{coverage+manual} overall authored objects.")

    def test_manual_units_and_invalid_geometry(self):
        wall = Measurement(sheet=0,scope="wall",tool="polyline",points=[(0,0),(3,4),(3,9)])
        self.assertEqual(quantities(wall,2),{"LF":20})
        self.assertEqual(quantities(wall,None),{})
        area = Measurement(sheet=0,scope="slab",tool="rect",points=[(10,5),(0,0)],thickness=6)
        self.assertAlmostEqual(quantities(area,2)["CY"], 200*6/324)
        bad = Measurement(sheet=0,scope="floor",tool="polygon",points=[(0,0),(4,4),(0,4),(4,0)])
        self.assertEqual(quantities(bad,1),{})

    def test_explicit_mapping_and_conflict(self):
        with pdf.open(SAMPLE) as doc:
            events = list(process(doc[3],Run(rules=[{"scope":"wall","color":"#000000"}])))
            candidates = [data for event,data in events if event=="measurement"]
            self.assertEqual(len(candidates),1)
            self.assertEqual(candidates[0]["status"],"review")
            self.assertFalse(quantities(Measurement.model_validate(candidates[0]),None))
            events = dict(process(doc[3],Run(rules=[
                {"scope":"wall","color":"#000000"}, {"scope":"sawcut","color":"#000000"}])))
            self.assertNotIn("measurement",events)
            self.assertIn("competing rules"," ".join(events["warnings"]))

    def test_cropped_rotated_points_match_display(self):
        with pdf.open(SAMPLE) as doc:
            item = dict(process(doc[1],Run()))["measurement"]
            self.assertEqual(item["points"],[(210,75),(210,171)])

class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        from backend.main import app, initialize_storage
        initialize_storage(cls.temp.name)
        cls.client = TestClient(app)

    @classmethod
    def tearDownClass(cls):
        cls.client.close()
        cls.temp.cleanup()

    def test_upload_stream_revision_csv_and_price(self):
        r = self.client.post("/api/projects",files={"file":("local plan.pdf", SAMPLE.read_bytes(),"application/pdf")})
        self.assertEqual(r.status_code,200,r.text)
        project = r.json()
        self.assertEqual(project["name"],"local plan.pdf")
        self.assertEqual(len(project["sheets"]),4)
        base = f"/api/projects/{project['id']}"
        self.assertEqual(self.client.get(base+"/pdf").content,SAMPLE.read_bytes())
        with self.client.stream("POST",base+"/sheets/0/run",json={}) as response:
            self.assertIn("text/event-stream",response.headers["content-type"])
            lines = [line for line in response.iter_lines() if line]
        self.assertEqual(lines[0],"event: scale")
        self.assertEqual(lines[-2],"event: done")
        items = [json.loads(lines[i+1][6:]) for i,s in enumerate(lines) if s=="event: measurement"]
        self.assertEqual(len(items),8)
        state = self.client.get(base).json()["state"]
        state["items"] = items
        self.assertEqual(len(list(csv.reader(io.StringIO(self.client.post(base+"/csv",json=state).text)))),1)
        state["items"][0]["status"] = "approved"
        self.assertEqual(self.client.put(base,json=state).status_code,422)
        state["scales"] = {0:json.loads(lines[1][6:])}
        for item in items:
            item["status"] = "approved"
        r = self.client.put(base,json=state)
        self.assertEqual(r.status_code,200,r.text)
        self.assertEqual(r.json()["revision"],1)
        self.assertEqual(self.client.put(base,json=state).status_code,409)
        self.assertEqual(self.client.get(base+"?revision=0").json()["state"]["items"],[])
        self.assertEqual(self.client.get(base).json()["state"],r.json())
        exported = self.client.post(base+"/csv",json=state)
        rows = list(csv.DictReader(io.StringIO(exported.text)))
        self.assertEqual(len(rows),8)
        slab = next(row for row in rows if row["Takeoff Name"]=="Remove concrete slab")
        self.assertEqual(float(slab["Takeoff Quantity"]),24)
        self.assertAlmostEqual(float(slab["Cu Yd"]),24*6/324,places=6)
        price = self.client.post(base+"/price",json=state)
        self.assertEqual(price.status_code,200,price.text)
        priced = price.json()
        self.assertEqual(len(priced["items"]),8)
        self.assertTrue(priced["proposalFields"])
        self.assertAlmostEqual(priced["bid"],round(priced["cost"]*2.3),delta=1)

    def test_invalid_upload(self):
        response = self.client.post("/api/projects",files={"file":("invalid.pdf",b"%PDF-1.7\nbad","application/pdf")})
        self.assertEqual(response.status_code,422)

    def test_desk_reference_price(self):
        run = subprocess.run(["node",str(ROOT/"desk/cli.cjs")],text=True,capture_output=True,check=True,
            input=json.dumps({"csv":(ROOT/"samples/desk-reference.csv").read_text(),"name":"Fixture"}))
        result = json.loads(run.stdout)
        self.assertEqual((result["cost"],result["bid"]),(6325,14547))
        self.assertEqual([(line["category"],line["qty"],line["rate"],line["extended"])
                          for line in result["sections"][0]["lines"]],
                         [("Labor",8,400,3200),("Hauling",3,850,2550),("Equipment",1,575,575)])

if __name__ == "__main__":
    unittest.main()
