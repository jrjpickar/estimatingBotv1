# Verification and integration

## Desk audit

| Desk source | Sandbox use |
|---|---|
| `estimator/engine/lib/common.js` | Exact STACK Takeoff Quantity headers, units, rounding, and ordered activity grouping |
| `estimator/engine/lib/autopilot.js`, `auto.js`, `price.js`, `checks.js` | Original draft production, labor, hauling, equipment, section and markup logic |
| `estimator/data/{rates,production,defaults,house_style}.json` | Original rate snapshot, production factors, proposal style, and 130% markup default |
| `netlify/lib/{autoRun,decisions}.js`, `proposalData.js`, `costsheet.js` | Original draft decisions, estimate/proposal fields and cost worksheet mapping |
| `netlify/functions/{auto-estimate,proposal-draft,estimate-started}.js` | Audited entry points. The sandbox handoff is a local CSV and draft JSON response. |

The adapter in `desk/adapter.cjs` runs the copied pure Desk core in a local Node process. It passes approved scope rows, the project name, optional markup, and an empty comparable-job library. It omits plan text from the pricing call to prevent text-only allowances for unmeasured scope. The draft uses the Desk's own production and default decision rules. It returns section costs, pricing issues, draft questions, scope lines, proposal fields, and the cost sheet. The workspace shows prices and cost lines. It does not implement the Desk's answer workflow or issue a proposal.

The CSV matches the columns of the Desk's attached STACK report fixture. Each row aggregates a scope and primary unit on one sheet. `Takeoff Description` carries the measurement IDs, and `Plan Name` carries the sheet reference. Slab CY is supplemental in `Cu Yd`. The primary slab quantity stays in SF so the existing Desk parser prices it once. Its current parser does not price supplemental CY. The API recalculates the export from saved or in-session geometry supplied by the client.

The existing Desk stores inputs and the latest draft by opportunity ID. It reprices from saved answers, exposes the draft in Proposal Details, and uses the existing costing and proposal steps to hand off to GHL and Make. The sandbox stores plan and takeoff revisions by local project ID. The CSV is the staging handoff for a future opportunity mapping.

## Measured results

| Check | Result |
|---|---|
| Controlled quantity accuracy | 10/10 quantities matched ground truth, including one slab CY value. Maximum relative error printed by the test was 0.000000000%. |
| Supported-object coverage | 9/9 objects in the explicitly supported fixtures. |
| Overall synthetic automation coverage | 9/12 authored objects, 75%. Two raster strokes and one unbound vector stroke require manual measurement. No automatic quantities were assigned to those three. |
| Desk price parity | Original Desk and sandbox both returned $6,325 direct cost and $14,547 draft bid on the attached Desk fixture without plan pages or estimator answers. Labor $3,200, hauling $2,550, equipment $575. |
| Browser workflow | 2 Playwright Chromium tests passed. Tested local file picker upload, four sheet navigation, intermediate streamed results, all five manual tools, resize and move, undo/redo, calibration, reclassification, approval, draft pricing, CSV download, save and reopen. The upload-to-export scenario observed zero external browser requests and zero uncaught page errors. |
| Local build | TypeScript checking and Vite build passed. Vite reported a large bundle warning. PDF.js and its rendering assets are served from the local server. |
| Original PDF integrity | Uploaded bytes matched downloaded bytes. |
| Geometry and API | 7 automated Python tests cover manual area and length, invalid polygons, explicit style rules and conflicts, missing scale, all measurement units, rotated/cropped sheets, raster warnings, upload, SSE, approval gating, stale revisions, reload, CSV and pricing. |

The supplied archive included a Desk CSV fixture and plan-text fixture. It did not include an actual construction PDF. The automated accuracy and coverage figures apply only to the included synthetic set. All runtime inputs and assets are local. The app contains no model, OCR, inference client, or external service integration.

## Limits and production work

- Validate on actual A2Z demolition plan sets with estimator-marked ground truth before relying on automated coverage. Calibrate each sheet and confirm plan revisions, viewport scale and demolition legends. Mixed-scale views need separate calibrated sheets or projects. There is no title-block scale inference.
- Ordinary untagged monochrome drawings may require mostly manual takeoff. Dense hatching, curves, arcs, islands, holes, overlapping strokes, stacked plan views, complex symbols, and repeated details need estimator review. The engine does not infer quantities from notes or resolve leaders, automatically subtract holes, or detect partial overlaps between measurements.
- The viewer supports one PDF per project. Overlay editing uses existing vertices and compatible scope types. Use manual retracing when the shape or unit needs to change. Cross-sheet and cross-project revisions and overlap reconciliation need production design.
- Confirm export names, units and upload behavior with the current Desk in staging. Map project IDs, plan versions, approvals, question answers, and cost worksheet/proposal handoff before wiring the adapter. Agree on whether slab CY should affect disposal pricing and how to prevent double charging. Refresh rates through a controlled snapshot.
- Add production authentication, access controls, file screening, durable storage and backups, PDF parser isolation, processing limits, and browser/performance testing on large drawing sets. No production code, credentials, endpoints, GHL, Make, or deployment were changed.


## Netlify target verification

- Hosted TypeScript and Vite build completed. Chromium passed both browser tests against the hosted assets and pricing function handler. Tests exercised local file selection, four sheets, incremental overlays, editing, calibration, pricing, export, and persistent reopening.
- The pricing function returned $6,325 cost and $14,547 bid on the Desk reference fixture.
- The hosted variant keeps the uploaded PDF and saved takeoff on-device. The pricing function receives the scope quantities and markup, with anonymous sheet numbers. The public bundle excludes the Desk rate tables. Hosted raster detection flags a backdrop for manual tracing.
- The Netlify account session reached sign-in. No live deployment URL or Netlify-hosted execution was verified.
