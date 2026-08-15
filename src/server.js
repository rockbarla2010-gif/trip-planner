// Minimal dependency-free web UI/API wrapper around the same orchestration loop.
//   GET  /            -> a tiny HTML form
//   POST /plan        -> JSON body (TripContext fields) => { plan, context }
//
// Uses the LLM orchestrator when ANTHROPIC_API_KEY is set, else the demo pipeline.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "./env.js";
loadDotEnv();

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

import { createTripContext, validateForPlanning } from "./tripContext.js";
import { createRunLogger } from "./logger.js";
import { hasApiKey } from "./anthropic.js";
import { runDeterministicPipeline, runOrchestratorLLM, formatPlan } from "./orchestrator.js";

const PORT = process.env.PORT || 3000;

const FORM = `<!doctype html><meta charset=utf-8><title>Trip Planner</title>
<style>body{font-family:system-ui;max-width:720px;margin:2rem auto;padding:0 1rem}
label{display:block;margin:.5rem 0 .2rem;font-size:.85rem;color:#555}
input,select{width:100%;padding:.4rem;box-sizing:border-box}
pre{white-space:pre-wrap;background:#f6f6f6;padding:1rem;border-radius:8px}
.row{display:flex;gap:1rem}.row>div{flex:1}button{margin-top:1rem;padding:.6rem 1.2rem}</style>
<h1>Multi-Agent Trip Planner</h1>
<form id=f>
<div class=row><div><label>Destination</label><input name=destination value=Tokyo></div>
<div><label>Origin</label><input name=origin value="New York"></div></div>
<div class=row><div><label>Start</label><input name=start_date value=2026-09-10></div>
<div><label>End</label><input name=end_date value=2026-09-14></div></div>
<div class=row><div><label>Travelers</label><input name=traveler_count type=number value=2></div>
<div><label>Budget</label><input name=budget_total type=number value=3000></div>
<div><label>Pace</label><select name=pace><option>relaxed<option selected>moderate<option>packed</select></div></div>
<div class=row><div><label>Interests (csv)</label><input name=interests value="Culture,Food"></div>
<div><label>Dietary (csv)</label><input name=dietary_restrictions value=""></div></div>
<button>Plan trip</button></form>
<pre id=out>Submit to see the plan…</pre>
<script>
const f=document.getElementById('f'),out=document.getElementById('out');
f.onsubmit=async e=>{e.preventDefault();out.textContent='Planning…';
const d=Object.fromEntries(new FormData(f));
const r=await fetch('/plan',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(d)});
const j=await r.json();out.textContent=j.plan||JSON.stringify(j,null,2);};
</script>`;

function csv(v) {
  return Array.isArray(v) ? v : String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function contextFromBody(b) {
  return createTripContext({
    destination: b.destination || "Tokyo",
    origin: b.origin || "",
    start_date: b.start_date || "",
    end_date: b.end_date || "",
    traveler_count: b.traveler_count ? parseInt(b.traveler_count, 10) : 1,
    budget_total: b.budget_total != null && b.budget_total !== "" ? Number(b.budget_total) : null,
    budget_currency: b.budget_currency || "USD",
    preferences: {
      cuisine: csv(b.cuisine),
      dietary_restrictions: csv(b.dietary_restrictions),
      interests: csv(b.interests),
      pace: b.pace || "moderate",
    },
    constraints: csv(b.constraints),
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    const file = path.join(PUBLIC_DIR, "index.html");
    if (fs.existsSync(file)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(fs.readFileSync(file));
    }
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(FORM); // fallback to the minimal inline form
  }
  if (req.method === "POST" && req.url === "/plan") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        const ctx = contextFromBody(parsed);
        const problems = validateForPlanning(ctx);
        if (problems.length) {
          res.writeHead(400, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: "invalid TripContext", problems }));
        }
        const logger = createRunLogger({ quiet: true });
        if (hasApiKey() && !parsed.demo) {
          await runOrchestratorLLM(ctx, parsed.request || `Plan a trip to ${ctx.destination}.`, logger);
        } else {
          await runDeterministicPipeline(ctx, logger);
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ plan: formatPlan(ctx), context: ctx, log: logger.file }));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`Trip Planner web UI on http://localhost:${PORT}  (mode: ${hasApiKey() ? "LLM" : "demo"})`);
});
