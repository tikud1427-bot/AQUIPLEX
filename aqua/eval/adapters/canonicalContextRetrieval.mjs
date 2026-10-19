/**
 * AQUA Eval — the CANONICAL read path, the one production serves with Postgres.
 *
 * WHY THIS EXISTS (2026-10-16)
 * ----------------------------
 * `context-core` seeds the legacy stores and measures the legacy read. With a
 * database configured, routes/chat.js serves something else: it resolves
 * `Brain.resolveReadMode()` and, unless that degrades to 'legacy', calls
 *
 *     Brain.assembleContextAsync(owner, message, floor, { limit: 8, canonicalOnly: readMode !== 'legacy', … })
 *
 * — the legacy floor, graph and evidence store are dropped and only canonical
 * lanes over `aqua_claims` contribute. No gate measured that read: running the
 * old suites with DATABASE_URL set produced zeros, which described neither path.
 *
 * HOW THE WORLD GETS INTO THE CANONICAL STORE
 * ------------------------------------------
 * The way a user's words do in production: each of the 60 corpus statements is
 * one chat turn passed to `Brain.understandTurn` (S0–S6 extraction, validation
 * gates, dedup, commit). Only the MODEL CALL is replaced, by a replay of
 * outputs recorded once from the production E6 transport
 * (eval/fixtures/retrieval-core.e6-replay.v1.json, recorded by
 * eval/fixtures/recordCanonicalWorld.mjs). A replay miss THROWS: if the prompt
 * or segmentation changes, the fixture must be re-recorded, never silently
 * reused. Each claim maps back to its corpus fact through its evidence source
 * (`<conversation>:turn:<n>`), so the shared scorer grades the same labels as
 * every other context suite.
 *
 * DECLARED GAPS — not run, not skipped silently
 * ---------------------------------------------
 * - Dense lane: chat hydrates canonical semantic scores from the embedding
 *   provider; the gate is offline, so none are passed. Lexical, structured and
 *   graph lanes run exactly as in production.
 * - Extraction quality is FROZEN at the recording; extraction-core and the Lift
 *   experiments grade the extractor itself.
 * - Cross-encoder: off by default in production (AQUA_CROSS_ENCODER), off here.
 *
 * SAFETY: only ever runs against AQUA_TEST_DATABASE_URL (eval/gate.mjs maps it
 * to DATABASE_URL and blanks it otherwise). It purges its own eval owner first.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CANONICAL_EVAL_USER = 'eval-canonical';
export const CANONICAL_EVAL_OWNER = `user:${CANONICAL_EVAL_USER}`;
export const CANONICAL_EVAL_CONVERSATION = 'eval-canonical-conv';
/** Fixed "said at" for turn 1; turn n is n minutes later. Deterministic S5 anchoring. */
export const CANONICAL_EVAL_EPOCH = Date.UTC(2026, 0, 5, 9, 0, 0);

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPLAY_FIXTURE = path.join(HERE, '../fixtures/retrieval-core.e6-replay.v1.json');

/**
 * The worlds a canonical suite can seed. `core` is the development world
 * (retrieval-core.v1) and keeps the original owner, conversation and fixture,
 * so its replay keys and baseline are untouched. `heldout` (2026-10-17) is the
 * frozen held-out set: its own owner, so both can be seeded in one gate run.
 */
export const CANONICAL_WORLDS = Object.freeze({
  core: { user: CANONICAL_EVAL_USER, conversation: CANONICAL_EVAL_CONVERSATION, fixture: REPLAY_FIXTURE },
  heldout: {
    user: 'eval-canonical-heldout',
    conversation: 'eval-canonical-heldout-conv',
    fixture: path.join(HERE, '../fixtures/retrieval-heldout.e6-replay.v1.json'),
  },
});
function worldSpec(name = 'core') {
  const spec = CANONICAL_WORLDS[name];
  if (!spec) throw new Error(`unknown canonical eval world: ${name}`);
  return { ...spec, owner: `user:${spec.user}` };
}

let engine = null;
const seededWorlds = new Map();
const seedErrors = new Map();

async function loadEngine() {
  if (engine) return engine;
  if (!process.env.AQUA_DATA_DIR) process.env.AQUA_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'aqua-eval-canon-'));
  // Same flags as the legacy context adapter, so the two suites differ only in
  // the read mode. The E6 flags are set only while ingesting (ingestCorpusViaE6)
  // and restored after, so they cannot leak into suites that run later in the
  // same gate process.
  process.env.AQUA_BRAIN = 'on';
  process.env.AQUA_PIC = 'on';
  process.env.AQUA_UUS = 'on';
  process.env.AQUA_SELF_ENTITY = 'on';
  process.env.AQUA_CONTEXT_V2 = 'on';
  const [brain, pool, purge] = await Promise.all([
    import('../../src/brain/index.js'),
    import('../../src/core/db/pool.js'),
    import('../../src/account/accountPurge.js'),
  ]);
  engine = { brain, pool, purge };
  return engine;
}

/** Is a reachable Postgres available to this process? Never throws. */
export async function canonicalAvailable(worldName = 'core') {
  try {
    const { pool } = await loadEngine();
    const { fixture } = worldSpec(worldName);
    if (!pool.isConfigured()) return { ok: false, reason: 'Postgres not configured (set AQUA_TEST_DATABASE_URL to a disposable test database)' };
    if (!(await pool.isReachable({ timeoutMs: 3000 }))) return { ok: false, reason: 'Postgres configured but unreachable' };
    if (!existsSync(fixture)) return { ok: false, reason: `replay fixture missing: ${path.basename(fixture)}` };
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: `Postgres check failed: ${err?.message ?? err}` };
  }
}

/**
 * The request with its two per-call values normalised out: the injection-fence
 * nonce (a random UUID, by design) and `asOf` (an ISO timestamp — the prompt
 * stamps the extraction time). Everything else — template, rules, few-shot
 * examples, the segment, known entities, reference context — stays in, so a
 * changed prompt still changes the key.
 */
export function normaliseRequest({ system, user }) {
  // Also: the order of "- " list lines inside one block. The reference context
  // lists claims by assertion time, and claims from one turn share a timestamp,
  // so Postgres returns ties in arbitrary order — the same facts, reordered.
  const sortRuns = s => {
    const out = [];
    let run = [];
    const flush = () => { if (run.length) out.push(...run.sort()); run = []; };
    for (const line of s.split('\n')) {
      if (line.startsWith('- ')) run.push(line);
      else { flush(); out.push(line); }
    }
    flush();
    return out.join('\n');
  };
  const norm = s => sortRuns(String(s ?? '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<ts>'));
  return `${norm(system)}\u0000${norm(user)}`;
}

/** Replay key: the normalised request the extractor sent. */
export function replayKey(req) {
  return createHash('sha256').update(normaliseRequest(req)).digest('hex').slice(0, 32);
}

/**
 * A callModel that answers only from recorded outputs. A miss throws — but the
 * extraction client is fail-open by design and swallows transport errors, so
 * misses are ALSO counted on `transport.misses`; seeding fails if any occurred.
 */
export function replayTransport(fixture) {
  const byKey = new Map(Object.entries(fixture.calls ?? {}));
  const transport = async (req) => {
    const key = replayKey(req);
    if (!byKey.has(key)) {
      transport.misses.push(key);
      throw new Error(`E6 replay miss (${key}) — the extraction request changed since the fixture was recorded; re-record with eval/fixtures/recordCanonicalWorld.mjs`);
    }
    transport.hits++;
    return { text: byKey.get(key) };
  };
  transport.misses = [];
  transport.hits = 0;
  return transport;
}

/**
 * Purge the eval owner, then pass each corpus statement through the production
 * understanding path as turn n of one conversation, with `callModel` supplied.
 * Returns per-turn pipeline reports.
 */
export async function ingestCorpusViaE6(corpus, callModel, { world = 'core' } = {}) {
  const { brain, purge } = await loadEngine();
  const spec = worldSpec(world);
  const purged = await purge.purgeOwnerData({ userId: spec.user });
  if (purged.errors?.length) throw new Error(`eval owner purge incomplete: ${purged.errors.join(' | ')}`);
  const saved = { AQUA_E6: process.env.AQUA_E6, AQUA_E6_COMMIT: process.env.AQUA_E6_COMMIT };
  process.env.AQUA_E6 = 'on';
  process.env.AQUA_E6_COMMIT = 'on';
  const reports = [];
  try {
    for (let i = 0; i < corpus.length; i++) {
      const r = await brain.understandTurn({
        ownerId: spec.owner,
        conversationId: spec.conversation,
        turn: i + 1,
        userMessage: corpus[i].statement,
        callModel,
        assertedAt: new Date(CANONICAL_EVAL_EPOCH + i * 60_000).toISOString(),
      });
      reports.push({ factId: corpus[i].id, report: r });
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  return reports;
}

/** claim_id → corpus fact id, through each claim's evidence source turn. */
async function claimFactMap(corpus, owner) {
  const { pool } = await loadEngine();
  const p = await pool.getPool();
  const { rows } = await p.query(
    `SELECT DISTINCT ce.claim_id, s.external_ref, c.state
       FROM aqua_claim_evidence ce
       JOIN aqua_evidence e ON e.owner_id = ce.owner_id AND e.evidence_id = ce.evidence_id
       JOIN aqua_sources  s ON s.owner_id = e.owner_id AND s.source_id = e.source_id
       JOIN aqua_claims   c ON c.owner_id = ce.owner_id AND c.claim_id = ce.claim_id
      WHERE ce.owner_id = $1`, [owner]);
  const map = new Map();
  const states = {};
  for (const r of rows) {
    const m = String(r.external_ref ?? '').match(/:turn:(\d+)$/);
    const fact = m ? corpus[Number(m[1]) - 1]?.id : null;
    if (fact) map.set(String(r.claim_id), fact);
    states[r.state] = (states[r.state] ?? 0) + 1;
  }
  return { map, states };
}

/** Seed via the replayed production understanding path. Idempotent per process and world. */
export async function seedCanonicalWorld(corpus, { world = 'core' } = {}) {
  if (seededWorlds.has(world)) return seededWorlds.get(world);
  if (seedErrors.has(world)) throw seedErrors.get(world);   // fail once, not once per case
  try {
    seededWorlds.set(world, await seedOnce(corpus, world));
  } catch (err) {
    seedErrors.set(world, err);
    throw err;
  }
  return seededWorlds.get(world);
}

async function seedOnce(corpus, world) {
  const spec = worldSpec(world);
  const fixture = JSON.parse(readFileSync(spec.fixture, 'utf8'));
  const transport = replayTransport(fixture);
  const reports = await ingestCorpusViaE6(corpus, transport, { world });
  if (transport.misses.length) {
    throw new Error(`E6 replay: ${transport.misses.length} miss(es), ${transport.hits} hit(s) — the extraction request changed since recording; re-record (eval/fixtures/recordCanonicalWorld.mjs)`);
  }
  const worker = await drainStateJobs();
  const { map, states } = await claimFactMap(corpus, spec.owner);
  const covered = new Set(map.values());
  return {
    owner: spec.owner, reports, factOfClaim: map, claimStates: states, worker,
    coverage: corpus.length ? covered.size / corpus.length : 0,
  };
}

/**
 * THE WORKER RUNS (2026-10-17). Supersession is not done by understandTurn: S8
 * writes a `claim.contradiction.detected` outbox row, and the durable worker
 * dispatches it and applies the policy (reflectionV3/contradictionWorker.js).
 * The canonical suites never ran the worker, so they measured a world in which
 * no change or correction had ever been applied — every old value still
 * `active` — which is not a state production reaches.
 *
 * Drained ONCE, after the whole conversation: extraction prompts stay exactly
 * as recorded (so the replay fixtures stay valid), and the result is the state a
 * LATER conversation reads, which is what retrieval serves. Only the kinds that
 * change canonical state run; embedding jobs need a network and stay queued.
 * `AQUA_EVAL_CANONICAL_DRAIN=off` measures the old, undrained world.
 */
async function drainStateJobs() {
  if (String(process.env.AQUA_EVAL_CANONICAL_DRAIN ?? 'on').toLowerCase() === 'off') return { drained: false };
  const [{ drainUntilIdle, dispatchReflections, scheduleConsolidation }, { CONSOLIDATION_KIND }] = await Promise.all([
    import('../../src/core/jobs/workerRuntime.js'),
    import('../../src/brain/reflectionV3/consolidationWorker.js'),
  ]);
  // drainUntilIdle dispatches 25 outbox rows per job it runs and stops at the
  // first moment no job of `kinds` is runnable — before most of a seeding's
  // hundreds of outbox rows (embedding/reflection events) are dispatched, so
  // the contradiction events behind them never became jobs. The outbox is
  // emptied first, then jobs run, until both are idle (a job may emit events).
  const total = { drained: true, dispatched: 0, ran: 0, ok: 0, failed: 0, errors: [] };
  await scheduleConsolidation();   // the worker's periodic tick, once
  for (let round = 0; round < 20; round++) {
    let d; let dispatched = 0;
    do { d = await dispatchReflections({ limit: 100 }); dispatched += d.dispatched ?? 0; } while ((d.dispatched ?? 0) > 0 && dispatched < 20_000);
    const s = await drainUntilIdle({ workerId: 'eval-canonical', kinds: ['claim.contradiction.v1', CONSOLIDATION_KIND], maxJobs: 500 });
    total.dispatched += dispatched; total.ran += s.ran; total.ok += s.ok; total.failed += s.failed; total.errors.push(...s.errors);
    if (!dispatched && !s.ran) break;
  }
  if (total.failed) throw new Error(`eval worker drain: ${total.failed} job(s) failed — ${JSON.stringify(total.errors.slice(0, 3))}`);
  return total;
}

/**
 * Ask the Context Engine exactly as routes/chat.js does for a database-backed
 * turn, and return corpus fact ids in rank order.
 */
export async function retrieveCanonical(query, { limit = 8, world = 'core' } = {}) {
  const seeded = seededWorlds.get(world);
  if (!seeded) throw new Error('seedCanonicalWorld() must run first');
  const { brain } = await loadEngine();
  const read = await brain.resolveReadMode();
  if (read.mode === 'legacy') {
    // Measuring the legacy read under this suite's name is the defect this
    // suite exists to remove. Refuse rather than report legacy numbers.
    throw new Error(`read mode resolved to legacy (${read.reason ?? read.configured}) — refusing to measure the wrong path`);
  }
  const floorRetrieve = () => ({ items: [], block: '', stats: {} });
  const out = await brain.assembleContextAsync(seeded.owner, query, floorRetrieve, {
    limit,
    canonicalOnly: read.mode !== 'legacy',   // the served mode — same expression as chat.js
    activeProjectId: null,
  });
  const items = out.items ?? [];
  const ranked = items
    .filter(it => it.kind === 'fact' || it.kind === undefined)
    .map(it => seeded.factOfClaim.get(String(it.semanticId ?? it.id ?? '').replace(/^fact:/, '')) ?? null)
    .filter(Boolean);
  return { ranked: [...new Set(ranked)], items, readMode: read.mode };
}
