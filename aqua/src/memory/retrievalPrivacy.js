/**
 * AQUA — retrieval privacy, sentence by sentence (2026-11-06).
 *
 * The sensitivity classifier (memory/sensitivity.js classifyText) is NOT
 * consistent across sentence boundaries, so recall never classifies a passage
 * as a whole:
 *   · "I bought new running shoes. The doctor in that film was funny." — the
 *     passage reads as health (the "I" of one sentence meets the "doctor" of
 *     the other), neither sentence does;
 *   · "I have asthma. We are building an app for runners." — the passage reads
 *     as NOT sensitive (product framing in the sibling), the first sentence is
 *     health. Whole-passage checks therefore both over-withheld the first and
 *     let the second be embedded and sent to the provider.
 *
 * What this module decides, per SENTENCE:
 *   sensitiveKindOf(s)   'health' | 'mood' | null (memoised; the classifier is pure)
 *   withheldBy(policy)   s → true when the turn's policy withholds it — the
 *                        existing sensitivePolicy semantics, unchanged: allowed
 *                        only when the user opted in AND the turn is about that
 *                        kind; no policy withholds every sensitive kind
 *   policyKey(policy)    which kinds the policy allows (a cache key)
 *   embeddableSentences  what may go to the embedding provider: never a
 *                        sensitive sentence (whatever the policy) and never a
 *                        forgotten one
 *   questionEmbedText    the current question with its sensitive sentences
 *                        removed — '' when nothing eligible is left
 *
 * Withheld is not forgotten: nothing here writes to the forget list or deletes
 * anything; a withheld sentence stays in the conversation store and becomes
 * retrievable on a turn whose policy allows it.
 */
import { classifySentence } from './sensitivity.js';
// Same splitter as recall passages. episodicRecall imports this module too; the
// cycle is safe because sentencesOf is only called at run time, never at load.
import { sentencesOf } from './episodicRecall.js';

const KIND_CACHE_MAX = 50_000;
const kindCache = new Map();

/** The sensitive kind of ONE sentence (memoised). */
export function sensitiveKindOf(sentence) {
  const s = String(sentence ?? '');
  if (kindCache.has(s)) return kindCache.get(s);
  // Whole AND clause by clause (sensitivity.js classifySentence, 2026-11-06): in ONE
  // sentence — "I have asthma, and we are building an app for runners." — the
  // sibling clause's product framing masked the health clause for classifyText,
  // so the sentence was embedded and ranked. Any sensitive clause makes it sensitive.
  const k = classifySentence(s);
  kindCache.set(s, k);
  if (kindCache.size > KIND_CACHE_MAX) kindCache.delete(kindCache.keys().next().value);
  return k;
}

/** Sentence predicate: withheld by this turn's policy (null policy = every sensitive kind withheld). */
export function withheldBy(policy) {
  return sentence => {
    const k = sensitiveKindOf(sentence);
    return !!k && !policy?.allows?.(k);
  };
}

/** Which kinds the policy allows — the only thing a cleaned pool depends on. */
export function policyKey(policy) {
  return `h${policy?.allows?.('health') ? 1 : 0}m${policy?.allows?.('mood') ? 1 : 0}`;
}

const splitSentences = text => sentencesOf(String(text ?? ''));
export const sentencesOfText = splitSentences;

/**
 * The sentences of a recall passage that may be EMBEDDED: none forgotten (the
 * passage-level rule recall uses for a phrase that crosses a sentence boundary)
 * and none sensitive. null when nothing is left, or for file passages.
 */
export function embeddableSentences(u, forget = null) {
  if (!u?.text || u.source === 'file') return null;
  let kept = u.sentences ?? splitSentences(u.text);
  if (forget && forget.active !== false && forget.isRedacted(u.text, u.ts)) {
    const parts = kept.filter(s => !forget.isRedacted(s, u.ts));
    if (parts.length === kept.length || !parts.length || forget.isRedacted(parts.join(' '), u.ts)) return null;
    kept = parts;
  }
  kept = kept.filter(s => !sensitiveKindOf(s));
  return kept.length ? kept : null;
}

/** The current question as it may be embedded: its sensitive sentences removed. */
export function questionEmbedText(query) {
  const kept = splitSentences(String(query ?? '').trim()).filter(s => !sensitiveKindOf(s));
  return kept.join(' ').trim();
}
