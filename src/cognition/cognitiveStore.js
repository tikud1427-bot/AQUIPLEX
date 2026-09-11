/**
 * AQUA Cognitive Intelligence Engine — Cognitive Store (CIE Phase 1)
 *
 * CONTINUOUS IMPROVEMENT (spec): "Store successful reasoning patterns,
 * failed reasoning paths, verification outcomes, retrieval quality,
 * planning quality, reflection outcomes. Allow future planning to reuse
 * successful strategies."
 *
 * Follows the learningLedger.js storage discipline to the letter:
 *   • AGGREGATES ONLY — counters + EWMAs per (taskType × cognitive style),
 *     never per-turn arrays, so the file is bounded by taskTypes × 13
 *     styles regardless of traffic.
 *   • COLD-START GUARANTEE — every read path is sample-gated
 *     (strategySelector's PRIOR_SAMPLE_GATE); an empty store makes
 *     selection behave byte-identically to pure rules.
 *   • FAIL-OPEN — load and save can never break a turn.
 *   • Atomic debounced persistence via core/atomicStore.js into the
 *     canonical data dir (dataPath), which mongoMirror already makes
 *     deploy-survivable — zero new persistence machinery.
 *
 * BOUNDARY (see reflectionEngine.js header): learningLedger keys on
 * (task × provider) for ROUTING; this store keys on (task × strategy) for
 * PLANNING. Different keys, different consumers, no duplication.
 */

import { createDebouncedWriter, loadJsonFile } from '../core/atomicStore.js';
import { dataPath } from '../core/dataDir.js';

const STORE_FILE = dataPath('.aqua-cognition.json');
const STORE_VERSION = 1;
const EWMA_ALPHA = 0.25;

let store   = emptyStore();
let loaded  = false;
let persist = true;

function emptyStore() {
  return { version: STORE_VERSION, byTask: {}, updatedAt: null };
}

function loadFromDisk() {
  if (loaded) return;
  loaded = true;
  const data = loadJsonFile(STORE_FILE, { label: 'cognition' });
  if (!data) return;
  if (data.version === STORE_VERSION && data.byTask) {
    store = data;
    console.log(`[CIE] Loaded cognition aggregates for ${Object.keys(store.byTask).length} task type(s) from ${STORE_FILE}`);
    return;
  }
  console.warn(`[CIE] Unknown cognition store version ${data.version} in ${STORE_FILE} — starting fresh at v${STORE_VERSION}`);
}

const _writer = createDebouncedWriter(STORE_FILE);
function scheduleSave() {
  if (!persist) return;
  _writer.schedule(() => JSON.stringify(store));
}

const ewma = (prev, value) => (prev == null ? value : prev + EWMA_ALPHA * (value - prev));

function taskBucket(taskType) {
  loadFromDisk();
  return (store.byTask[taskType] ??= { turns: 0, clarifications: 0, byStrategy: {} });
}

function strategyBucket(task, styleId) {
  return (task.byStrategy[styleId] ??= {
    planned: 0,
    reused: 0,
    reflected: 0,
    effectivenessEwma: null,
    confidenceEwma: null,
    findingsEwma: null,
    verification: { ran: 0, passed: 0, revised: 0 },
    outcomes: { clean: 0, adjusted: 0, misfired: 0 },
    hints: {},           // betterStrategyHint tallies — "did another strategy perform better"
    lastLesson: null,
    lastAt: null,
  });
}

/** Planning quality: every plan the CIE builds (or reuses) is counted. */
export function recordPlan({ taskType, styleId, reused = false, clarification = false } = {}) {
  try {
    if (!taskType || !styleId) return;
    const task = taskBucket(taskType);
    task.turns += 1;
    if (clarification) task.clarifications += 1;
    const s = strategyBucket(task, styleId);
    s.planned += 1;
    if (reused) s.reused += 1;
    store.updatedAt = new Date().toISOString();
    scheduleSave();
  } catch (err) {
    console.warn('[CIE] recordPlan failed (ignored):', err.message);
  }
}

/** Reflection outcome: the learning half of the loop. Fail-open. */
export function recordReflection({
  taskType, styleId, outcome, effectiveness, confidence = null,
  findings = 0, verification = null, betterStrategyHint = null, lesson = null,
} = {}) {
  try {
    if (!taskType || !styleId) return;
    const s = strategyBucket(taskBucket(taskType), styleId);
    s.reflected += 1;
    if (typeof effectiveness === 'number') s.effectivenessEwma = ewma(s.effectivenessEwma, effectiveness);
    if (typeof confidence === 'number')    s.confidenceEwma    = ewma(s.confidenceEwma, confidence);
    s.findingsEwma = ewma(s.findingsEwma, findings);
    if (verification?.ran)     s.verification.ran += 1;
    if (verification?.passed)  s.verification.passed += 1;
    if (verification?.revised) s.verification.revised += 1;
    if (outcome && s.outcomes[outcome] != null) s.outcomes[outcome] += 1;
    if (betterStrategyHint) s.hints[betterStrategyHint] = (s.hints[betterStrategyHint] ?? 0) + 1;
    if (lesson) s.lastLesson = String(lesson).slice(0, 200);
    s.lastAt = new Date().toISOString();
    store.updatedAt = s.lastAt;
    scheduleSave();
  } catch (err) {
    console.warn('[CIE] recordReflection failed (ignored):', err.message);
  }
}

/**
 * Best-performing style for a task type — the "reuse successful cognitive
 * strategies" read path. Null until any style clears the sample gate, so an
 * empty store steers nothing.
 *
 * @returns {null | { styleId:string, effectiveness:number, samples:number }}
 */
export function getStrategyPrior(taskType, { minSamples = 8 } = {}) {
  loadFromDisk();
  const task = store.byTask[taskType];
  if (!task) return null;
  let best = null;
  for (const [styleId, s] of Object.entries(task.byStrategy)) {
    if (s.reflected < minSamples || s.effectivenessEwma == null) continue;
    if (!best || s.effectivenessEwma > best.effectiveness) {
      best = { styleId, effectiveness: s.effectivenessEwma, samples: s.reflected };
    }
  }
  return best;
}

/** Raw stats for one (task, style) — selector uses this for the margin test. */
export function getStrategyStats(taskType, styleId) {
  loadFromDisk();
  return store.byTask[taskType]?.byStrategy?.[styleId] ?? null;
}

/** Deep-copied snapshot for the /intelligence/cognition routes and tests. */
export function getCognitionSnapshot() {
  loadFromDisk();
  return JSON.parse(JSON.stringify(store));
}

/** Test hook — keeps suites off the real on-disk store. */
export function _resetCognitionStoreForTests({ persistence = false } = {}) {
  _writer.cancel();
  store   = emptyStore();
  loaded  = true;
  persist = persistence;
}
