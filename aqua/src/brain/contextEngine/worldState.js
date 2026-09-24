/**
 * AQUA — deterministic World State synthesis.
 *
 * This is a derived read model, never a second knowledge store.
 * It summarizes current, owner-scoped canonical/retrieved claims into a
 * compact situation model for reasoning. Claims remain the only atom.
 *
 * Rules are intentionally conservative: only active/current claims with
 * explicit predicates contribute to "current" state. No LLM inference occurs
 * here, and no value is persisted.
 */

const CURRENT = new Set(['active', 'trusted']);
const HISTORICAL = new Set(['superseded', 'archived']);

const ROLE_PREDICATES = new Map([
  ['works_on', 'projects'],
  ['working_on', 'projects'],
  ['building', 'projects'],
  ['owns', 'projects'],
  ['responsible_for', 'projects'],
  ['has_goal', 'goals'],
  ['pursues', 'goals'],
  ['prioritizes', 'priorities'],
  ['priority', 'priorities'],
  ['focuses_on', 'priorities'],
]);

function clean(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

function objectText(claim) {
  const o = claim?.object;
  if (o == null) return '';
  if (typeof o === 'string') return clean(o);
  if (o.entity) return clean(o.entity);
  if (o.literal != null) return clean(o.literal);
  if (o.quantity != null) return `${o.quantity}${o.unit ? ` ${o.unit}` : ''}`;
  if (o.time != null) return clean(o.time);
  return '';
}

function currentClaim(c) {
  const state = String(c?.state ?? '').toLowerCase();
  if (!CURRENT.has(state)) return false;
  if (c?.validTo) return false;
  return true;
}

/**
 * Build a derived world-state snapshot from retrieval candidates.
 *
 * @returns {{
 *   currentProjects:string[], currentGoals:string[], priorities:string[],
 *   recentChanges:string[], uncertain:string[], evidenceIds:string[],
 *   claimsUsed:number, confidence:number
 * }}
 */
export function buildWorldState(candidates = [], opts = {}) {
  const limit = Math.max(1, Number(opts.limit ?? 6));
  const seen = new Set();
  const projects = [];
  const goals = [];
  const priorities = [];
  const changes = [];
  const uncertain = [];
  const evidenceIds = [];

  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (!currentClaim(c)) continue;
    const predicate = clean(c.predicate).toLowerCase();
    const value = objectText(c);
    if (!predicate || !value) continue;

    const key = `${predicate}:${value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const bucket = ROLE_PREDICATES.get(predicate);
    if (bucket === 'projects') projects.push(value);
    else if (bucket === 'goals') goals.push(value);
    else if (bucket === 'priorities') priorities.push(value);

    if (c.validFrom || c.assertedAt) {
      changes.push({
        predicate,
        value,
        assertedAt: c.assertedAt ?? c.validFrom ?? null,
        claimId: c.id ?? null,
      });
    }

    const confidence = Number(c.confidence ?? 0.5);
    if (c.disputed || confidence < 0.45) {
      uncertain.push(value);
    }
    if (Array.isArray(c.citations)) evidenceIds.push(...c.citations.slice(0, 2));
  }

  const compactChanges = changes
    .sort((a, b) => String(b.assertedAt ?? '').localeCompare(String(a.assertedAt ?? '')))
    .slice(0, limit);

  const confidenceValues = (Array.isArray(candidates) ? candidates : [])
    .filter(currentClaim)
    .map(c => Number(c.confidence ?? 0.5))
    .filter(Number.isFinite);
  const confidence = confidenceValues.length
    ? confidenceValues.reduce((a, b) => a + b, 0) / confidenceValues.length
    : 0;

  return {
    currentProjects: [...new Set(projects)].slice(0, limit),
    currentGoals: [...new Set(goals)].slice(0, limit),
    priorities: [...new Set(priorities)].slice(0, limit),
    recentChanges: compactChanges,
    uncertain: [...new Set(uncertain)].slice(0, limit),
    evidenceIds: [...new Set(evidenceIds)].slice(0, limit * 2),
    claimsUsed: seen.size,
    confidence: Math.round(confidence * 1000) / 1000,
  };
}

export function renderWorldState(state) {
  if (!state || !state.claimsUsed) return '';
  const lines = ['── CURRENT WORLD STATE (DERIVED, NOT STORED) ──'];
  if (state.currentProjects.length) lines.push(`Current projects: ${state.currentProjects.join('; ')}`);
  if (state.currentGoals.length) lines.push(`Current goals: ${state.currentGoals.join('; ')}`);
  if (state.priorities.length) lines.push(`Current priorities: ${state.priorities.join('; ')}`);
  if (state.recentChanges.length) {
    lines.push(`Recent known changes: ${state.recentChanges.slice(0, 4).map(x => `${x.predicate} → ${x.value}`).join('; ')}`);
  }
  if (state.uncertain.length) lines.push(`Uncertain/contested: ${state.uncertain.join('; ')}`);
  lines.push(`Grounded in ${state.claimsUsed} current claim(s); mean confidence ${state.confidence.toFixed(2)}.`);
  lines.push('Treat this as a derived snapshot of retrieved evidence; do not invent missing state.');
  return lines.join('\n');
}
