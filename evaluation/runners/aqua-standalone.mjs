/**
 * AQEval — sessionless AQUA harness.
 *
 * Mounts the FROZEN engine (aqua/router.js) on a bare express app so
 * benchmarks can hit /api/aqua/chat directly:
 *   · no platform login, no credit metering (both live in index.js, which is
 *     not loaded here — the engine itself supports sessionless callers)
 *   · isolated data dir (AQUA_DATA_DIR) so eval traffic never touches
 *     production conversations, memory, or the Mongo mirror
 *   · zero modifications to the platform — this file only imports it
 *
 * Environment parity with the main server (index.js):
 *   1. The repository-root .env is loaded FIRST — before any AQUA module is
 *      imported — with the same semantics as index.js (`dotenv.config()`:
 *      real shell exports always win; .env only fills the gaps). dotenv is
 *      resolved from the engine's own dependency tree — no new deps.
 *   2. Bare provider keys are aliased into the numbered slots the frozen
 *      engine reads (groq.js: GROQ_API_KEY_1..4, gemini.js: GEMINI_KEY_1..8,
 *      openrouter.js: OPENROUTER_API_KEY_1..4). The root .env carries the
 *      bare spellings (GROQ_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY);
 *      production sets the numbered ones directly. Aliasing is additive and
 *      never overwrites a slot that is already set, so both worlds work.
 *      This mirrors the engine's own KeyPool convention (search/keyPool.js
 *      honors bare + _1.._N) without touching frozen code. Every other
 *      variable in .env (TOGETHER/OPENAI/ANTHROPIC/HF keys, etc.) lands in
 *      process.env verbatim, exactly as under the main server.
 *
 * Closed-book benchmark hygiene: because .env now loads automatically, the
 * harness actively STRIPS web-search keys (SERPER/TAVILY, bare + _1.._20)
 * after loading it, so AQUA cannot consult the web mid-question — see
 * docs/METHODOLOGY.md §closed-book. Set AQEVAL_ALLOW_WEB_SEARCH=1 to opt
 * out for explicitly open-book runs (the manifest records key presence).
 *
 * Usage (from the repo root, after `npm install` inside aqua/):
 *   node evaluation/runners/aqua-standalone.mjs
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const aquaDir = path.join(repoRoot, "aqua");

// Resolve deps from the engine's own dependency tree (no new deps).
const require = createRequire(path.join(aquaDir, "package.json"));

// ── 1. Root .env — BEFORE any AQUA import ────────────────────────────────────
// Same load semantics as index.js (`require("dotenv").config()`): existing
// process.env values are never overridden, so shell exports keep priority.
const envPath = path.join(repoRoot, ".env");
if (existsSync(envPath)) {
  require("dotenv").config({ path: envPath, quiet: true });
} else {
  console.warn(`AQEval harness: no .env at ${envPath} — relying on shell environment only`);
}

// ── 2. Bare → numbered-slot provider key aliases ─────────────────────────────
// The frozen providers read ONLY numbered slots; the root .env uses bare
// names. Fill slot _1 from the bare name when the slot is empty. Additive
// only — numbered slots set in the shell or .env are never overwritten.
const KEY_ALIASES = [
  ["GROQ_API_KEY",       "GROQ_API_KEY_1"],       // aqua/src/providers/groq.js
  ["OPENROUTER_API_KEY", "OPENROUTER_API_KEY_1"], // aqua/src/providers/openrouter.js
  ["GEMINI_API_KEY",     "GEMINI_KEY_1"],         // aqua/src/providers/gemini.js (base name differs)
  ["GEMINI_KEY",         "GEMINI_KEY_1"],         // bare engine-style spelling, if ever used
];
for (const [from, to] of KEY_ALIASES) {
  if (process.env[from] && !process.env[to]) process.env[to] = process.env[from];
}

// ── 3. Closed-book: strip web-search keys loaded from .env ───────────────────
const allowWeb = process.env.AQEVAL_ALLOW_WEB_SEARCH === "1";
if (!allowWeb) {
  for (const prefix of ["SERPER_API_KEY", "TAVILY_API_KEY"]) {
    delete process.env[prefix];                                        // bare
    for (let i = 1; i <= 20; i++) delete process.env[`${prefix}_${i}`]; // keyPool slots _1.._20
  }
}

// ── 4. Isolated engine state — never the production data dir ─────────────────
const dataDir = process.env.AQEVAL_DATA_DIR ?? path.join(here, "..", ".aqua-eval-data");
mkdirSync(dataDir, { recursive: true });
process.env.AQUA_DATA_DIR = dataDir;
// .env carries MONGO_URI; keep the mirror off by default so eval state stays
// on local disk and production Mongo is never touched.
process.env.AQUA_DISABLE_MONGO_MIRROR = process.env.AQUA_DISABLE_MONGO_MIRROR ?? "1";

// ── 5. Mount the frozen engine (imports run AFTER env is fully prepared) ─────
const express = require("express");

const { default: aquaRouter } = await import(
  pathToFileURL(path.join(aquaDir, "router.js")).href
);

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use("/api/aqua", aquaRouter);
app.get("/healthz", (_req, res) => res.json({ ok: true, harness: "aqeval" }));

// Key visibility per provider family — counts only, values never logged.
const countSlots = (base, n) => {
  let c = 0;
  for (let i = 1; i <= n; i++) if (process.env[`${base}_${i}`]) c++;
  return c;
};

const port = Number(process.env.AQEVAL_AQUA_PORT ?? 8877);
app.listen(port, "127.0.0.1", () => {
  console.log(`AQEval harness: AQUA engine on http://127.0.0.1:${port}/api/aqua`);
  console.log(`  data dir: ${dataDir} (isolated)`);
  console.log(`  env: ${existsSync(envPath) ? envPath : "(shell only)"}`);
  console.log(
    `  provider keys visible: groq=${countSlots("GROQ_API_KEY", 4)} ` +
    `gemini=${countSlots("GEMINI_KEY", 8)} ` +
    `openrouter=${countSlots("OPENROUTER_API_KEY", 4)}`
  );
  console.log(
    `  web search: ${allowWeb ? "ALLOWED (AQEVAL_ALLOW_WEB_SEARCH=1)" : "stripped (closed-book)"}` +
    ` — SERPER=${!!process.env.SERPER_API_KEY} TAVILY=${!!process.env.TAVILY_API_KEY}`
  );
});
