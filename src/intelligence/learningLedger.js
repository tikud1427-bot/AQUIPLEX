/**
 * AQUA Internal Intelligence Engine — Learning Ledger (Phase 11)
 *
 * "Every execution should produce learning artifacts … use these to improve
 * future decisions." This module is both halves:
 *
 *   RECORD  recordOutcome() — called by chat.js after every completed turn
 *           with signals the turn already produced (taskType, provider,
 *           responseConfidence, verification/debate outcome, latency).
 *           Zero LLM calls, zero extra I/O on the hot path.
 *
 *   FEED BACK
 *     getTaskStats()      → chat.js passes into orchestrate() as `history`;
 *                           verificationStrategy.js turns historically
 *                           revision-prone / low-confidence task types into
 *                           a verification-warranting reason.
 *     getProviderPrior()  → providers/router.js adds a BOUNDED learned
 *                           adjustment to scoreProvider(): providers whose
 *                           answers for a task type historically verify
 *                           clean with high response confidence earn a few
 *                           points; chronically revised ones lose a few.
 *
 * Cold-start guarantee: every feedback path is sample-gated (MIN_SAMPLE
 * turns per key) and returns neutral values below it — an empty ledger
 * makes the system behave byte-identically to before this module existed.
 *
 * Storage: aggregates only — counters + EWMAs, never per-turn arrays — so
 * the file is bounded by (taskTypes × providers), not by traffic. Mirrors
 * the proven mindStore pattern: in-memory object + debounced JSON write to
 * .aqua-ledger.json, fail-open on load and save. All access goes through
 * this module's API, so swapping storage later touches ONE file.
 */
import fs from 'fs';
import { createDebouncedWriter, loadJsonFile } from '../core/atomicStore.js';
import { migrateLegacyFile } from '../core/dataDir.js';

// P0 — canonical data dir (survives redeploys) + one-time legacy migration.
const STORE_FILE = migrateLegacyFile('.aqua-ledger.json');

/**
 * Phase 0 (audit F2) — schema v2: v1 aggregates are QUARANTINED, not loaded.
 *
 * Why a full reset is the SAFEST migration (and selective repair is not):
 * the context-blind verification bug (audit F1) booked every wrongful
 * "I cannot watch videos" rewrite as a legitimate revision. That poisoned
 * v1 three ways at once:
 *   1. byTask.verification.revised inflated → revisionRate crosses
 *      LEARNED_REVISION_RATE → shouldVerify() auto-enables verification for
 *      the whole task type → MORE wrongful revisions (the death spiral).
 *   2. byTask.verification.ran inflated by those spurious passes, skewing
 *      every rate computed from it.
 *   3. byProvider.revised inflated → getProviderPrior() penalizes providers
 *      whose grounded answers were wrongly "corrected".
 * The store keeps AGGREGATES only (counters + EWMAs, no per-turn records —
 * by design, see header), so wrongful and legitimate revisions are
 * indistinguishable after the fact. Any partial repair would keep unknown
 * amounts of poison. Cold-start is already a first-class guaranteed-neutral
 * state (MIN_SAMPLE gates every feedback path), so resetting costs at most
 * MIN_SAMPLE turns of re-learning per key and restores a trustworthy
 * baseline under the now-grounded reviewers.
 *
 * v1 data is preserved verbatim in a timestamped sidecar for post-mortem.
 */
const LEDGER_VERSION = 2;

function quarantineV1(data) {
  try {
    const sidecar = `${STORE_FILE}.v1-quarantined-${Date.now()}.json`;
    fs.writeFileSync(sidecar, JSON.stringify(data, null, 2));
    console.warn(`[LEDGER] v1 aggregates QUARANTINED (poisoned by pre-Phase-0 verification bug, audit F2) → ${sidecar}; starting fresh at v${LEDGER_VERSION}`);
  } catch (err) {
    // Preservation is best-effort; the reset itself must never be blocked.
    console.warn(`[LEDGER] v1 quarantine write failed (${err.message}) — resetting to v${LEDGER_VERSION} regardless; poisoned stats must not steer routing`);
  }
}

/** Sample gate: below this many recorded turns for a key, feedback is neutral. */
export const MIN_SAMPLE = 10;

/** EWMA smoothing — recent turns weigh more; no unbounded history kept. */
const EWMA_ALPHA = 0.2;

/** Provider prior bounds — small next to the quality spread (~55–95). */
const PRIOR_CLAMP = 6;
const PRIOR_NEUTRAL_CONFIDENCE = 0.65; // response-confidence level worth zero adjustment

/** Adaptive-verification thresholds (consumed via getTaskStats → shouldVerify). */
export const LEARNED_REVISION_RATE = 0.30;
export const LEARNED_LOW_CONFIDENCE = 0.55;

let ledger  = emptyLedger();
let loaded  = false;
let persist = true;

function emptyLedger() {
  return { version: LEDGER_VERSION, byTask: {}, updatedAt: null };
}

function loadFromDisk() {
  if (loaded) return;
  loaded = true;
  // Corrupt-safe: bad parse preserves the file aside + tries .bak, never wipes.
  const data = loadJsonFile(STORE_FILE, { label: 'ledger' });
  if (!data) return;
  if (data.version === LEDGER_VERSION && data.byTask) {
    ledger = data;
    console.log(`[LEDGER] Loaded outcome aggregates for ${Object.keys(ledger.byTask).length} task type(s) from ${STORE_FILE}`);
    return;
  }
  if (data.version === 1 && data.byTask) {
    quarantineV1(data);
    scheduleSave();   // persist the fresh v2 shell so the v1 file never reloads
    return;           // ledger stays emptyLedger() — guaranteed-neutral cold start
  }
  console.warn(`[LEDGER] Unknown ledger version ${data.version} in ${STORE_FILE} — ignoring file, starting fresh at v${LEDGER_VERSION}`);
}

// Phase 3b — atomic + async persistence via the shared primitive; the persist
// flag guard (disabled in tests) is preserved.
const _writer = createDebouncedWriter(STORE_FILE);
function scheduleSave() {
  if (!persist) return;
  _writer.schedule(() => JSON.stringify(ledger));
}
loadFromDisk();

const ewma = (prev, value) => (prev == null ? value : prev + EWMA_ALPHA * (value - prev));

function taskBucket(taskType) {
  return (ledger.byTask[taskType] ??= {
    turns: 0,
    confidenceEwma: null,
    verification: { warranted: 0, ran: 0, revised: 0, failedOpen: 0, inconclusive: 0 },
    byProvider: {},
  });
}

function providerBucket(task, provider) {
  return (task.byProvider[provider] ??= {
    turns: 0,
    confidenceEwma: null,
    latencyEwma: null,
    revised: 0,
    failedOpen: 0,
  });
}

/**
 * Record one completed turn. Fail-open by construction: a ledger problem
 * can never break a response that already succeeded.
 *
 * @param {object} outcome
 * @param {string}  outcome.taskType
 * @param {string}  [outcome.provider]
 * @param {{score:number}} [outcome.responseConfidence] - payload's Phase 12 block
 * @param {object}  [outcome.verification]  - verification/debate result (superset shape)
 * @param {boolean} [outcome.verificationWarranted]
 * @param {number}  [outcome.latencyMs]
 */
export function recordOutcome({ taskType, provider, responseConfidence, verification, verificationWarranted = false, latencyMs } = {}) {
  try {
    if (!taskType) return;
    const task = taskBucket(taskType);
    task.turns += 1;

    const score = responseConfidence?.score;
    if (typeof score === 'number') task.confidenceEwma = ewma(task.confidenceEwma, score);

    const v = verification ?? {};
    if (verificationWarranted) task.verification.warranted += 1;
    if (v.ran)                 task.verification.ran += 1;
    if (v.revised)             task.verification.revised += 1;
    if (v.inconclusive)        task.verification.inconclusive += 1;
    if (!v.ran && v.error)     task.verification.failedOpen += 1;

    if (provider) {
      const p = providerBucket(task, provider);
      p.turns += 1;
      if (typeof score === 'number')     p.confidenceEwma = ewma(p.confidenceEwma, score);
      if (typeof latencyMs === 'number') p.latencyEwma    = ewma(p.latencyEwma, latencyMs);
      if (v.revised)                     p.revised += 1;
      if (!v.ran && v.error)             p.failedOpen += 1;
    }

    ledger.updatedAt = new Date().toISOString();
    scheduleSave();
  } catch (err) {
    console.warn('[LEDGER] recordOutcome failed (ignored):', err.message);
  }
}

/**
 * History block for orchestrate()/shouldVerify(). Null until the sample
 * gate is met — callers treat null as "no history", preserving pre-ledger
 * behavior exactly.
 *
 * @param {string} taskType
 * @returns {null | { sampleSize:number, revisionRate:number, avgConfidence:number|null }}
 */
export function getTaskStats(taskType) {
  const task = ledger.byTask[taskType];
  if (!task || task.turns < MIN_SAMPLE) return null;
  const ran = task.verification.ran;
  return {
    sampleSize:    task.turns,
    revisionRate:  ran > 0 ? task.verification.revised / ran : 0,
    avgConfidence: task.confidenceEwma,
  };
}

/**
 * Bounded learned adjustment for providers/router.js scoreProvider().
 * Zero (neutral) until MIN_SAMPLE turns exist for this (provider, taskType);
 * then scales with how far the provider's response-confidence EWMA sits
 * from the neutral level, clamped to ±PRIOR_CLAMP points.
 *
 * @param {string} provider
 * @param {string} taskType
 * @returns {number} score delta in [-PRIOR_CLAMP, +PRIOR_CLAMP]
 */
export function getProviderPrior(provider, taskType) {
  const p = ledger.byTask[taskType]?.byProvider?.[provider];
  if (!p || p.turns < MIN_SAMPLE || p.confidenceEwma == null) return 0;
  const delta = (p.confidenceEwma - PRIOR_NEUTRAL_CONFIDENCE) * 20;
  return Math.max(-PRIOR_CLAMP, Math.min(PRIOR_CLAMP, delta));
}

/** Deep-copied snapshot for diagnostics endpoints and tests. */
export function getLedgerSnapshot() {
  return JSON.parse(JSON.stringify(ledger));
}

/** Test hooks — keep the suite from touching the real on-disk ledger. */
export function _resetForTests({ persistence = false } = {}) {
  _writer.cancel();
  ledger  = emptyLedger();
  persist = persistence;
}