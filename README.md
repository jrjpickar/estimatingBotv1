# A2Z Takeoff Engine V1

A local commercial interior demolition takeoff workspace. It stores PDF bytes and saved takeoff revisions on your computer. The app uses deterministic rules and geometry. No account, API key, model, or production connection is required.

## Deploy to Netlify

Extract this ZIP at the root of a dedicated **private sandbox repository**. In your Netlify account, import that repository as a **new sandbox site**. Leave the base directory blank. The included `netlify.toml` sets the build command to `npm run build:netlify`, the publish directory to `dist`, and the Functions directory to `netlify/sandbox-functions`. The site needs zero user-configured environment variables or credentials. Use a sandbox project with no inherited Desk secrets. Keep Netlify secret scanning enabled.

After deployment, open the site URL and click **Open sample** or **Upload PDF**. Netlify serves the app and a pricing function. A browser worker processes PDF geometry. IndexedDB stores originals and revisions on that browser and site URL. Clearing site data erases those projects. Projects do not sync between browsers or deployment URLs. Pricing sends approved quantities and markup to the Netlify function. PDF bytes, project names, sheet labels and measurement IDs stay in the browser. For a team-only sandbox, set access controls on the sandbox site before sharing it. The pricing endpoint otherwise responds to visitors who can reach the site.

Deploy the repository through Netlify or use the Netlify CLI with its Functions directory. The published site requires the pricing function as well as the static build.

## Start locally

Run this sandbox on your computer. Setup requires zero environment variables or credentials. Extract the ZIP and open a terminal in the folder that directly contains `package.json` and `backend/`.

Install Python 3.11 or 3.12 and Node.js 22.12 or newer on a system supported by both runtimes.

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r backend/requirements.txt
npm ci
npm run build
npm start
```

On Windows PowerShell, use `.venv\Scripts\Activate.ps1` to activate the environment. Dependency installation requires internet access. After installation and build, the workspace runs locally without internet access. Stop it with Ctrl+C.

Open [127.0.0.1:8765](http://127.0.0.1:8765) in a current desktop browser. Keep the server bound to loopback. The sandbox has no user accounts or access controls. Use a supported host or VM if your OS cannot install the required runtimes.

## Test your own plans

1. Click **Upload PDF** and choose a file from your computer. The sandbox accepts one unlocked PDF per project, up to 100 MiB and 300 sheets. **Open sample** loads the included four-sheet test drawing into a separate project.
2. Select a sheet. To set its scale, click **Calibrate**, select the ends of a verified dimension, enter its length in decimal feet, and apply the scale. Counts need no scale. Recalibration returns approved length and area items on that sheet to review.
3. Select a scope and trace it. **Line** and **Rectangle** take two points. **Polyline** and **Polygon** take successive vertices and finish with Enter or **Finish trace**. **Count** adds one item per click. Snap uses PDF endpoints and existing overlay vertices. Turn it off for free placement. Pan and zoom are in the viewer controls.
4. Click **Run sheet takeoff** to add candidates from completed rules as the server streams them. If your plan uses a distinct verified stroke style for one demolition scope, select that scope and map the stroke color and dashed/solid type under **Vector style rules**. The rule applies across the sheet. Inspect every candidate.
5. Select an overlay or its list row. Drag the body to move it, or drag a handle to resize it. You can reassign to another scope with a compatible unit, reject, delete, undo, or redo. Add known slab thickness in inches for CY. Edited measurements return to review.
6. Approve correct items. The draft estimate and STACK CSV use approved quantities only. Click **Save** before closing. Reopen the PDF from **Open saved project**. Use **Saved revisions** to load an earlier revision into the current project and save it as a new revision.

Default storage is the repository's `data/` directory. Back up this directory with the server stopped to preserve original PDFs and all saved revisions. Undo and redo history are session-local. Deleted automatic items can reappear on a subsequent run. Reject an item to retain its exclusion and evidence.

## Rules and evidence

- **Tagged annotations.** A PDF Line, PolyLine, Polygon, or Circle annotation with exact content `A2Z TAKEOFF: <scope>` binds geometry directly to a scope. Circle centers represent one count. Area uses polygon vertices. For known slab thickness, use `A2Z TAKEOFF: slab THICKNESS=6IN`, replacing 6 with the verified thickness.
- **Tagged scale bars.** A single Line annotation containing `A2Z SCALE BAR: 10 FT` supplies a 10 ft calibration along its endpoints. A sheet with multiple tagged bars or only printed scale text requires manual calibration. A manual calibration takes precedence.
- **Legends.** `A2Z LEGEND: <scope>` beside a unique stroked vector swatch maps its RGB and dashed/solid style to a category. The swatch must end 0–36 PDF points to the left of the label and its vertical center must fall inside the label's text bounds. The swatch itself is excluded. A slab legend can include `THICKNESS=6IN`. Conflicting mappings are flagged.
- **Scope keys.** `wall`, `floor`, `ceiling`, `slab`, `door`, `fixture`, `sawcut`, `millwork`. Linear rules accept one continuous open line path. Area rules accept a simple closed straight path, rectangle, or quad. A count style rule accepts a single rectangle or quad as one marker. Curves, disconnected subpaths, holes, and general symbols need manual review.
- **Scans.** OpenCV Canny edges and Hough lines flag unclassified candidates on sheets with a raster backdrop. They never create scoped quantities. Trace and calibrate manually.
- **Audit.** Every measurement has a sheet, stable ID, editable vertices, source and status. The vectors API exposes extracted strokes and path commands, text positions, annotations, and PDF references. Draft matching does not establish demolition intent beyond the supplied evidence.

## Run tests

```sh
python -m unittest discover -s tests -v
npx playwright install chromium
npm run build
npm test
```

Stop any local app server on port 8765 before the browser tests. They start an isolated server and temporary database. Regenerate the synthetic PDF with `python samples/generate.py`. See [VERIFICATION.md](VERIFICATION.md) for measured results, the Desk contract, and remaining integration work.

### Hosted verification

Run `npm run build:netlify` and `npm test -- --config=playwright.netlify.config.ts` after installing Chromium for Playwright. The suite serves the static build and invokes the same pricing handler that ships to Netlify. The hosted target uses MuPDF WebAssembly to extract annotated geometry and styled vector strokes. It flags raster backdrops for manual tracing and does not run the local OpenCV line detector. The hosted workspace reuses the Desk pricing adapter server-side.
