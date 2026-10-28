# A2Z Estimating Bot

A2Z's estimate checker page and the estimating engine behind it, ready for GitHub and Netlify. Plain Node, no dependencies, no AI on this site.

**Keep this repo private.** `estimator/data/job_library.json` holds real customer names and bid prices.

## What you get

| Path | What it is |
|---|---|
| `public/index.html` (same as `checker.html`) | The Estimating Bot page. Drop a STACK CSV for scope lines and comps, enter cost lines, see totals, markup, margin and every FIX / QUESTION / CHECK. Dark or colorful GHL theme. Opens and saves `estimate.json`. |
| `netlify/functions/estimate-check.js` | `POST` an estimate, get `{ ok, priced, issues }` back. |
| `netlify/functions/estimate-auto.js` | `POST { takeoffCsv, inputs?, facts?, job?, markup? }`, get a draft estimate, checks, comps and a review sheet. |
| `netlify/functions/estimate-docs.js` | `POST { estimate, takeoffCsv?, force? }`, get the proposal `.docx` and job costing `.xlsx` (base64) filled from A2Z's real templates. Refuses while FIX items remain unless `force: true` (files are then named DRAFT). |
| `netlify/edge-functions/passcode.js` | Passcode gate in front of the page and all three functions. The passcode comes from the `ESTIMATING_BOT_PASSCODE` environment variable. |
| `netlify/lib/engine.js` | Shared loader the three functions use (finds `estimator/data`). |
| `estimator/engine/` | The engine (same code as the Cowork plugin v0.4.0): STACK parsing, comps, pricing, checks, auto draft, template fillers. |
| `estimator/data/` | Job library, rates, default markup (130% on cost), house style, and the two templates. |
| `estimator/training-notes.md` | The training lessons the rules come from. |
| `src/checker.template.html`, `tools/build.js` | Page source. `npm run build` inlines the engine, rates, library and defaults into `public/`. |

## Put it on GitHub

1. Create a new **private** repo (for example `a2z-estimating-bot`).
2. Unzip this folder and push it:
   ```
   cd a2z-estimating-bot
   git init
   git add .
   git commit -m "A2Z Estimating Bot"
   git branch -M main
   git remote add origin https://github.com/<you>/a2z-estimating-bot.git
   git push -u origin main
   ```
   Or drag the files into the repo on github.com (Add file, Upload files).

## Deploy on Netlify

1. Netlify, Add new site, Import an existing project, GitHub, pick the repo.
2. Leave the settings as they come. `netlify.toml` already sets the build command (`npm run build`), the publish folder (`public`), the functions folder and the data files the functions need.
3. Before the first deploy (or right after, then redeploy): Site configuration, Environment variables, add `ESTIMATING_BOT_PASSCODE` with the passcode you want. Until it's set the whole site stays locked.
4. Deploy. The page is at `https://<site>.netlify.app/`.

## Passcode

- **People:** the site asks for the passcode once, then remembers that browser for 30 days. `/__logout` signs out.
- **Changing it:** update `ESTIMATING_BOT_PASSCODE` in Netlify and redeploy. Everyone has to enter the new one.
- **In the GHL iframe:** some browsers (Safari especially) block cookies inside iframes, so the login won't stick there. Use `https://<site>.netlify.app/?key=<passcode>` as the custom menu link instead. Only people who can see that GHL menu link can see the passcode.
- **Webhooks, Make, GHL workflows:** send the header `x-bot-passcode: <passcode>` (or `Authorization: Bearer <passcode>`) with each request to the functions.
- The page and the job library inside it are only sent after the passcode check, so nothing is visible without it.

Every push to `main` redeploys.

## Put it in GHL

- **Custom menu link:** Agency Settings, Custom Menu Links, new link to `https://<site>.netlify.app/?key=<passcode>`, open in iFrame, assign it to the A2Z sub-account and the estimators.
- **Colorful theme:** add `?theme=color` to the link. Each person can also switch with the button in the header.
- **From an opportunity:** `https://<site>.netlify.app/?opportunityId=<id>&job=<project name>` labels the page for that job.
- **From a workflow or Make:** send a webhook (POST, JSON body, header `x-bot-passcode`) to `/.netlify/functions/estimate-check` and branch on `ok`.

## Check that it works

```
npm test
```
Runs the 21 engine tests, calls all three functions directly, and tests the passcode gate (no Netlify needed).

Live check after deploy:
```
curl -X POST https://<site>.netlify.app/.netlify/functions/estimate-check \
  -H "Content-Type: application/json" \
  -H "x-bot-passcode: <passcode>" \
  -d '{"sections":[{"name":"Interior","lines":[{"category":"Labor","description":"4-man crew x 2 days","qty":2,"rate":1600}]}],"markup":1.3,"scopes":[{"name":"Demolition","lines":["Properly remove carpet"]}]}'
```

## Changing things

- **A rule:** edit `estimator/engine/lib/checks.js`, add a test in `estimator/engine/test/checks.test.js`, run `npm test`, push.
- **Rates or default markup:** `estimator/data/rates.json`, `estimator/data/defaults.json`. Push and the page rebuilds with the new values.
- **Page look:** `src/checker.template.html`, then push.
- Keep the engine in step with the Cowork plugin: copy `skills/estimate-job/engine` and `skills/estimate-job/data` from the plugin over `estimator/` when the plugin changes.

## Not in this site yet

- Saving estimates per opportunity so the team shares one copy (planned: Netlify Blobs, like the Desk's due dates).
- Reading the plan set and drafting crew-days and loads. Those are the AI steps and run in Cowork with the plugin; `estimate-auto` accepts their results as `facts` and `inputs`.
