/**
 * UUS U6 — "Correct my understanding".
 *
 * ONE endpoint the UI calls, for every kind of thing AQUA believes.
 *
 * WHY IT INVENTS NO STORAGE
 * -------------------------
 * Beliefs live in the Mind, goals live in the Mind's goal tracker, facts live
 * in long-term memory, entities live in the graph. Four stores, four different
 * correction APIs — all of which already existed and were already routed
 * before this sprint started.
 *
 * What did not exist was a way for the USER to not care. Asking someone to
 * know that "founder" is a belief while "launch the beta" is a goal is asking
 * them to learn our schema in order to tell us we are wrong. That is the
 * opposite of the brief: they should click "not quite" and be done.
 *
 * So this is a ROUTER, not a store. It parses a `ref` — the same opaque string
 * the read model and the card already emit on every item — and dispatches to
 * whichever existing API owns that thing.
 *
 *     belief:identity:profession   → correctBelief()
 *     goal:g_1a2b                  → the goal record
 *     fact:favorite_editor         → memoryEditor.correctFact()
 *     entity:ent:proj:aqua         → graph node (removal only; see below)
 *
 * THE REF IS THE CONTRACT
 * -----------------------
 * The UI never constructs a ref. It echoes back the one it was given, which
 * means a change to how something is stored cannot break a screen — the ref
 * shape changes on both sides at once, in this file.
 *
 * REMOVAL VS CORRECTION
 * ---------------------
 * "Not quite" almost always means one of two things: this is wrong (remove it)
 * or this should say something else (replace it). Both are supported. Nothing
 * here soft-deletes into a "used to think" state — the brief's whole premise is
 * that the user does not manage a database, and a hidden tombstone they cannot
 * see is worse than a clean removal.
 *
 * Corrections carry `source: 'correction'` and the highest confidence the
 * system awards, because the user saying so outranks anything inferred. That
 * behaviour already existed in `correctBelief`; this just makes it reachable
 * from a screen.
 */
import { peekMind } from '../mind/mindStore.js';
import { correctBelief, deleteBelief, lockBelief } from '../mind/beliefEngine.js';
import { touchMind } from '../mind/mindStore.js';
import { GOAL_STATUS, DIMENSIONS } from '../mind/mindSchema.js';
import { observeSignal } from '../mind/beliefEngine.js';

/** Namespace for "the user said this isn't theirs". Never displayed. */
const DISMISS_PREFIX = 'dismissed:';

/**
 * Parse a ref into { kind, parts }. Returns null for anything unrecognised —
 * an unknown ref is a 400, never a guess at what the user meant.
 */
export function parseRef(ref) {
  const s = String(ref ?? '').trim();
  if (!s) return null;

  // belief:<dimension>:<key>   — key may itself contain colons ("tech:go"),
  // so split only the first two segments.
  const belief = /^belief:([a-z_]+):(.+)$/i.exec(s);
  if (belief) return { kind: 'belief', dimension: belief[1], key: belief[2] };

  const goal = /^goal:(.+)$/i.exec(s);
  if (goal) return { kind: 'goal', id: goal[1] };

  const fact = /^fact:(.+)$/i.exec(s);
  if (fact) return { kind: 'fact', key: fact[1] };

  const entity = /^entity:(.+)$/i.exec(s);
  if (entity) return { kind: 'entity', id: entity[1] };

  return null;
}

/**
 * Apply a correction.
 *
 * @param {object} args
 * @param {string} args.ownerId
 * @param {string} args.ref
 * @param {string} [args.value]   the corrected value; omit with action 'remove'
 * @param {string} [args.action]  'correct' (default) | 'remove' | 'keep'
 * @param {object} [args.deps]    injectable for tests
 * @returns {{ ok, kind?, error?, status? }}
 */
export function applyCorrection({ ownerId, ref, value = null, action = 'correct', deps = {} } = {}) {
  const d = {
    peekMind, correctBelief, deleteBelief, lockBelief, touchMind, observeSignal,
    ...deps,
  };

  const parsed = parseRef(ref);
  if (!parsed) return { ok: false, status: 400, error: `Unrecognised item: ${ref}` };
  if (!ownerId) return { ok: false, status: 400, error: 'No owner.' };

  if (action !== 'correct' && action !== 'remove' && action !== 'keep') {
    return { ok: false, status: 400, error: `Unknown action: ${action}` };
  }
  if (action === 'correct' && (value == null || String(value).trim() === '')) {
    return { ok: false, status: 400, error: 'A correction needs a value. Use action:"remove" to drop it instead.' };
  }

  const mind = d.peekMind(ownerId);
  if (!mind) return { ok: false, status: 404, error: 'Nothing learned yet.' };

  switch (parsed.kind) {
    case 'belief': {
      if (action === 'remove') {
        return d.deleteBelief(mind, parsed.dimension, parsed.key)
          ? { ok: true, kind: 'belief', removed: true }
          : { ok: false, status: 404, error: 'That is not something I believe.' };
      }
      if (action === 'keep') {
        // "Keep" pins it. The user confirming something is stronger evidence
        // than any amount of inference, and pinning is how the existing engine
        // expresses "stop revising this".
        const locked = d.lockBelief(mind, parsed.dimension, parsed.key, true);
        return locked ? { ok: true, kind: 'belief', locked: true }
                      : { ok: false, status: 404, error: 'That is not something I believe.' };
      }
      const belief = d.correctBelief(mind, parsed.dimension, parsed.key, value);
      return belief ? { ok: true, kind: 'belief', value: belief.value, confidence: belief.confidence }
                    : { ok: false, status: 404, error: 'That is not something I believe.' };
    }

    case 'goal': {
      const goal = mind.goals?.[parsed.id];
      if (!goal) return { ok: false, status: 404, error: 'That is not a goal I know about.' };

      if (action === 'remove') {
        // A goal the user says is not theirs is ABANDONED, not deleted —
        // unlike a belief, a goal has a history that stays meaningful ("we
        // stopped doing this in March") and the timeline reads it. Deleting it
        // would silently rewrite the past.
        goal.history.push({ status: goal.status, at: Date.now(), reason: 'user correction' });
        goal.status = GOAL_STATUS.ABANDONED;
      } else if (action === 'correct') {
        goal.title = String(value).slice(0, 120);
      }
      goal.updatedAt = Date.now();
      goal.privacy.source = 'correction';
      d.touchMind(mind);
      return { ok: true, kind: 'goal', title: goal.title, status: goal.status };
    }

    case 'fact': {
      // Long-term memory. Imported lazily so this module stays loadable in
      // tests that only exercise the Mind paths.
      return applyFactCorrection({ ownerId, key: parsed.key, value, action, deps: d });
    }

    case 'entity': {
      // Entities are DERIVED from evidence, not asserted. Two consequences:
      //
      // 1. There is no meaningful "rename". Changing a graph label would leave
      //    the facts that produced it pointing at something that no longer
      //    matches, and the label is not what the user is disputing anyway.
      //
      // 2. There is no per-node removal in the graph, and this is not an
      //    oversight to paper over: `reasoningGraph` exposes upsertNode,
      //    addEdge, removeFile and purgeOwner — nothing between "one file's
      //    worth" and "everything". Deleting a node would orphan its edges and
      //    corrupt traversal for every reader, and adding safe node removal
      //    means editing a module the DOCUMENT pipeline depends on. Same call
      //    as the relationshipEngine gap in U1: out of contract, stated rather
      //    than smuggled in.
      //
      // So a dismissal is recorded as what it actually is — a fact about the
      // USER ("this isn't mine"), not a claim that the document never said it.
      // The README really did mention it; the graph stays true. The read model
      // filters dismissed ids out of what it shows.
      if (action !== 'remove') {
        return { ok: false, status: 400, error: "I can drop this, but I can't rename it — it comes from what I read." };
      }
      d.observeSignal(mind, {
        dimension: DIMENSIONS.PREFERENCES,
        key: `${DISMISS_PREFIX}${parsed.id}`,
        value: true,
        explicit: true,
        note: 'user said this is not theirs',
      });
      d.touchMind(mind);
      return { ok: true, kind: 'entity', removed: true };
    }

    default:
      return { ok: false, status: 400, error: `Unrecognised item: ${ref}` };
  }
}

function applyFactCorrection({ ownerId, key, value, action, deps }) {
  const editor = deps.memoryEditor;
  if (!editor) return { ok: false, status: 501, error: 'Memory editing unavailable.' };
  try {
    if (action === 'remove') {
      editor.archiveFact(ownerId, key, { reason: 'user_correction' });
      return { ok: true, kind: 'fact', removed: true };
    }
    if (action === 'keep') {
      editor.pinFact(ownerId, key, true);
      return { ok: true, kind: 'fact', pinned: true };
    }
    editor.correctFact(ownerId, key, value, { reason: 'user_correction' });
    return { ok: true, kind: 'fact', value };
  } catch (err) {
    return { ok: false, status: 500, error: err?.message ?? 'Could not update that.' };
  }
}

/**
 * Ids the user has said are not theirs. Beliefs under this prefix are
 * BOOKKEEPING, not understanding — they are excluded from every display
 * surface (see isDismissalKey), because a dashboard listing "hidden:ent:proj:x
 * = true" would be showing the user our filing system instead of their world.
 */
export function dismissedEntityIds(mind) {
  const out = new Set();
  for (const b of Object.values(mind?.beliefs ?? {})) {
    if (b?.dimension !== DIMENSIONS.PREFERENCES) continue;
    if (!String(b.key ?? '').startsWith(DISMISS_PREFIX)) continue;
    if (b.value === true && b.status !== 'archived') out.add(b.key.slice(DISMISS_PREFIX.length));
  }
  return out;
}

/** Is this belief key internal bookkeeping rather than something to show? */
export function isDismissalKey(key) {
  return String(key ?? '').startsWith(DISMISS_PREFIX);
}
