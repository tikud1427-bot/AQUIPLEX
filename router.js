/**
 * AQUA Engine Router
 *
 * Single mount point for the entire AQUA AI engine inside the AQUIPLEX
 * platform. The platform (CommonJS index.js) loads this ESM module via
 * dynamic import() and mounts it at /api/aqua behind requireLogin.
 *
 * Route map (all relative to /api/aqua):
 *   /chat              — chat + /chat/stream (SSE)
 *   /provider-health   — provider health probes
 *   /project           — workspace / repository intelligence + patch editing
 *   /conversations     — conversation history (per-user scoped)
 *   /memory            — long-term memory management
 *   /upload            — universal upload (files, archives, media)
 *   /artifacts         — Universal Artifact Engine (generated files: list/download/manage)
 *   /brain             — World Model: entities, timeline, chains, digital twin (read-only)
 *
 * User identity: the platform sets req.aquaUserId (from the session) before
 * this router runs. Routes read it to scope conversations and memory.
 */
import express from "express";

import chatRoute          from "./src/routes/chat.js";
import healthRoute        from "./src/routes/health.js";
import projectRoute       from "./src/routes/project.js";
import conversationsRoute from "./src/routes/conversations.js";
import memoryRoute        from "./src/routes/memory.js";
import uploadRoute        from "./src/routes/upload.js";
import artifactsRoute     from "./src/routes/artifacts.js";
import mindRoute          from "./src/mind/mindRoutes.js";
import intelligenceRoute  from "./src/routes/intelligence.js";
import brainRoute         from "./src/routes/brain.js";
import {
  brainEnabled, ingestEnabled, factIngestEnabled, contextV2Enabled, reflectV2Enabled, twinV2Enabled,
  revisionVoiceEnabled,
} from "./src/brain/index.js";
import { selfEntityEnabled } from "./src/brain/identity/selfEntity.js";
import { picEnabled, consolidateEnabled, CONSOLIDATE_EVERY_TURNS } from "./src/pic/core.js";
import { uusEnabled } from "./src/understanding/flags.js";
import { DATA_DIR } from "./src/core/dataDir.js";
import { getMirrorStatus } from "./src/core/mongoMirror.js";
import { recordBoot, assessDurability, formatDurabilityReport } from "./src/core/durability.js";
import understandingRoute from "./src/understanding/understandingRoutes.js";
import { runStartupValidation } from "./src/core/startupValidation.js";
import { migrateLegacyMemory }  from "./src/memory/migrate.js";
import { migrateIdentity }      from "./src/memory/identityMigration.js";

// ── One-time unification migration ──────────────────────────────────────────
// Legacy conversation-scoped facts (.aqua-memory.json) → unified owner-scoped
// Mind store (.aqua-mind.json). Idempotent: source archived after success.
migrateLegacyMemory();

// ── One-time identity repair ─────────────────────────────────────────────────
// Fold any legacy `custom_trait` blobs into canonical identity fields (or
// de-collide them into per-value custom keys). Idempotent: minds are flagged.
migrateIdentity();

// Validate model registry + provider keys once at mount. Never throws —
// misconfigured providers are disabled with a warning, engine still mounts.
runStartupValidation();

// ── Understanding-loop flag report (Phase 1) ─────────────────────────────────
// Most of the Brain switches default OFF in code, so which understanding
// stages actually run in a given deployment is decided entirely by env vars.
// That state was only readable through GET /brain/metrics — behind auth, after
// boot, from a running instance. An audit of the deployed system should not
// require an authenticated round trip: one line in the boot log makes it
// unambiguous. Read-only, no behaviour change, fail-open.
//
// selfEntity was added in Phase 3: it is a sixth switch, also off by default,
// and it was the one flag no report mentioned — /brain/metrics does not list it
// either. An unreported flag is how a stage ends up dark for weeks.
try {
  const state = (on) => (on ? "on" : "off");
  console.log(
    `[BRAIN] flags brain=${state(brainEnabled())} ingest=${state(ingestEnabled())} ` +
    `ingestFacts=${state(factIngestEnabled())} ` +
    `contextV2=${state(contextV2Enabled())} reflectV2=${state(reflectV2Enabled())} ` +
    `twinV2=${state(twinV2Enabled())} selfEntity=${state(selfEntityEnabled())} ` +
    `revisionVoice=${state(revisionVoiceEnabled())}`,
  );
} catch (err) {
  console.warn(`[BRAIN] flag report unavailable: ${err?.message ?? err}`);
}

// PIC's own switches. Reported separately because they are not Brain flags and
// putting them under the [BRAIN] line would misattribute them — but reported,
// because an unreported flag is how a stage stays dark for weeks.
try {
  const state = (on) => (on ? "on" : "off");
  console.log(
    `[PIC] flags pic=${state(picEnabled())} consolidate=${state(consolidateEnabled())} ` +
    `every=${CONSOLIDATE_EVERY_TURNS} turns`,
  );
} catch (err) {
  console.warn(`[PIC] flag report unavailable: ${err?.message ?? err}`);
}

// User Understanding System. One switch for the whole sprint, reported here for
// the same reason as the two above: twice now a stage has run dark because
// nothing printed its flag. Note what is deliberately NOT behind it — the tech
// word-sense guard and the compound-role pattern are bug fixes and always run.
try {
  console.log(`[UUS] flags uus=${uusEnabled() ? "on" : "off"}`);

  // E3/PR-1 — a configured database must never be a surprise (L13: no dark
  // stages). Printed on every boot, configured or not. Nothing reads through
  // the pool yet; this line is how that stops being true silently.
  try {
    const { bootLine } = await import('./src/core/db/pool.js');
    console.log(bootLine());
    // E3/PR-5 — install the storage backend the environment asks for, then say
    // which one is live. Fails open to JSON with the reason printed.
    const { configureStorageFromEnv, storageBootLine } = await import('./src/core/storage/index.js');
    const storeResult = await configureStorageFromEnv();
    console.log(storageBootLine(storeResult));

    // E3/PR-6 — in shadow mode, report drift once at boot. Deliberately NOT
    // awaited: a comparison that delayed startup would be the first thing
    // switched off, and it is diagnostic, not load-bearing. Fail-open.
    if (storeResult.mode === 'shadow') {
      import('./src/core/db/drift.js')
        .then(async ({ checkDrift, driftLine }) => console.log(driftLine(await checkDrift())))
        .catch(err => console.log(`[DRIFT] check unavailable: ${err.message}`));
    }
  } catch (err) {
    console.log(`[DB] boot line unavailable: ${err.message}`);
  }
} catch (err) {
  console.warn(`[UUS] flag report unavailable: ${err?.message ?? err}`);
}

// E4/PR-1 — the flag census. The subsystem lines above report 11 gates between
// them; the code reads 42 variables. Everything else was decided at import time
// by an environment variable and reported nowhere, which per L13 is a branch in
// production that nobody can see. This line names the count and the OVERRIDES —
// listing all 26 gates every boot would be read exactly as often as listing
// none. Fail-open: a boot report that can break boot is worse than no report.
try {
  const { flagBootLine } = await import('./src/core/flags.js');
  console.log(flagBootLine());
} catch (err) {
  console.warn(`[FLAGS] census unavailable: ${err?.message ?? err}`);
}

// E5/PR-5 — declare whether claim shadow writes are running. The requested-but-
// unavailable case is the whole reason this line exists: it is the only way an
// operator learns that the thing they switched on degraded to off, and why.
try {
  const { resolveClaimShadowMode, claimShadowBootLine } = await import('./src/core/claims/shadowMode.js');
  console.log(claimShadowBootLine(await resolveClaimShadowMode()));
} catch (err) {
  console.warn(`[CLAIMS] shadow mode unavailable: ${err?.message ?? err}`);
}

// ── Durability self-check ────────────────────────────────────────────────────
//
// AQUA has two independent ways to survive a redeploy — the Mongo mirror, and
// AQUA_DATA_DIR on a persistent mount — and until now nothing checked whether
// either was working. The service ran fine, reported healthy, and would lose
// everything on the next deploy.
//
// Deferred one tick so the mirror's boot canary has run and `durable` is a live
// fact rather than an unanswered question. Fail-open: a diagnostic that crashes
// the boot it is diagnosing is worse than no diagnostic.
setTimeout(() => {
  try {
    const assessment = assessDurability({
      dataDir: DATA_DIR,
      mirror: getMirrorStatus(),
      bootHistory: recordBoot(DATA_DIR),
    });
    // Loud only when it needs to be. A warning printed every boot regardless of
    // state is a warning nobody reads by the third deploy.
    (assessment.safe ? console.log : console.warn)(formatDurabilityReport(assessment));
  } catch (err) {
    console.warn(`[DURABILITY] self-check unavailable: ${err?.message ?? err}`);
  }
}, 2000).unref?.();

const router = express.Router();

router.use("/chat",            chatRoute);
router.use("/provider-health", healthRoute);
router.use("/project",         projectRoute);
router.use("/conversations",   conversationsRoute);
router.use("/memory",          memoryRoute);
router.use("/upload",          uploadRoute);
router.use("/artifacts",       artifactsRoute); // Universal Artifact Engine (P1)
router.use("/understanding",   understandingRoute);  // UUS read model — what AQUA understands about you
router.use("/mind",            mindRoute);   // persistent cognitive model (Mind layer)
router.use("/intelligence",    intelligenceRoute); // Persistent Intelligence Core (Phase 4)
router.use("/brain",           brainRoute);   // World Model read API (Brain V1 / Phase 0)

// JSON 404 for unknown engine routes (never fall through to platform HTML 404)
router.use((req, res) => {
  res.status(404).json({ success: false, error: `Not found: ${req.method} /api/aqua${req.path}` });
});

// JSON error handler — same contract the AQUA frontend expects
router.use((err, req, res, _next) => {
  const status = err.status ?? err.statusCode ?? 500;
  if (err.type === "entity.too.large" || status === 413) {
    return res.status(413).json({
      success: false,
      error: "Upload too large. The request body limit is 50 MB — try a smaller archive, or remove build artifacts (node_modules, dist) before zipping.",
    });
  }
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ success: false, error: "Invalid request body (malformed JSON)." });
  }
  console.error(`[AQUA] Unhandled error ${req.method} ${req.path}:`, err.stack ?? err.message);
  res.status(status).json({ success: false, error: err.message ?? "Internal server error" });
});

export default router;