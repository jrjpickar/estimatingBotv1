# A2Z Estimating Bot (v1.0)

A2Z's Estimating Bot: drop a STACK takeoff CSV and the plan set, and it drafts the estimate, the cost sheet and the proposal from A2Z's real templates. You can open and edit all three, save them for the team, and download the proposal (.docx) and job costing (.xlsx). Runs as a GHL Marketplace app with automatic sign-in, or outside GHL with a passcode. Plain Node, no dependencies, no AI on this site.

**Keep this repo private.** `estimator/data/job_library.json` holds real customer names and bid prices.

## What's in it

| Path | What it is |
|---|---|
| `public/index.html` | The app. Tabs: **Builder** (takeoff, plans, autopilot, checks), **Cost sheet** (the Job Costing Worksheet laid out row by row, editable), **Proposal** (the proposal as a page, every field editable). Plus **Saved estimates** and **Admin**. |
| `netlify/functions/session.js` | Sign-in: GHL automatic sign-in, passcode sign-in, sign-out, who am I. |
| `netlify/functions/bot-data.js` | Sends the job library, rates and settings to the page, only after sign-in. |
| `netlify/functions/estimates.js` | Saved estimates: list, open (any version), save (each save is a new version), delete (admins only). |
| `netlify/functions/admin.js` | Admin view: Access, Health, Audit log, Team activity, Sign-ins. |
| `netlify/functions/estimate-check.js` | `POST` an estimate, get `{ ok, priced, issues }` back. |
| `netlify/functions/estimate-auto.js` | `POST { takeoffCsv, planPages?, inputs?, job?, markup? }`, get a draft estimate, checks, comps and the plan check. |
| `netlify/functions/estimate-docs.js` | `POST { estimate }`, get the proposal `.docx` and job costing `.xlsx` (base64). Named DRAFT while any FIX or QUESTION is open. |
| `netlify/lib/` | Sign-in and access (`auth.js`, same rules as the Estimating Desk), saved estimates, activity, Blobs, GHL users. |
| `estimator/` | The engine (same code as the Cowork plugin v0.7.0) and its data: job library, rates, default markup (130% on cost), production numbers, house style, the two templates. |
| `src/checker.template.html`, `tools/build.js` | Page source. `npm run build` builds `public/`. |
| `tools/dev-server.cjs` | Runs the site and real functions on your computer for testing (see the end). |

**Updating from an older version:** delete `netlify/edge-functions/passcode.js` (the old passcode gate). Sign-in is handled by the functions now, and the `?key=` link is no longer used.

## Signing in

**Inside GHL (Marketplace app):** people are signed in automatically as their GHL user. No passcode.
- Jesse Pickar is always senior admin (by email, GHL user id and name, even if the settings are wrong).
- Everyone else needs to be on the Access list (Admin, Access). People who aren't see "No Estimating Bot access".
- The sign-in lasts 7 days in that browser, so after opening it once in GHL you can also use the site directly with the same rights.

**Outside GHL (passcode):** the site asks for a name and the passcode.
- Passcode users are estimators: they can do everything except Admin and deleting saved estimates.
- Their name shows on saves and in the audit log as "Passcode sign-in".
- Changing `ESTIMATING_BOT_PASSCODE` signs every passcode user out.
- Leave the passcode blank to turn passcode sign-in off.

**Webhooks, Make, GHL workflows:** send the header `x-bot-passcode: <passcode>` with each request to the functions.

## Environment variables (Netlify, Site configuration, Environment variables)

| Name | Needed | What it's for |
|---|---|---|
| `SESSION_SECRET` | Yes | Signs sign-ins. A long random string (40+ characters). Changing it signs everyone out. |
| `GHL_APP_SHARED_SECRET` | For GHL | The Shared Secret from the Marketplace app (below). |
| `ESTIMATING_BOT_PASSCODE` | For outside GHL | The passcode. Use 12+ characters (short ones trip Netlify's secrets scan and are easy to guess). |
| `GHL_PIT_TOKEN` | For adding people | A GHL private integration token with `users.readonly`, so Admin can list A2Z's GHL users. Same one the Desk uses. |
| `SENIOR_ADMINS` | Optional | More senior admins, comma separated (names, emails or GHL user ids). Jesse is always included. |
| `GHL_LOCATION_ID` | Optional | Defaults to the A2Z sub-account. |
| `AUTH_ENFORCE` | Emergency only | `off` lets the site run without sign-in (never admin). Remove it right after. |

Redeploy after changing any of these.

## Set up the GHL Marketplace app

1. Go to marketplace.gohighlevel.com, My Apps, Create App.
   - Type: Private.
   - Distribution: Sub-account.
   - Same as the Desk's app, or add a second Custom Page to the Desk's app.
2. Under Advanced Settings, Auth, generate the **Shared Secret**. Copy it into Netlify as `GHL_APP_SHARED_SECRET` and redeploy.
3. Under Custom Pages (Modules), add a page:
   - Name: Estimating Bot.
   - URL: `https://<site>.netlify.app/`.
4. Install the app on the A2Z sub-account. "Estimating Bot" shows in the left menu.
5. Open it. You're signed in as Jesse Pickar, Senior admin. Go to Admin, Access and add the estimators.

From an opportunity, `https://<site>.netlify.app/?opportunityId=<id>&job=<project name>` labels the estimate with that opportunity.

## Using it

1. **Builder:** drop the STACK CSV in 1. Takeoff and one or more plan PDFs in 2. Plans. Autopilot drafts everything: scope lines, crew-days, loads, equipment, rates, the 130% markup, the plan check and the comps.
2. **Checks:** clear them.
   - **FIX** (red) means the estimate is wrong. Change it.
   - **QUESTION** (gold) needs a person to decide. Use the card's buttons, or Mark answered.
   - **CHECK** (gray) looks off. Fix it or mark it answered.
   - Files are named DRAFT until no FIX or QUESTION is left.
3. **Cost sheet:** edit any row (description, qty, rate), add or delete rows, change the markup or type a final bid.
   - The bid follows cost times markup until you type a bid yourself.
   - The "automatic pricing" button puts it back.
4. **Proposal:** edit the estimate #, date, customer, location, estimator, opening, each scope's lines and price, alternates, notes, exclusions, validity and payment terms.
   - What you see is what goes in the .docx.
5. **Save** (button or Ctrl+S): every save is a new version.
   - **Saved estimates** lists them with search.
   - You can open any version.
   - Admins can delete.
6. **Download** the proposal and job costing from the Cost sheet or Proposal tab.

## Admin (admins only)

- **Access:** add GHL users, make admin, remove access.
- **Health:** sign-in, passcode, GHL users, Blobs storage, engine, saved estimates, recent errors.
- **Audit log:** who saved, made files or ran autopilot, and when.
- **Team activity:** counts per person.
- **Sign-ins:** who signed in, how and when.

## Autopilot and the plan check (code, no AI)

- **Production numbers:** `estimator/data/production.json` holds starter worker-days and loads per SF / LF / EA.
  - They're tuned on 600 PCH, Montebello, the parking lot and the duplex.
  - Expect other jobs to be off until they're tuned with real crew-days and loads from finished jobs.
  - Edit the file and push.
- **Plan check:** plans are read in the browser (pdf.js from cdnjs) and never leave the computer. The check finds:
  - the sheets;
  - demo callouts that aren't in the takeoff (one click adds them);
  - by-others items (one click moves them to exclusions);
  - new work, hazardous materials, upper floor, occupied building, ceiling height and grid;
  - takeoff areas that don't match the plans.
- **Scanned sheets:** they have no text, so they're listed for a person to check.
- **Drafts:** every drafted line says where its number came from. Nothing goes to a customer automatically.

## Put it on GitHub and Netlify

1. Create a **private** GitHub repo and push this folder (or drag the files in with Add file, Upload files).
2. Netlify:
   - Add new site, Import an existing project, pick the repo.
   - `netlify.toml` sets the build, publish folder, functions and data files.
3. Add the environment variables above, then deploy.
4. Every push to `main` redeploys.

## Check that it works

```
npm test
```
This runs:
- the 31 engine tests;
- the 6 server tests (GHL sign-in, Jesse as senior admin, stranger blocked, passcode sign-in and its limits, saving and versions, files, admin views);
- a smoke test of the functions.

No Netlify needed.

To try the whole app on your computer:
```
node tools/dev-server.cjs 8888
```
- It uses test secrets and fake data storage. Never deploy it.
- Open `http://localhost:8888/` and use the test passcode `correct-horse-battery-7`.
- Open `http://localhost:8888/__ghl-frame?user=jesse` to fake the GHL sign-in.

## Changing things

- **A rule:**
  1. Edit `estimator/engine/lib/checks.js`.
  2. Add a test in `estimator/engine/test/checks.test.js`.
  3. Run `npm test` and push.
- **Rates, markup, production numbers:** `estimator/data/rates.json`, `defaults.json`, `production.json`.
- **Page look:** `src/checker.template.html`.
- **Keeping the engine in step with the Cowork plugin:** copy `skills/estimate-job/engine` and `skills/estimate-job/data` from the plugin over `estimator/`.

## Not in this site yet

- Reading scanned plan sets and counting symbols (AI plan reading, needs an Anthropic API key).
