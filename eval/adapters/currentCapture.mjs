/**
 * AQUA Eval — adapter for the CURRENT capture path (conversation → world model)
 * Blueprint E2 pattern; the gap identified in the post-PR-1 re-audit.
 *
 * WHAT THIS MEASURES THAT NOTHING ELSE DOES
 * -----------------------------------------
 * `extraction-core.v1` grades ONE SENTENCE against labelled claims by calling
 * the extractor's pieces directly. `retrieval-core.v1` grades the query path
 * against a world model it SEEDS BY HAND, mirroring ingest's write shapes.
 *
 * Between them sits the question the product thesis actually rests on and
 * nobody measures: **after a real conversation runs through the real
 * production post-turn path, what is in the world model, and can PIC find it
 * again?** The re-audit measured 8 turns producing 4 world-model facts, with
 * 4 of 7 flagship personal questions returning zero from the Context Engine
 * while the older memory lane held the answer. That is a capture number, and
 * there was no instrument for it.
 *
 * TWO DIMENSIONS, NEVER AVERAGED
 * ------------------------------
 *   A. CAPTURE        did the turn become the intended world-model state?
 *   B. RETRIEVABILITY given that it was captured, does `retrieveKnowledge`
 *                     surface it for the question it answers?
 *
 * These fail independently and for different reasons. A fact written but
 * unreachable is a retrieval bug; a fact never written is an extraction bug.
 * One combined score would let a capture collapse hide behind good retrieval
 * of the little that survived, which is precisely the failure mode the
 * re-audit found. Retrievability is therefore scored ONLY over captured
 * facts — scoring it over all cases would silently re-average the two.
 *
 * THE REAL PATH, NOT A PARALLEL IMPLEMENTATION
 * --------------------------------------------
 * Production runs, per turn:
 *
 *   chat.js §2a   memoryObserve(owner, {...})            — memory lane
 *   chat.js §9    addMessage(conv,'user'|'assistant')    — conversation store
 *   chat.js §9c   runPostTurn({...})                     — world-model ingest,
 *                                                          twin, reflection,
 *                                                          consolidation
 *
 * This adapter calls those three, in that order, with `runPostTurn`'s
 * PRODUCTION DEFAULT DEPS — no injected `defer`, no injected observer. The
 * deferred work is then completed by awaiting `drainJobs()`, the same drain
 * SIGTERM uses, so the eval is deterministic without substituting anything.
 *
 * That mattered: an earlier draft injected `defer: fn => fn()` for
 * determinism. It would have worked, and it would have meant the baseline
 * never exercised `jobRegistry`. `drainJobs` costs one await and keeps every
 * dependency real.
 *
 * ISOLATION
 * ---------
 * Every store is a module-level singleton that loads from disk at import, so
 * `AQUA_DATA_DIR` is set to a fresh temp directory BEFORE the engine is
 * imported. Each case additionally gets its OWN owner id — cases cannot see
 * each other's world models even though they share a process, which is
 * stronger than purging between cases and cannot be forgotten.
 *
 * CONFIGURED AT ITS BEST, NOT AT ITS DEFAULT
 * ------------------------------------------
 * Same rule the extraction and retrieval baselines follow: every understanding
 * flag ON. A baseline measures what the code CAN do. (These are all ON in
 * production today anyway, so here the two happen to agree.)
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let engine = null;

async function loadEngine() {
  if (engine) return engine;
  process.env.AQUA_DATA_DIR             = mkdtempSync(path.join(tmpdir(), 'aqua-eval-capture-'));
  process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
  process.env.AQUA_BRAIN                = 'on';
  process.env.AQUA_BRAIN_INGEST         = 'on';
  process.env.AQUA_BRAIN_INGEST_FACTS   = 'on';
  process.env.AQUA_PIC                  = 'on';
  process.env.AQUA_UUS                  = 'on';
  process.env.AQUA_SELF_ENTITY          = 'on';
  process.env.AQUA_CONTEXT_V2           = 'on';
  process.env.AQUA_TWIN_V2              = 'on';
  process.env.AQUA_REFLECT_V2           = 'on';

  const [post, mem, conv, pic, es, jobs] = await Promise.all([
    import('../../src/routes/turnPostProcess.js'),
    import('../../src/memory/engine.js'),
    import('../../src/memory/conversationStore.js'),
    import('../../src/pic/core.js'),
    import('../../src/files/evidenceStore.js'),
    import('../../src/core/jobs/jobRegistry.js'),
  ]);
  engine = { post, mem, conv, pic, es, jobs };
  return engine;
}

/**
 * Run one conversation through the production turn path.
 *
 * @param {string} ownerId
 * @param {string} conversationId
 * @param {string[]} turns  user messages, in order
 * @returns {Promise<{ facts: object[], drained: object }>}
 */
export async function ingestConversation(ownerId, conversationId, turns, opts = {}) {
  const { post, mem, conv, es, jobs } = await loadEngine();
  // DRAIN CADENCE IS PART OF THE MEASUREMENT, NOT A HARNESS DETAIL.
  //
  // `defer` schedules each post-turn job on its own `setImmediate`, so two
  // queued ingest jobs RUN CONCURRENTLY and both read-modify-write the
  // evidence store — last write wins. Measured: draining after each turn
  // keeps 4 of 4 facts; queueing four turns and draining once keeps 1 of 4.
  //
  // `perTurn` (default) is the FAITHFUL cadence: in production a human takes
  // seconds between turns and the previous job has long finished. Batching is
  // the adversarial cadence and is selected explicitly by the `concurrency`
  // cases, so the defect is measured in its own category instead of silently
  // depressing every other number.
  const perTurn = opts.batch !== true;

  conv.getOrCreateConversation(conversationId, { userId: ownerId.replace(/^user:/, '') });

  for (const userMessage of turns) {
    // §2a — the memory lane observes BEFORE generation, on every turn.
    mem.memoryObserve(ownerId, {
      userMessage,
      taskType: 'personal_info',
      conversationId,
      userId: ownerId.replace(/^user:/, ''),
      requestId: 'eval:capture',
    });

    // §9 — both messages land in the conversation store. runPostTurn reads
    // `getConversation(id).length` for the turn number AND the reflection
    // cadence, so skipping this would silently disable reflection and
    // understate capture for a reason that has nothing to do with capture.
    const assistantMessage = 'Got it.';
    conv.addMessage(conversationId, 'user', userMessage);
    conv.addMessage(conversationId, 'assistant', assistantMessage);

    // §9c — production default deps. Nothing injected.
    post.runPostTurn({
      ownerId, conversationId, userMessage, assistantMessage,
      taskType: 'personal_info', workspaceId: null,
    });
    if (perTurn) await jobs.drainJobs(20_000);
  }

  // The same drain SIGTERM runs. Deterministic completion, real registry.
  const drained = await jobs.drainJobs(20_000);

  let facts = [];
  try { facts = es.listFacts(ownerId, { limit: 500 }) ?? []; } catch { facts = []; }
  return { facts, drained };
}

/**
 * Ask the production reader a question. This is `pic/core.js
 * retrieveKnowledge` — the exact facade the chat spine calls at §5c², not an
 * inner function with hand-wired deps.
 */
export async function askProduction(ownerId, question, limit = 8) {
  const { pic } = await loadEngine();
  const r = pic.retrieveKnowledge(ownerId, question, { limit });
  const lines = String(r?.block ?? '')
    .split('\n').map(l => l.trim()).filter(l => l.startsWith('•'));
  return { lines, items: r?.items ?? [], block: r?.block ?? '' };
}

/** Every stored fact's text, lowercased — the surface capture is scored on. */
export function factTexts(facts) {
  return facts
    .map(f => String(f.statement ?? f.text ?? f.content ?? ''))
    .filter(Boolean)
    .map(s => s.toLowerCase());
}

/** True when any string in `haystack` contains every token in `needles`. */
export function containsAll(haystack, needles) {
  const want = needles.map(n => String(n).toLowerCase());
  return haystack.some(h => want.every(w => h.includes(w)));
}

/** Test seam — lets the harness prove isolation is real, not assumed. */
export async function _engineForTests() { return loadEngine(); }
