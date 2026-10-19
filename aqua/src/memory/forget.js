/**
 * AQUA — user memory control, applied everywhere a memory can answer from
 * (audit 2026-10-12).
 *
 * One thing the user said is held in three places that can each reach the
 * answer: the legacy fact store (what the Memory page lists and deletes), the
 * canonical World Model (what answers by default), and the conversation
 * evidence lane (what answers on a legacy or degraded read). Deleting only the
 * first left the answer unchanged. Every user-initiated forget or correction
 * goes through here.
 *
 * Order: World Model first, legacy last. When the canonical store is
 * configured but unreachable the call fails with WORLD_MODEL_UNAVAILABLE
 * BEFORE the legacy copy is touched, so the user is never told a memory is
 * gone while the copy that answers is still there; retrying is safe
 * (archiving is idempotent).
 */
import { getFact, getFacts, deleteFact, clearFacts } from './longTermMemory.js';

export class MemoryControlUnavailable extends Error {
  constructor(message = 'Memory is temporarily unavailable — nothing was changed. Please try again.') {
    super(message);
    this.name = 'MemoryControlUnavailable';
    this.code = 'WORLD_MODEL_UNAVAILABLE';
  }
}

const brain = () => import('../brain/index.js');   // lazy: brain imports this package's stores

async function guarded(fn) {
  try { return await fn(); }
  catch (err) {
    if (err?.code === 'WORLD_MODEL_UNAVAILABLE') throw new MemoryControlUnavailable();
    throw err;
  }
}

/** Forget one legacy fact everywhere. Returns null when the owner has no such fact. */
export async function forgetFact(ownerId, key) {
  const fact = getFact(ownerId, key);
  if (!fact) return null;
  const Brain = await brain();
  const worldModel = await guarded(() => Brain.forgetWorldModelFact(ownerId, { key, value: fact.value }));
  deleteFact(ownerId, key);
  logControl('FORGET', ownerId, key, worldModel);
  return { key, worldModel };
}

/**
 * Forget one CANONICAL claim — what the Memory page shows answering (2026-10-16).
 * World Model first (archive + conversation lane); then every legacy fact
 * holding the same value, so no store is left that could answer it. A
 * resurrected legacy copy is also blocked by the veto (user-archived values
 * count as retired). Returns null when the claim is not this owner's.
 */
export async function forgetClaim(ownerId, claimId) {
  const Brain = await brain();
  const worldModel = await guarded(() => Brain.forgetWorldModelClaim(ownerId, claimId));
  if (!worldModel) return null;
  const legacy = [];
  // A deleted ROLE ("Maya — my co-founder") also clears the legacy slot named
  // by that role, whatever it holds: the regex extractor filled "cofounder"
  // with a wrong value ("And") that matched no deleted value and kept
  // answering "your co-founder is And" (live journey 2026-10-17).
  const slots = new Set(worldModel.values.map(slotOf).filter(s => s.length >= 4));
  for (const fact of getFacts(ownerId, { includeArchived: true })) {
    const held = Brain.legacyValueStrings(fact.value);
    if (held.some(h => worldModel.values.includes(h)) || slots.has(slotOf(fact.key))) {
      deleteFact(ownerId, fact.key);
      legacy.push(fact.key);
    }
  }
  logControl('FORGET_CLAIM', ownerId, claimId, worldModel);
  return { ...worldModel, legacyFacts: legacy };
}

/**
 * Correct one CANONICAL claim to a new value (Memory page, 2026-10-16). The
 * World Model gets a user-correction successor (new value as the object); any
 * legacy fact still holding the OLD value is removed so no store keeps it
 * (the veto would also withhold it — the old claim is now superseded).
 */
export async function correctClaimValue(ownerId, claimId, newValue) {
  const Brain = await brain();
  const worldModel = await guarded(() => Brain.correctWorldModelClaimValue(ownerId, claimId, newValue));
  if (!worldModel) return null;
  const old = worldModel.oldValue == null ? [] : Brain.legacyValueStrings(worldModel.oldValue);
  const legacy = [];
  for (const fact of getFacts(ownerId, { includeArchived: true })) {
    if (Brain.legacyValueStrings(fact.value).some(h => old.includes(h))) { deleteFact(ownerId, fact.key); legacy.push(fact.key); }
  }
  logControl('CORRECT_CLAIM', ownerId, claimId, { corrected: [worldModel], conversationFacts: worldModel.conversationFacts });
  return { ...worldModel, legacyFacts: legacy };
}

/** Forget every fact the user told Aqua (uploaded documents are managed separately). */
export async function forgetAllFacts(ownerId) {
  const Brain = await brain();
  const worldModel = await guarded(() => Brain.forgetWorldModelAll(ownerId));
  clearFacts(ownerId);
  logControl('FORGET_ALL', ownerId, '*', worldModel);
  return { worldModel };
}

/**
 * The legacy correction already happened (memory/memoryEditor.js) and changed
 * `key` from `oldValue`; carry it into the World Model so the old value stops
 * answering.
 */
export async function correctFactEverywhere(ownerId, key, oldValue, newValue) {
  if (oldValue == null || String(oldValue) === String(newValue)) return { worldModel: null };
  const Brain = await brain();
  const worldModel = await guarded(() => Brain.correctWorldModelFact(ownerId, { key, oldValue, newValue }));
  logControl('CORRECT', ownerId, key, worldModel);
  return { worldModel };
}

/** Is the World Model able to take a user's memory change right now? (pre-check for edits that cannot be undone cheaply) */
export async function worldModelWritable() {
  return (await brain()).worldModelWritable();
}

/**
 * Chat-path forget ("forget my city"): the turn must not fail or wait, so the
 * World Model side runs in the background; the legacy delete already happened
 * in the observation step.
 */
export function forgetInBackground(ownerId, key, value) {
  brain()
    .then(Brain => Brain.forgetWorldModelFact(ownerId, { key, value }, { reason: 'user-forget-chat' }))
    .then(r => logControl('FORGET_CHAT', ownerId, key, r))
    .catch(err => console.warn(`[MEMORY] chat forget did not reach the World Model owner=${ownerId} key=${key}: ${err?.message ?? err}`));
}

/**
 * A legacy value changed in conversation: retire the conversation-lane
 * sentence that stated the old value (brain/index.js retireSupersededStatement).
 */
export function retireSupersededInBackground(ownerId, key, previous) {
  brain()
    .then(Brain => Brain.retireSupersededStatement(ownerId, { oldValue: previous.value, sourceText: previous.sourceText }))
    .then(ids => { if (ids.length) console.log(`[MEMORY] SUPERSEDED owner=${ownerId} key=${key} conversationFacts=${ids.length}`); })
    .catch(err => console.warn(`[MEMORY] superseded statement not retired owner=${ownerId} key=${key}: ${err?.message ?? err}`));
}

/** "co-founder" / "Co Founder" / "cofounder" → "cofounder": a legacy key and a role value compare equal. */
export function slotOf(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z]/g, '');
}

function logControl(kind, ownerId, key, wm) {
  const claims = (wm?.claims?.length ?? 0) + (wm?.corrected?.length ?? 0);
  console.log(`[MEMORY] ${kind} owner=${ownerId} key=${key} canonicalClaims=${claims} conversationFacts=${wm?.conversationFacts?.length ?? 0}`);
}
