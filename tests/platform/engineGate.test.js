/**
 * AQUA engine startup gate (2026-11-24, audit/render-heap-oom).
 *
 * index.js listens before the AQUA engine import (which first restores every
 * store from the Mongo mirror) has finished. In that window an engine request
 * used to be metered (usageGuard) and then fall through to the platform's HTML
 * 404. Now the gate — first inside the engine router, after authentication,
 * before metering — answers 503 + Retry-After until the engine is mounted.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const express = require("express");
const { createEngineGate } = require("../../utils/engineGate");

function harness() {
  const gate = createEngineGate();
  const metered = [];
  const app = express();
  const engine = express.Router();
  engine.use(gate.middleware);
  engine.use((req, res, next) => { metered.push(req.path); next(); });   // stands in for usageGuard
  app.use("/api/aqua", (req, res, next) => { req.session = { userId: "u1" }; next(); }, engine);
  app.use((req, res) => res.status(404).send("<html>Page not found</html>"));   // the platform's HTML 404
  const mount = () => { const r = express.Router(); r.post("/chat", (req, res) => res.json({ ok: true })); engine.use(r); };
  return { app, gate, metered, mount };
}

async function request(app, method, url) {
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  try {
    const { port } = server.address();
    return await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method, path: url }, res => {
        let body = "";
        res.on("data", c => { body += c; });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on("error", reject);
      req.end();
    });
  } finally {
    server.close();
  }
}

test("while starting: 503 JSON with Retry-After, and nothing is metered", async () => {
  const h = harness();
  const r = await request(h.app, "POST", "/api/aqua/chat");
  assert.equal(r.status, 503);
  assert.equal(r.headers["retry-after"], "5");
  assert.equal(JSON.parse(r.body).code, "ENGINE_STARTING");
  assert.deepEqual(h.metered, []);
  assert.equal(h.gate.state, "starting");
});

test("once mounted: requests reach the engine (and are metered as before)", async () => {
  const h = harness();
  h.mount();
  h.gate.markMounted();
  const r = await request(h.app, "POST", "/api/aqua/chat");
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { ok: true });
  assert.deepEqual(h.metered, ["/chat"]);
});

test("if the engine failed to mount: 503 'AQUA engine unavailable', never the HTML 404", async () => {
  const h = harness();
  h.gate.markFailed();
  const r = await request(h.app, "POST", "/api/aqua/chat");
  assert.equal(r.status, 503);
  assert.equal(JSON.parse(r.body).error, "AQUA engine unavailable");
  assert.equal(r.headers["retry-after"], undefined);
});

test("index.js wires the gate first in the engine router and flips it on mount / failure", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../index.js"), "utf8");
  const gateAt = src.indexOf("aquaEngine.use(engineGate.middleware)");
  assert.ok(gateAt > 0, "gate registered");
  assert.ok(gateAt < src.indexOf("aquaEngine.use(engineEventTap())"), "before the event tap");
  assert.ok(gateAt < src.indexOf('usageGuard("chat_message")'), "before metering");
  const thenBlock = src.slice(src.indexOf('import("./aqua/router.js")'), src.indexOf("// AQUA app shell"));
  assert.match(thenBlock, /aquaMounted = true;\s*\n\s*engineGate\.markMounted\(\);/);
  assert.match(thenBlock, /\.catch\(\(err\) => \{\s*\n\s*engineGate\.markFailed\(\);/);
});
