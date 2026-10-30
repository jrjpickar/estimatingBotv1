// Local test server: serves public/ and runs the real Netlify functions with in-memory Blobs.
//   node tools/dev-server.cjs [port]      then open http://localhost:8888/
//   http://localhost:8888/__ghl-frame?user=jesse   fakes the GHL custom-page frame (auto sign-in)
//   GHL's pipeline and the Make webhook are faked too (tests/fake-ghl.cjs); /__fake shows what the bot sent
// Uses the test passcode / secrets from tests/helpers.cjs. For testing only, never deploy this.
const http = require("node:http"), fs = require("node:fs"), path = require("node:path");
const H = require("../tests/helpers.cjs");
const USERS = {
  jesse: { id: "neeX5r7tAWikhEMzrFEC", name: "Jesse Pickar", email: "jesse@a2zcs.net" },
  andie: { id: "IVFHrDqUqc7tkWwtmiXc", name: "Andie LaRue", email: "andie@a2zcs.net" },
  stranger: { id: "OUTSIDER000000000001", name: "Not Listed", email: "nobody@a2zcs.net" },
};
process.env.GHL_PIT_TOKEN = "pit";
// fake GHL pipeline + Make webhook (tests/fake-ghl.cjs); GET /__fake shows what was sent
const fake = require("../tests/fake-ghl.cjs").makeFake();
global.fetch = fake.fetch;
const port = Number(process.argv[2] || 8888);
http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  const m = u.pathname.match(/^\/\.netlify\/functions\/([a-z-]+)$/);
  if (m) {
    let body = ""; for await (const c of req) body += c;
    let handler; try { handler = require(path.join(__dirname, "../netlify/functions", m[1] + ".js")).handler; } catch (e) { res.writeHead(404); return res.end("no function"); }
    const out = await handler({ httpMethod: req.method, headers: req.headers, body, queryStringParameters: Object.fromEntries(u.searchParams) });
    res.writeHead(out.statusCode, out.headers || {}); return res.end(out.body);
  }
  if (u.pathname === "/__fake") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ hooks: fake.hooks.map((h) => ({ ...h.body, genProp: (h.body.genProp || "").length, costData: (h.body.costData || "").length })), puts: fake.puts, opps: fake.opps.map((o) => ({ id: o.id, stage: o.pipelineStageId })) }));
  }
  if (u.pathname === "/__ghl-frame") {
    const user = USERS[u.searchParams.get("user") || "jesse"];
    const payload = H.ghlContext(user);
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(`<!doctype html><title>Fake GHL</title><body style="margin:0"><div style="padding:6px;font:13px sans-serif">Fake GHL frame, signed in as ${user.name}</div><iframe id="app" src="/" style="width:100%;height:95vh;border:0"></iframe>
      <script>addEventListener("message",(e)=>{if(e.data&&e.data.message==="REQUEST_USER_DATA")e.source.postMessage({message:"REQUEST_USER_DATA_RESPONSE",payload:${JSON.stringify(payload)}},"*")});</script>`);
  }
  const file = path.join(__dirname, "../public", u.pathname === "/" ? "index.html" : u.pathname);
  if (fs.existsSync(file) && fs.statSync(file).isFile()) { res.writeHead(200, { "content-type": file.endsWith(".html") ? "text/html" : "application/octet-stream" }); return res.end(fs.readFileSync(file)); }
  res.writeHead(200, { "content-type": "text/html" }); res.end(fs.readFileSync(path.join(__dirname, "../public/index.html")));
}).listen(port, () => console.log("dev server on http://localhost:" + port));
