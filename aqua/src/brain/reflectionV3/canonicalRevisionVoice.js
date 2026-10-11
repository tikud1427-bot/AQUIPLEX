/**
 * AQUA Brain — the revision voice over the CANONICAL World Model (2026-10-04).
 *
 * The original voice (reflectionV2/revisionVoice.js) reads the legacy PIC
 * ledger. Since E6/E9 the changes worth admitting happen in Postgres: the
 * contradiction policy supersedes an older snapshot of a single-valued fact, or
 * marks two claims disputed when it cannot tell which holds. The legacy voice
 * never saw either. This module chooses which canonical change (if any) to
 * raise on a turn and words it. PURE: candidates and watermark are arguments.
 *
 * What is raised, and why each exclusion exists:
 *   disputed     always eligible — two of the user's own statements that cannot
 *                both be current, and AQUA has not settled it. Asking is the
 *                only honest move.
 *   superseded   eligible only when the newer claim came from a DIFFERENT
 *                conversation than the current one (asking about what the user
 *                said minutes ago is an echo), and only when the retirement was
 *                the policy's inference — never a user correction (the user
 *                already told us; confirming it back is nagging).
 *   stale rows   a candidate whose old claim is no longer in the state the
 *                transition put it in (dispute later resolved, etc.) is skipped:
 *                only what is still true is raised.
 *
 * Never invents: the directive quotes the user's stored statements verbatim
 * (whitespace-collapsed, length-capped) and adds nothing about their life. A
 * candidate missing either statement is skipped, not paraphrased.
 *
 * Ordering is (createdAt, transitionId) — the watermark's own key — so ties in
 * the same millisecond are exact. Newest eligible wins; everything considered
 * is decided (the watermark passes all of it), as in the legacy voice.
 */

const MAX_QUOTE = 160;

function quote(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > MAX_QUOTE ? `${s.slice(0, MAX_QUOTE - 1)}…` : s;
}

function fromConversation(ref, conversationId) {
  return Boolean(conversationId && ref && String(ref).startsWith(`${conversationId}:turn:`));
}

/** Why a candidate is (not) raisable. `null` = eligible. */
export function exclusionReason(c, { conversationId = null } = {}) {
  if (!c) return 'missing';
  if (c.currentState && c.currentState !== c.toState) return 'no-longer-current';
  if (!quote(c.oldText) || !quote(c.newText)) return 'missing-statement';
  if (c.toState === 'disputed') return null;
  if (c.toState !== 'superseded') return 'not-a-revision';
  // The same signals the policy itself treats as a correction (rule 1).
  if (/^user-correction/.test(String(c.reason ?? '')) || /explicit user correction/.test(String(c.reason ?? ''))
      || c.newActor === 'user') return 'user-correction';
  if (fromConversation(c.newRef, conversationId)) return 'said-in-this-conversation';
  return null;
}

/** The directive for one candidate — '' unless it has both statements. Eligibility is selectCanonicalRevision's job. */
export function buildCanonicalDirective(c) {
  if (!c || !['disputed', 'superseded'].includes(c.toState) || !quote(c.oldText) || !quote(c.newText)) return '';
  const older = quote(c.oldText);
  const newer = quote(c.newText);
  const what = c.toState === 'disputed'
    ? `They have told you two things that cannot both be current: "${older}" and "${newer}". You have not settled which one holds.`
    : `Earlier they told you "${older}". Later they told you "${newer}", and you now treat the earlier one as no longer current.`;
  return [
    'SOMETHING YOU NOTICED, and have not mentioned yet.',
    what,
    'If — and only if — it fits naturally, raise it ONCE, briefly, in your own '
      + 'words, near the end of your reply. Ask whether you have it right'
      + (c.toState === 'disputed' ? ' and which one is current' : '')
      + '. Do not assert anything about their situation beyond the words quoted above.',
    'Never describe the mechanism. No mention of a world model, a reflection, '
      + 'confidence scores, or counts of anything. If the current message is '
      + 'urgent, technical, or emotionally loaded, say nothing about this at all '
      + 'and just answer them.',
  ].join('\n');
}

const key = c => [new Date(c.createdAt).getTime(), String(c.transitionId)];
function after(a, b) {
  const [ta, ia] = key(a); const [tb, ib] = key(b);
  return ta !== tb ? ta > tb : ia > ib;
}

/**
 * @param {object[]} candidates  transitions past the watermark (any order)
 * @param {{conversationId?: string}} ctx
 * @returns {{ chosen: object|null, directive: string, watermark: {at, transitionId}|null, considered: object[] }}
 */
export function selectCanonicalRevision(candidates, { conversationId = null } = {}) {
  const list = [...(candidates ?? [])].filter(c => c?.transitionId && c?.createdAt);
  if (!list.length) return { chosen: null, directive: '', watermark: null, considered: [] };
  list.sort((a, b) => (after(a, b) ? 1 : after(b, a) ? -1 : 0));
  const newest = list[list.length - 1];
  const considered = list.map(c => ({ transitionId: c.transitionId, excluded: exclusionReason(c, { conversationId }) }));
  let chosen = null;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (!exclusionReason(list[i], { conversationId })) { chosen = list[i]; break; }
  }
  return {
    chosen,
    directive: chosen ? buildCanonicalDirective(chosen) : '',
    watermark: { at: newest.createdAt, transitionId: newest.transitionId },
    considered,
  };
}
