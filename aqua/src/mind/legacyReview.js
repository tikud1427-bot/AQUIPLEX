/**
 * AQUA — legacy data review (2026-10-29).
 *
 * Records written before the 2026-10-28 fixes can still be wrong in ways the
 * fixed code would not produce today:
 *
 *   merged_goal        one goal holding several ("become a billionaire and
 *                      build a company people love") — goalTracker used to
 *                      capture through "and".
 *   fact_fails_schema  a stored fact its own validator rejects today
 *                      ("profession: billionaire"). Hidden from the Memory page
 *                      and from prompts since 2026-10-28 — which also meant the
 *                      user could no longer see or delete it.
 *   role_is_aspiration an identity belief whose role is an aspiration. Hidden
 *                      the same way, with the same blind spot.
 *
 * Nothing here changes data. It finds CANDIDATES with the same rules the
 * fixed code applies to new input; the user decides (split / keep / remove)
 * through the routes in mindRoutes.js and memory.js. A rule that cannot be
 * applied reliably is not applied automatically — that is the point.
 */
import { splitGoalTitle } from './goalText.js';
import { GOAL_STATUS } from './mindSchema.js';
import { failsItsSchema } from '../memory/factVisibility.js';
import { factLabel, factItems, isAspirationalRole } from '../memory/displayLabels.js';

const ROLE_KEYS = new Set(['profession', 'role', 'job_title']);

/** The user already decided about this record. */
export const reviewed = r => Boolean(r?.reviewedAt || r?.userConfirmedAt);

/**
 * @param {{ mind?: object|null, facts?: object[] }} input  one owner's Mind and legacy facts
 * @returns {object[]} candidates, each with a stable `id` and only display-safe fields
 */
export function reviewCandidates({ mind = null, facts = [] } = {}) {
  const out = [];
  for (const g of Object.values(mind?.goals ?? {})) {
    if (!g || g.splitInto || reviewed(g) || g.status === GOAL_STATUS.ABANDONED || g.status === GOAL_STATUS.COMPLETED) continue;
    const parts = splitGoalTitle(g.title);
    if (parts.length >= 2) out.push({ id: `goal:${g.id}`, kind: 'merged_goal', goalId: g.id, title: g.title, parts });
  }
  for (const f of Array.isArray(facts) ? facts : []) {
    // merged_goal_item: the fact store's goal collection held "x and y" as one
    // item until the extractor split goals too (2026-10-29).
    if (f?.key === 'goal') {
      const items = (Array.isArray(f.value) ? f.value : [f.value]).filter(v => typeof v === 'string');
      for (const item of items) {
        if ((f.reviewedItems ?? []).includes(item)) continue;
        const parts = splitGoalTitle(item);
        if (parts.length >= 2) out.push({ id: `factitem:goal:${item}`, kind: 'merged_goal_item', key: 'goal', item, parts });
      }
    }
    if (!f?.key || reviewed(f) || !failsItsSchema(f)) continue;
    out.push({
      id: `fact:${f.key}`, kind: 'fact_fails_schema', key: f.key, label: factLabel(f),
      value: factItems(f.value).join(', '), aspiration: isAspirationalRole(f.value),
      learnedFrom: f.sourceMessage ?? f.sourceText ?? null,
    });
  }
  for (const b of Object.values(mind?.beliefs ?? {})) {
    if (!b || b.dimension !== 'identity' || !ROLE_KEYS.has(b.key) || reviewed(b)) continue;
    if (b.privacy?.source === 'correction' || !isAspirationalRole(b.value)) continue;
    out.push({ id: `belief:identity:${b.key}`, kind: 'role_is_aspiration', dimension: 'identity', key: b.key, value: String(b.value) });
  }
  return out;
}
