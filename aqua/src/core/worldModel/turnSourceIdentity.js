/**
 * ONE definition of "which canonical source is this conversation turn".
 *
 * The canonical commit (brain/index.js) keys every claim of a turn to a
 * deterministic source uuid so a replay of the turn lands on the same ledger
 * row. The legacy lane (conversationFacts.js) keys its facts to `conv:C:T`.
 * Anything that wants to ask "did BOTH lanes see this turn?" has to turn one
 * identity into the other, and a second copy of the hashing recipe is exactly
 * how a diagnostic ends up measuring a join that never matches. So the recipe
 * lives here, the writer imports it, and the reconciliation report imports it;
 * a test pins that the writer holds no private copy.
 *
 * Pure: no I/O, no store, no flags.
 */
import crypto from 'node:crypto';

export function deterministicUuid(seed) {
  const bytes = crypto.createHash('sha256').update(String(seed)).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The canonical `aqua_sources.source_id` of one conversation turn. */
export function canonicalTurnSourceId(ownerId, conversationId, turn) {
  return deterministicUuid(
    `conversation-turn:${ownerId}:${conversationId ?? 'unknown'}:${Number.isInteger(turn) ? turn : 'unknown'}`,
  );
}

const LEGACY_FACT_ID = /^conv:(.+):(\d+):fact:\d+$/;
const LEGACY_SOURCE_ID = /^conv:(.+):(\d+)$/;

/**
 * Parse a legacy FACT id (`conv:C:T:fact:i`). Conversation ids may themselves
 * contain colons, so the turn is anchored from the RIGHT. Returns null for
 * anything else (document facts, derived facts, malformed ids) rather than
 * guessing. Deliberately NOT tolerant of the source-id form: `conv:a:x:fact:1`
 * would otherwise parse as conversation "a:x:fact", turn 1.
 */
export function parseLegacyFactTurn(id) {
  const m = LEGACY_FACT_ID.exec(String(id ?? ''));
  return m ? { conversationId: m[1], turn: Number(m[2]) } : null;
}

/** Parse a legacy SOURCE id (`conv:C:T`). Same rules, other shape. */
export function parseLegacySourceTurn(id) {
  const s = String(id ?? '');
  if (LEGACY_FACT_ID.test(s)) return null;                    // a fact id is not a source id
  const m = LEGACY_SOURCE_ID.exec(s);
  return m ? { conversationId: m[1], turn: Number(m[2]) } : null;
}
