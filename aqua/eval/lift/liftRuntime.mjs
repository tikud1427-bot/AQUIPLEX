/**
 * World-Model Lift — the runtime half shared by the live Lift
 * (scripts/world-model-lift-live.mjs) and the provider-free state probe
 * (scripts/world-model-state-probe.mjs).
 *
 * One implementation of "build this persona's World Model through the
 * production worker path" and "assemble the production answer context", so the
 * probe used to diagnose condition C measures exactly what the Lift scores.
 *
 * The caller has already pointed DATABASE_URL at the test database and set the
 * production gates; this module only composes production functions.
 */
import { getPool } from '../../src/core/db/pool.js';
import { enqueue, requeueDead } from '../../src/core/jobs/jobQueue.js';
import { drainUntilIdle } from '../../src/core/jobs/workerRuntime.js';
import * as Brain from '../../src/brain/index.js';
import { classifyTask } from '../../src/core/classifier.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const emptyFloor = () => ({ items: [], block: '', stats: {} });

/**
 * Enqueue every history turn exactly as turnPostProcess does and drain the
 * worker's own handler table until nothing for this owner is runnable.
 * Bounded (G6): 30 min wall clock, 4 dead-letter requeue cycles.
 */
export async function ingestPersona(ownerId, persona, { runId, log = console.log } = {}) {
  if (!Array.isArray(persona.sessions)) {
    const conversationId = `lift-${runId}-${persona.id}`;
    return ingestTurns(ownerId, conversationId, persona.history.map((text, i) => ({ turn: i + 1, text })), { runId, log, label: persona.id });
  }
  // Multi-session persona (held-out v3): each session is its own conversation,
  // in order; a document is uploaded after the session it follows.
  let last = null;
  const uploads = [];
  for (let s = 0; s < persona.sessions.length; s++) {
    const conversationId = `lift-${runId}-${persona.id}-s${s + 1}`;
    last = await ingestTurns(ownerId, conversationId, persona.sessions[s].map((text, i) => ({ turn: i + 1, text })), { runId, log, label: persona.id });
    for (const doc of (persona.documents ?? []).filter(d => d.afterSession === s + 1)) {
      const r = await ingestDocument(ownerId, conversationId, doc, { runId, log, label: persona.id });
      uploads.push(...r.upload);
      last = r;
    }
  }
  return { ...last, uploads };
}

/**
 * The flat, chronological history the BASELINES and the judge see for a
 * persona: every turn of every session, and each uploaded document as one
 * entry per non-empty line ("[file NAME] …"), placed after its session.
 * Memory (BM25) retrieves over these entries; full history is all of them.
 */
export function flatHistory(persona) {
  if (!Array.isArray(persona.sessions)) return persona.history;
  const out = [];
  persona.sessions.forEach((turns, s) => {
    out.push(...turns);
    for (const doc of (persona.documents ?? []).filter(d => d.afterSession === s + 1)) {
      for (const line of String(doc.text).split('\n').map(l => l.trim()).filter(Boolean)) out.push(`[file ${doc.name}] ${line}`);
    }
  });
  return out;
}

/** Enqueue explicit (turn, text) pairs of one conversation and drain until this owner is idle. */
export async function ingestTurns(ownerId, conversationId, turns, { runId, log = console.log, label = conversationId } = {}) {
  for (const { turn, text } of turns) {
    await enqueue({
      ownerId, kind: 'understanding.turn.v1',
      payload: { conversationId, turn, userMessage: text },
      idempotencyKey: `understanding.turn.v1:${conversationId}:${turn}`,
    });
  }
  return drainOwner(ownerId, { runId, log, label });
}

/**
 * A document uploaded by this owner, through the SAME two calls the upload
 * route makes (routes/upload.js: fileEngine.ingestFiles → observeIngest), then
 * drained like a turn. Whatever the production upload path does with a file —
 * and nothing more — is what reaches the World Model. (Held-out v3, 2026-10-11.)
 */
export async function ingestDocument(ownerId, conversationId, { name, text }, { runId, log = console.log, label = conversationId } = {}) {
  const { ingestFiles } = await import('../../src/files/fileEngine.js');
  const { observeIngest } = await import('../../src/understanding/observeIngest.js');
  const out = await ingestFiles({
    files: [{ name, buffer: Buffer.from(String(text), 'utf8') }],
    ownerId, conversationId, workspaceName: 'Uploaded project', traceId: `lift-${runId}`,
  });
  try { observeIngest({ ownerId, ukoIds: out.ukoIds ?? [] }); } catch { /* fail-open, as the route */ }
  const status = (out.results ?? []).map(r => `${r.name}:${r.status}`).join(',');
  log(`[LIFT] ${label}: uploaded ${name} → ${status}`);
  const drained = await drainOwner(ownerId, { runId, log, label });
  return { ...drained, upload: out.results ?? [] };
}

/** Drain the worker's handler table until this owner has nothing runnable. */
export async function drainOwner(ownerId, { runId, log = console.log, label = ownerId } = {}) {
  const persona = { id: label };
  const drains = [];
  const pool = await getPool();
  const deadline = Date.now() + 30 * 60 * 1000;
  let requeueCycles = 0;
  while (Date.now() < deadline) {
    const d = await drainUntilIdle({ workerId: `lift-${runId}` });
    if (d.ran) drains.push(d);
    const { rows: [p] } = await pool.query(
      `SELECT count(*)::int AS n, GREATEST(0, EXTRACT(EPOCH FROM (min(run_after) - now())) * 1000)::int AS wait
         FROM aqua_jobs WHERE owner_id=$1 AND state IN ('queued','running')`, [ownerId]);
    if (p.n) { if (!d.ran) await sleep(Math.min(Math.max(p.wait ?? 0, 250), 30_000)); continue; }
    const dead = (await pool.query(
      `SELECT job_id FROM aqua_jobs WHERE owner_id=$1 AND state='dead' AND kind='understanding.turn.v1'`, [ownerId])).rows;
    if (!dead.length || requeueCycles >= 4) break;
    requeueCycles++;
    log(`[LIFT] ${persona.id}: ${dead.length} understanding job(s) dead-lettered on quota — waiting 120s, requeue cycle ${requeueCycles}/4`);
    await sleep(120_000);
    for (const j of dead) await requeueDead(j.job_id);
  }
  const claims = (await pool.query(
    `SELECT claim_id, predicate, polarity, modality, state, statement_text, valid_from, valid_to
       FROM aqua_claims WHERE owner_id=$1 ORDER BY asserted_at, claim_id`, [ownerId])).rows;
  const jobs = (await pool.query(
    `SELECT kind, state, count(*)::int AS n FROM aqua_jobs WHERE owner_id=$1 GROUP BY kind, state ORDER BY kind, state`,
    [ownerId])).rows;
  return { claims, jobs, drains };
}

/**
 * The production answer context for one question (chat.js prepareTurn, step
 * 5c², under the E10 read flip: canonical lanes only). Returns the rendered
 * block plus the full diagnostic record the failure taxonomy is built from.
 */
export async function worldModelContext(ownerId, q, { canonicalOnly = true } = {}) {
  const { task: taskType } = classifyTask(q);
  let semanticScores = null;
  try { semanticScores = await Brain.canonicalSemanticScores(ownerId, q); } catch { semanticScores = null; }
  const ctx = await Brain.assembleContextAsync(ownerId, q, emptyFloor, { limit: 8, taskType, semanticScores, canonicalOnly });
  const items = ctx.items ?? [];
  const ce = ctx.stats?.contextEngine ?? {};
  // ABLATION (Phase 2): the SAME selected claims rendered the pre-2026-10-06
  // way — the verbatim sentence and its numeric confidence, relevance order —
  // so a Lift run can separate what rendering contributes from what retrieval
  // and world state contribute.
  const facts = items.filter(i => i.kind === 'fact');
  const sentenceBlock = facts.length
    ? ['── CONTEXT AQUA ASSEMBLED FOR THIS QUESTION ──',
       ...facts.map(i => `• ${i.statement} (confidence ${Number(i.confidence ?? 0.5).toFixed(2)})`),
       'Use the context above with its provenance and citations; disputed items must be presented as contested, never as settled.'].join('\n')
    : '';
  return {
    block: ctx.block ?? '',
    sentenceBlock,
    taskType,
    items: items.length,
    lanes: [...new Set(items.map(i => i.lane ?? i.source ?? 'unknown'))],
    withProvenance: items.filter(i => i.ref || i.claimId || i.citation || i.provenance || i.sourceId).length,
    epistemicState: ce.epistemicState ?? ctx.stats?.epistemicState ?? null,
    undefinedLine: /•\s*undefined/.test(ctx.block ?? ''),
    // ── instrumentation (Phase 2 failure taxonomy) ──
    queryPlan: ce.queryPlan ? {
      intent: ce.queryPlan.intent ?? null,
      round: ce.queryPlan.round ?? null,
      slots: (ce.queryPlan.slots ?? []).map(s => ({ id: s.id, required: !!s.required, status: s.status ?? null })),
    } : null,
    requiredSlotsMissing: ce.requiredSlotsMissing ?? [],
    candidates: ce.candidates ?? null,
    selected: ce.selected ?? null,
    dropped: ce.dropped ?? null,
    dropReasons: ce.dropReasons ?? {},
    selectedItems: items.filter(i => i.kind === 'fact').map(i => ({
      id: i.id, statement: i.statement, via: i.via, slotIds: i.slotIds,
      disputed: i.disputed, stale: i.stale, score: i.score,
      understood: i.understood ?? null,
    })),
  };
}
