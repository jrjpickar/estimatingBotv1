# A2Z Estimating Bot (v1.1)

A2Z's Estimating Bot. The flow:

1. **Jobs:** pick an opportunity from the GHL pipeline (same stages as the Estimating Desk). It moves to Proposal In Progress.
2. **Drop the STACK takeoff and the plan set.** Autopilot pulls the job details from GHL and drafts the estimate, the cost sheet and the proposal, worded the way A2Z writes (Training).
3. **Review:** clear the FIX and QUESTION items, edit the cost sheet and proposal on the page.
4. **Send:** the cost sheet (.xlsx) and proposal (.docx), filled from A2Z's own templates, go to the Make webhook in base64, and the opportunity gets the proposal fields and moves to Generate Proposal.

Runs as a GHL Marketplace app with automatic sign-in, or outside GHL with a passcode. Plain Node, no dependencies, no AI on this site.

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
| `netlify/functions/jobs.js` | The GHL pipeline (estimating stages + open change orders) and Start estimate (stage move). |
| `netlify/functions/estimate-send.js` | Send: posts `costData` (.xlsx) and `genProp` (.docx) to Make, then updates the opportunity. |
| `netlify/functions/training.js` | Training uploads (proposals and cost sheets) and what the bot learned from them. |
| `netlify/lib/` | Sign-in and access (`auth.js`, same rules as the Estimating Desk), GHL pipeline (`ghl.js`, same pipeline, stages and custom fields as the Desk), saved estimates, training, activity, Blobs. |
| `estimator/` | The engine (same code as the Cowork plugin v0.8.0) and its data: job library, rates, default markup (130% on cost), production numbers, house style, and the two templates: `A2Z_Proposal_Template.docx` and `Job_Costing_Worksheet_V3.xlsx`. |
| `src/checker.template.html`, `tools/build.js` | Page source. `npm run build` builds `public/`. |
| `tools/dev-server.cjs` | Runs the site and real functions on your computer for testing (see the end). |

**Updating from an older version:** replace the whole repo with this zip, then delete:

- `netlify/edge-functions/passcode.js` (the old passcode gate; sign-in is handled by the functions now, and the `?key=` link is no longer used);
- `estimator/data/templates/A2Z_Make_Master_Proposal_Template_v17.docx` (replaced by `A2Z_Proposal_Template.docx`).

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
| `GHL_PIT_TOKEN` | Yes, for Jobs and Send | A GHL private integration token. Same one the Desk uses. It needs `users.readonly` (Admin, estimator names), `opportunities.readonly` and `opportunities.write` (Jobs, stage moves, proposal fields), `locations/customFields.readonly` (to find the proposal fields) and `contacts.readonly` (company names). |
| `MAKE_BOT_WEBHOOK_URL` | Optional | Where Send posts the files. Defaults to `https://hook.us2.make.com/srx3k2i5fbmy9y68ls9gkoa9h1jji7tt`. |
| `GHL_PIPELINE_ID` | Optional | Defaults to the Jobs pipeline the Desk uses. |
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

## Jobs (like the Estimating Desk)

- **Jobs** lists the main pipeline's estimating stages (New Lead, Proposal In Progress, Generate Proposal), the sent ones (Proposal Sent, In Negotiation, Pending Decision) and open change orders. It shows the customer (contact company), job address (the `jobaddress` field, else the contact's address), Project Name, estimator (assigned user) and whether the bot has an estimate for it.
- **Start estimate** opens a new estimate filled with those details, linked to the opportunity, and moves a New Lead to Proposal In Progress (a change order from Customer Requested to CO In Progress), the same rule as the Desk's Start Estimate. Jobs already further along keep their stage.
- **Opening from an opportunity:** `https://<site>.netlify.app/?opportunityId=<id>` opens that job directly.
- The bot doesn't call the Desk's Start Estimate webhook (that one builds the Google Sheet cost sheet); the bot makes its own cost sheet.

## Send to Make

- The Send button is locked while any FIX or QUESTION is open. Clicking it twice saves the estimate, then:
  1. fills A2Z's two templates from the saved version;
  2. POSTs JSON to the Make webhook;
  3. if the estimate is linked to an opportunity: writes the proposal custom fields and moves it to Generate Proposal (a change order to Generate) in one update, the same as the Desk's Build Proposal.
- If the webhook fails, nothing changes in GHL.
- What Make receives:

| Key | What it is |
|---|---|
| `costData` | Job Costing Worksheet V3, filled (.xlsx, base64). `costDataFileName`, `costDataMimeType` |
| `genProp` | The proposal from `A2Z_Proposal_Template.docx`, filled (.docx, base64). `genPropFileName`, `genPropMimeType` |
| `jobAddress` | Job address, in capitals like the proposal |
| `opportunityId`, `opportunity_name`, `pipeline`, `is_change_order` | The GHL opportunity (blank when the estimate isn't linked) |
| `estimate_number`, `customer_company`, `total_price`, `total_cost`, `markup` | Summary |
| `estimator_name`, `estimator_email`, `estimator_phone` | From the house style, or the GHL user |
| `proposal_fields` | The 15 fields, same keys and formats as the Desk writes to GHL (`scope_name`, `scope_bullets1`, `scope_total1` ... `job_address`) |
| `estimateId`, `version`, `sentBy`, `sentAt` | Which saved version went out, and who sent it |

- **Heads up:** if a GHL workflow already makes the proposal PDF when an opportunity hits Generate Proposal (the Desk's flow), it will still run. Turn it off or filter it if Make now makes the PDF from `genProp`.

## Training

- **Training** (admins upload, everyone can see): drop past A2Z proposals (.pdf or .docx) and Job Costing Worksheets (.xlsx), many at once.
- Code reads them, no AI:
  - from proposals: each scope line, scope names, totals and job-specific exclusions;
  - from cost sheets: each line's type, description, quantity and rate.
- What it does with that:
  - autopilot rewrites its scope lines in A2Z's wording when the item matches a learned line (keeping the quantity and sheet), and uses A2Z's most common scope names;
  - equipment and misc lines take A2Z's usual wording;
  - a rate far from what past cost sheets used, or an item most past jobs include but this one doesn't, shows as a CHECK;
  - proposals with a total become comps.
- Scanned PDFs have no text and are skipped. Uploading the same job twice counts it twice; remove one copy.

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
4. **Proposal:** edit the estimate #, date, customer, job location, estimator, up to 3 scopes (name, lines, price) and the exclusions added for this job.
   - What you see is what goes in the .docx.
   - Notes, the standard exclusions, the terms and the signature block are fixed in A2Z's template, so they show read-only.
   - The template has no alternates and holds 3 scopes; the checks flag anything that won't print.
5. **Send** when the checks are clear (see Send to Make).
6. **Save** (button or Ctrl+S): every save is a new version.
   - **Saved estimates** lists them with search.
   - You can open any version.
   - Admins can delete.
7. **Download** the proposal and job costing from the Cost sheet or Proposal tab any time (named DRAFT while questions are open).

## Admin (admins only)

- **Access:** add GHL users, make admin, remove access.
- **Health:** sign-in, passcode, GHL users, GHL pipeline, Make webhook, training, Blobs storage, engine, saved estimates, recent errors.
- **Audit log:** who started, saved, sent, made files, trained or ran autopilot, and when.
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
- the 35 engine tests (including the proposal template and training);
- the 14 server tests (GHL sign-in, Jesse as senior admin, stranger blocked, passcode sign-in and its limits, saving and versions, files, admin views, Jobs and stage moves, Send to Make and the GHL update, training uploads), against a fake GHL and a fake Make webhook;
- a smoke test of the functions.

No Netlify needed.

To try the whole app on your computer:
```
node tools/dev-server.cjs 8888
```
- It uses test secrets and fake data storage. Never deploy it.
- Open `http://localhost:8888/` and use the test passcode `correct-horse-battery-7`.
- Open `http://localhost:8888/__ghl-frame?user=jesse` to fake the GHL sign-in.
- The GHL pipeline and the Make webhook are fake too (`tests/fake-ghl.cjs`); `http://localhost:8888/__fake` shows what the bot sent.

## Changing things

- **A rule:**
  1. Edit `estimator/engine/lib/checks.js`.
  2. Add a test in `estimator/engine/test/checks.test.js`.
  3. Run `npm test` and push.
- **Rates, markup, production numbers:** `estimator/data/rates.json`, `defaults.json`, `production.json`.
- **Page look:** `src/checker.template.html`.
- **Proposal template:** replace `estimator/data/templates/A2Z_Proposal_Template.docx` (keep the same `{{ }}` field names), and update the `template` part of `estimator/data/house_style.json` if the fixed notes or terms change.
- **Keeping the engine in step with the Cowork plugin:** copy `skills/estimate-job/engine` and `skills/estimate-job/data` from the plugin over `estimator/`.

## Not in this site yet

- Reading scanned plan sets and counting symbols (AI plan reading, needs an Anthropic API key).
