/**
 * AQUA — the CURRENT WORLD section of the answer context (2026-10-11).
 *
 * WHY THIS EXISTS (measured, World-Model Lift dev set, 2026-10-09 run):
 * the relevance-ranked section holds at most 8 claims, and for one question in
 * three the claim that answered it was IN the World Model but not among them —
 * "Nadia will replace Tomás as tech lead" was stored and never retrieved for
 * "Who is my tech lead going forward?" (7 candidates of the owner's 15 claims).
 * Full history won those questions simply because it showed everything. A
 * person's world is small for a long time: tens of current claims, not
 * thousands. Withholding most of it to save a few hundred tokens made the
 * World Model lose to a transcript.
 *
 * WHAT IT IS: the user's own statements behind every CURRENT claim not already
 * in the relevance section — one line per source sentence, oldest → newest,
 * within a fixed character budget. It is a read of the canonical World Model,
 * never a second store (L7), and it is what makes the World Model different
 * from a transcript:
 *   • reconciled — superseded/archived claims and closed past validity are
 *     not current, so their statements are left out unless the same sentence
 *     also supports a current claim;
 *   • cross-conversation and cross-source (files included), no chit-chat;
 *   • disputed claims are labelled, future-dated ones carry their start.
 * When the world outgrows the budget, relevance to the question (the dense
 * scores the caller already has) decides what stays, then recency.
 *
 * Pure: the facade supplies the claims (canonicalReadModel.currentWorld) and
 * the scores; this decides and renders.
 */

export const WORLD_CORE_CHAR_BUDGET = 2000;
export const WORLD_CORE_HEADER = '── ALSO KNOWN ABOUT THE USER — current unless marked scheduled, disputed or stale (their own words, oldest → newest; superseded statements left out) ──';

const norm = s => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const ms = v => {
  if (v == null) return null;
  const n = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(n) ? n : null;
};
const dayOf = v => {
  const n = ms(v);
  return n == null ? null : new Date(n).toISOString().slice(0, 10);
};

function lineFor(group, now) {
  const quote = String(group.text).replace(/\s+/g, ' ').trim().replace(/[.]+$/, '');
  const flags = [];
  if (group.claims.some(c => c.state === 'disputed')) flags.push('disputed — treat as contested');
  if (group.claims.some(c => c.state === 'stale')) flags.push('stale');
  const starts = group.claims.map(c => ms(c.validFrom)).filter(n => n != null && n > now);
  if (starts.length && starts.length === group.claims.length) flags.push(`scheduled from ${dayOf(Math.min(...starts))} — not yet current`);
  const fromFile = group.claims.find(c => c.sourceKind === 'document');
  const fileName = fromFile ? String(fromFile.sourceExternalRef ?? '').match(/^file:(.+):chunk:\d+$/)?.[1] : null;
  const file = fromFile ? `[from uploaded file${fileName ? ` ${fileName}` : ''}] ` : '';
  // PARTLY RETIRED SENTENCE (2026-10-11, live product run): "My biggest client
  // is a restaurant called Fennel" carried the retired role AND the still-
  // current "Fennel is a restaurant"; quoting it whole re-asserted the retired
  // role in every later conversation. Only the current claims' READINGS are
  // shown; with no reading the sentence is left out rather than re-asserted.
  if (group.retired) {
    const readings = [...new Set(group.claims.map(c => (typeof group.reading === 'function' ? group.reading(c) : null)).filter(Boolean))];
    if (!readings.length) return null;
    return `• ${file}${readings.join('; ')}${flags.length ? ` (${flags.join('; ')})` : ''}`;
  }
  return `• ${file}"${quote}"${flags.length ? ` (${flags.join('; ')})` : ''}`;
}

/**
 * @param {object[]} claims        current claims (canonicalReadModel.currentWorld shape)
 * @param {object}   [opts]
 * @param {Iterable<string>} [opts.excludeIds]   claim ids already rendered elsewhere
 * @param {Iterable<string>} [opts.excludeTexts] statements already rendered elsewhere
 * @param {Map<string,number>} [opts.scores]     question relevance by claim id (dense)
 * @param {number} [opts.charBudget]
 * @param {number} [opts.now]
 * @param {Iterable<string>} [opts.retiredTexts] sentences behind a no-longer-current claim
 * @param {(claim:object)=>string|null} [opts.reading] structured reading of a claim (used for partly retired sentences)
 * @returns {{ block: string, lines: string[], claimIds: string[], considered: number, omitted: number, chars: number }}
 */
export function selectWorldCore(claims, opts = {}) {
  const now = opts.now ?? Date.now();
  const budget = Number.isFinite(opts.charBudget) ? opts.charBudget : WORLD_CORE_CHAR_BUDGET;
  const excludeIds = new Set([...(opts.excludeIds ?? [])].map(String));
  const excludeTexts = new Set([...(opts.excludeTexts ?? [])].map(norm).filter(Boolean));
  const scores = opts.scores instanceof Map ? opts.scores : null;
  const retiredTexts = new Set([...(opts.retiredTexts ?? [])].map(norm).filter(Boolean));
  const reading = typeof opts.reading === 'function' ? opts.reading : null;

  // One line per SOURCE SENTENCE: "We use PostgreSQL and Go" is two claims and
  // one thing the user said.
  const groups = new Map();
  let considered = 0;
  for (const c of Array.isArray(claims) ? claims : []) {
    if (!c?.statement || !c.claimId) continue;
    if (c.state === 'superseded' || c.state === 'archived') continue;
    const end = ms(c.validTo);
    if (end != null && end < now) continue;
    considered++;
    const key = norm(c.statement);
    if (!key || excludeTexts.has(key)) continue;
    const g = groups.get(key) ?? { text: c.statement, claims: [], at: Infinity, score: 0, retired: retiredTexts.has(key), reading };
    g.claims.push(c);
    g.at = Math.min(g.at, ms(c.assertedAt) ?? Infinity);
    g.score = Math.max(g.score, Number(scores?.get(String(c.claimId)) ?? 0) || 0);
    groups.set(key, g);
  }
  // A sentence already rendered for ANY of its claims is not repeated.
  for (const [key, g] of groups) if (g.claims.some(c => excludeIds.has(String(c.claimId)))) groups.delete(key);

  // Budget: relevance first, then recency — only matters once the world is big.
  const ranked = [...groups.values()].sort((a, b) => b.score - a.score || b.at - a.at);
  const kept = [];
  let chars = WORLD_CORE_HEADER.length + 1;
  for (const g of ranked) {
    const line = lineFor(g, now);
    if (!line || chars + line.length + 1 > budget) continue;
    kept.push({ ...g, line });
    chars += line.length + 1;
  }
  kept.sort((a, b) => a.at - b.at);
  const lines = kept.map(g => g.line);
  return {
    block: lines.length ? [WORLD_CORE_HEADER, ...lines].join('\n') : '',
    lines,
    claimIds: kept.flatMap(g => g.claims.map(c => String(c.claimId))),
    considered,
    omitted: ranked.length - kept.length,
    chars: lines.length ? chars : 0,
  };
}
