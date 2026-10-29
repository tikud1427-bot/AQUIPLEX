/**
 * Stored values their own schema would reject today (2026-10-28) — "loveit"
 * as a disliked language, "billionaire" as a profession — written before those
 * validators were fixed. The Memory page and its change feed leave them out
 * (L11); they stay stored (L5) and forgettable.
 *
 * Only the slots whose validators were tightened: a user correction is stored
 * without a validator, and re-judging every key could hide something the user
 * explicitly said.
 */
import { getSchema } from './memorySchema.js';

const REVALIDATED_KEYS = new Set(['favorite_language', 'least_favorite_language', 'profession']);

export function failsItsSchema(fact) {
  if (!REVALIDATED_KEYS.has(fact?.key)) return false;
  // The user looked at it in the review (mind/legacyReview.js) and said it is
  // right: their word, not the validator's.
  if (fact.userConfirmedAt) return false;
  const schema = getSchema(fact.key);
  if (!schema?.validator) return false;
  const values = (Array.isArray(fact.value) ? fact.value : [fact.value]).filter(v => typeof v === 'string');
  if (!values.length) return false;
  const norm = v => { try { return schema.normalizer ? schema.normalizer(v) : v; } catch { return v; } };
  return values.every(v => { try { return !schema.validator(norm(v)); } catch { return false; } });
}
