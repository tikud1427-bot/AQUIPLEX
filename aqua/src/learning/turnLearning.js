/**
 * AQUA — durable post-turn learning (scalability Phase 3)
 *
 * The post-turn learning that runPostTurn (routes/turnPostProcess.js) runs
 * inside the API process — Mind post-turn, world-model ingest + claim shadow
 * projection + Digital Twin, E6 understanding, Reflection V2, PIC
 * consolidation — as WORKER JOBS, created in the same transaction as the turn's
 * messages (memory/conversationPartitions.js commitTurn). Gate:
 * AQUA_POST_TURN_DURABLE (off by default; requires history partitions on).
 *
 * THE SAME FUNCTIONS RUN, WITH THE SAME INPUTS. The worker calls exactly the
 * stage functions runPostTurn calls, with the text runPostTurn would have been
 * given: the stored message, with health/mood sentences removed unless the
 * user opted in (memoryWriteTurn in routes/chat.js — the same rule, recomputed
 * here from the stored text and the opt-in recorded at enqueue time).
 *
 * NO USER TEXT IN THE QUEUE. Job rows carry references — conversation id and
 * message keys — never a copy of what was said. The worker reads the message
 * from the conversation store, so a conversation deleted or a message edited
 * before the job runs is honoured by construction, and deleting an account
 * leaves no transcript behind in `aqua_jobs`.
 *
 * ONCE PER TURN, EVEN WHEN A JOB RUNS TWICE. A worker can die after writing
 * and before acknowledging; the job then runs again. Stages that are not
 * naturally idempotent (the turn counter, Twin observation, reflection) record
 * an applied marker in the owner's Mind, in the same row and the same flush as
 * the change; world-model ingest is idempotent by its source id
 * (turnSourceId); E6 by its commit ledger; consolidation by measurement (a
 * second pass merges nothing).
 *
 * ORDER. Jobs of one owner never run concurrently (the claim predicate).
 * Reflection depends on the turn's ingest (depends_on), as it did in-process
 * (separate later tick). Consolidation is enqueued by the Mind job once the
 * owner's turn count crosses its interval, one job per interval bucket.
 */
import { MESSAGE_KEY } from '../memory/conversationPartitions.js';
import { getConversation, getConversationMeta } from '../memory/conversationStore.js';
import { redactSensitiveSentences } from '../memory/sensitivity.js';
import { memoryAfterTurn } from '../memory/engine.js';
import { getMind, peekMind, touchMind, turnApplied, markTurnApplied } from '../mind/mindStore.js';
import * as Brain from '../brain/index.js';
import { REFLECT_EVERY_TURNS } from '../mind/reflectionEngine.js';
import { consolidate, consolidateEnabled, CONSOLIDATE_EVERY_TURNS } from '../pic/core.js';
import { resolveClaimShadowMode } from '../core/claims/shadowMode.js';
import { noteFeature } from '../core/flags.js';
import { enqueue } from '../core/jobs/jobQueue.js';
import { getFacts } from '../memory/longTermMemory.js';
import { indexOwnerFacts } from '../embeddings/semanticMemory.js';

export const KIND = Object.freeze({
  MIND: 'learning.mind.v1',
  OBSERVE: 'learning.observe.v1',
  REFLECT: 'learning.reflect.v1',
  CONSOLIDATE: 'learning.consolidate.v1',
  UNDERSTAND: 'understanding.turn.v1',
  // Phase 4A: the fact-embedding refresh a turn used to start fire-and-forget
  // after its response (memory/engine.js 'index' effect). Owner-level and
  // idempotent (it embeds only facts whose text hash is not indexed yet).
  INDEX: 'memory.index.v1',
});
export const LEARNING_KINDS = Object.freeze([KIND.MIND, KIND.OBSERVE, KIND.REFLECT, KIND.CONSOLIDATE, KIND.INDEX]);

/** The index job of one turn (no payload: the worker reads the owner's facts). */
export function turnIndexJob({ ownerId, conversationId, keys }) {
  return { ownerId, conversationId, kind: KIND.INDEX, priority: 120, maxAttempts: 5,
    sourceRef: { conversationId, userMessageKey: keys[0] },
    idempotencyKey: `${KIND.INDEX}:${conversationId}:${keys[0]}`, payload: {} };
}

/** AQUA_POST_TURN_DURABLE — read per call, so a rollback is a restart. */
export function durableLearningEnabled() {
  return String(process.env.AQUA_POST_TURN_DURABLE ?? '').toLowerCase() === 'on';
}

// ── API side: what one turn schedules ────────────────────────────────────────

/**
 * The jobs of one committed turn. Pure: no I/O. `keys` are the message keys
 * [user, assistant] the transaction wrote; `turn` the conversation's length
 * after the turn (what runPostTurn passed as `turn`).
 */
export function turnLearningJobs({
  ownerId, conversationId, keys, turn, taskType = null, workspaceId = null,
  rememberSensitive = false, assertedAt = new Date().toISOString(),
  e6 = Brain.e6Enabled(), reflectEvery = REFLECT_EVERY_TURNS,
}) {
  const [userKey, assistantKey = null] = keys;
  const sourceRef = { conversationId, userMessageKey: userKey, assistantMessageKey: assistantKey, turn };
  const base = { ownerId, conversationId, sourceRef };
  const key = kind => `${kind}:${conversationId}:${userKey}`;
  const jobs = [
    { ...base, kind: KIND.MIND, idempotencyKey: key(KIND.MIND), priority: 50,
      payload: { taskType, workspaceId } },
    { ...base, kind: KIND.OBSERVE, idempotencyKey: key(KIND.OBSERVE), priority: 60,
      payload: { rememberSensitive: !!rememberSensitive } },
  ];
  if (e6) {
    // Same key as the in-process enqueue always used, so the two paths never both run a turn.
    jobs.push({ ...base, kind: KIND.UNDERSTAND, idempotencyKey: `${KIND.UNDERSTAND}:${conversationId}:${turn}`, priority: 100,
      payload: { conversationId, turn, assertedAt, userMessageKey: userKey, rememberSensitive: !!rememberSensitive } });
  }
  if (reflectEvery > 0 && turn % reflectEvery === 0) {
    jobs.push({ ...base, kind: KIND.REFLECT, idempotencyKey: key(KIND.REFLECT), priority: 70,
      payload: {}, dependsOn: [key(KIND.OBSERVE)] });
  }
  return jobs;
}

/** Enqueue a turn's jobs on the transaction's client. Returns their ids. */
export async function enqueueTurnLearning(client, jobs) {
  const out = [];
  for (const j of jobs) {
    const { jobId, created } = await enqueue(j, { client });
    out.push({ kind: j.kind, jobId, created });
  }
  return out;
}

// ── Worker side ──────────────────────────────────────────────────────────────

/**
 * The turn's text as runPostTurn received it, read from the conversation
 * store. null when the source is gone (conversation or message deleted): the
 * job then does nothing — the user removed what it would have learned from.
 */
export function readTurnText(sourceRef, { rememberSensitive = false } = {}) {
  const { conversationId, userMessageKey, assistantMessageKey } = sourceRef ?? {};
  if (!conversationId || !userMessageKey) return null;
  const msgs = getConversation(conversationId);
  const find = k => (k ? msgs.find(m => (m?.[MESSAGE_KEY] ?? m?.mid) === k) ?? null : null);
  const user = find(userMessageKey);
  if (!user) return null;
  const assistant = find(assistantMessageKey);
  const userText = String(user.content ?? '');
  const assistantText = String(assistant?.content ?? '');
  return rememberSensitive
    ? { userMessage: userText, assistantMessage: assistantText }
    : { userMessage: redactSensitiveSentences(userText).text, assistantMessage: redactSensitiveSentences(assistantText).text };
}

/** The conversation must belong to the job's owner — never learn across owners. */
function sourceOwnedBy(conversationId, ownerId) {
  const meta = getConversationMeta(conversationId);
  if (!meta) return false;
  const owner = meta.userId != null && String(meta.userId) !== '' ? `user:${meta.userId}` : `conv:${conversationId}`;
  return owner === String(ownerId);
}

const marker = (stage, ref) => `${stage}:${ref.conversationId}:${ref.userMessageKey}`;

/** Run `fn` once per (stage, turn) for this owner; the marker lands with the change. */
function oncePerTurn(ownerId, stage, ref, fn) {
  const mind = getMind(ownerId);
  const m = marker(stage, ref);
  if (turnApplied(mind, m)) return { skipped: 'already-applied' };
  const out = fn();
  markTurnApplied(getMind(ownerId), m);
  touchMind(getMind(ownerId));
  return { applied: true, out };
}

async function runClaimShadowProjection({ ownerId, factIds }) {
  const mode = await resolveClaimShadowMode();
  if (mode.mode !== 'shadow') return null;
  const { projectTurnFacts, claimParityLine } = await import('../core/claims/shadowProjector.js');
  const report = await projectTurnFacts({ ownerId, factIds });
  const line = claimParityLine(report);
  if (line) console.log(line);
  return report;
}

function noteOutcome(gate, result) {
  if (!result || result.skipped) return;
  noteFeature(gate, result.ok ? 'ran' : 'failed', result.ok ? null : 'guarded-error');
}

/** Injectable for tests; the defaults are the production stage functions. */
export const LEARNING_DEPS = Object.freeze({
  memoryAfterTurn,
  observeConversationTurn: Brain.observeConversationTurn,
  observeTwin: Brain.observeTwin,
  reflectTurn: Brain.reflectTurn,
  projectClaimsShadow: runClaimShadowProjection,
  consolidate, consolidateEnabled, consolidateEvery: CONSOLIDATE_EVERY_TURNS,
  enqueue,
  indexOwnerFacts, getFacts,
});

export function learningHandlers(deps = LEARNING_DEPS) {
  const d = deps === LEARNING_DEPS ? deps : { ...LEARNING_DEPS, ...deps };
  return {
    [KIND.MIND]: async job => {
      const ref = job.sourceRef ?? {};
      if (!sourceOwnedBy(ref.conversationId, job.ownerId)) return { skipped: 'source-missing' };
      const p = job.payload ?? {};
      const r = oncePerTurn(job.ownerId, 'mind', ref, () =>
        d.memoryAfterTurn(job.ownerId, { taskType: p.taskType ?? null, workspaceId: p.workspaceId ?? null }));
      // Mind reflection (scheduleReflection) runs on the next tick; let it land in this job's flush.
      await new Promise(res => setImmediate(res));
      // Consolidation: one job per interval bucket of the owner's turn count.
      // Enqueued even when this turn was already applied (a retry after the
      // enqueue failed); the bucket key makes it once.
      if (d.consolidateEnabled() && d.consolidateEvery > 0) {
        const turns = peekMind(job.ownerId)?.turnCount ?? 0;
        const bucket = Math.floor(turns / d.consolidateEvery);
        if (bucket >= 1) {
          await d.enqueue({ ownerId: job.ownerId, kind: KIND.CONSOLIDATE, payload: { bucket, turns },
            idempotencyKey: `${KIND.CONSOLIDATE}:${bucket}`, priority: 150, maxAttempts: 3 });
        }
      }
      return r.skipped ? r : { applied: true };
    },

    [KIND.OBSERVE]: async job => {
      const ref = job.sourceRef ?? {};
      if (!sourceOwnedBy(ref.conversationId, job.ownerId)) return { skipped: 'source-missing' };
      const text = readTurnText(ref, { rememberSensitive: job.payload?.rememberSensitive === true });
      if (!text) return { skipped: 'source-missing' };
      const ownerId = job.ownerId;
      const conversationId = ref.conversationId;
      // World-model ingest: idempotent by turn source id (conversationIngest.js).
      const ingest = d.observeConversationTurn({ ownerId, conversationId, turn: ref.turn,
        userMessage: text.userMessage, assistantMessage: text.assistantMessage });
      noteOutcome('AQUA_BRAIN_INGEST', ingest);
      const factIds = ingest?.factIds ?? [];
      if (factIds.length) {
        try { await d.projectClaimsShadow({ ownerId, factIds }); } catch { /* fail-open, as in-process */ }
      }
      // Digital Twin: signals accumulate, so at most once per turn.
      oncePerTurn(ownerId, 'twin', ref, () => {
        try { noteOutcome('AQUA_TWIN_V2', d.observeTwin({ ownerId, userMessage: text.userMessage, conversationId })); }
        catch { noteFeature('AQUA_TWIN_V2', 'failed', 'threw'); }
      });
      return { applied: true, facts: factIds.length };
    },

    [KIND.REFLECT]: async job => {
      const ref = job.sourceRef ?? {};
      if (!sourceOwnedBy(ref.conversationId, job.ownerId)) return { skipped: 'source-missing' };
      const r = oncePerTurn(job.ownerId, 'reflect', ref, () => {
        const out = d.reflectTurn(job.ownerId);
        if (out?.applied) noteFeature('AQUA_REFLECT_V2', 'ran');
        return out;
      });
      return r.skipped ? r : { applied: true };
    },

    [KIND.INDEX]: async job => {
      // Recomputes from the owner's current facts: a re-run (or a later turn's
      // job) embeds nothing already indexed; deleted facts' vectors are pruned.
      await d.indexOwnerFacts(job.ownerId, d.getFacts(job.ownerId));
      return { applied: true };
    },

    [KIND.CONSOLIDATE]: async job => {
      if (!d.consolidateEnabled()) return { skipped: 'disabled' };
      d.consolidate(job.ownerId);
      noteFeature('AQUA_CONSOLIDATE', 'ran');
      return { applied: true };
    },
  };
}

export const LEARNING_HANDLERS = learningHandlers();
