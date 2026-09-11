/**
 * AQUA Entity Resolver — Cross-File Reasoning (Phase 3)
 *
 * Determines when entity mentions in DIFFERENT files refer to the same
 * real-world thing — "OpenAI" / "Open AI" / "OpenAI Inc." → one canonical
 * entity — WITHOUT over-merging. Over-merging is the cardinal failure of a
 * reasoning graph: fusing two distinct "John"s silently corrupts every
 * downstream conclusion. So this resolver is deliberately conservative and
 * every merge carries a confidence and the evidence (which mentions, from
 * which files) that justified it.
 *
 * Method (pure, deterministic, no model, no embeddings — a model-based
 * resolver plugs in behind resolveEntities() later):
 *   1. NORMALIZE each mention: casefold, strip legal suffixes (Inc/Ltd/LLC/
 *      Corp/GmbH/…), collapse punctuation/whitespace, drop honorifics.
 *   2. BLOCK by type + normalized-token overlap so we only ever compare
 *      plausibly-related mentions (no O(n²) across the whole corpus).
 *   3. SCORE each candidate pair with a similarity that rewards exact
 *      normalized equality, token-subset ("John" ⊂ "John Smith"), and
 *      acronym/initialism matches, and PENALIZES conflicting tokens
 *      (different middle names, different numbers).
 *   4. MERGE only above MERGE_THRESHOLD; between REVIEW and MERGE the pair
 *      is recorded as an AMBIGUOUS candidate (surfaced, never auto-merged).
 *   Type mismatch (person vs org) is a hard block — never merged.
 *
 * Output is a set of canonical entities, each with { canonical, type,
 * aliases[], mentions[] (file + evidence provenance), confidence }, plus a
 * list of ambiguous pairs the next layer (or a human) can adjudicate.
 */

const LEGAL_SUFFIX = /\b(inc|incorporated|ltd|limited|llc|llp|corp|corporation|co|company|gmbh|ag|sa|plc|pvt|private|group|holdings?|technologies|technology|labs?|systems?)\b/gi;
const HONORIFIC     = /\b(mr|mrs|ms|dr|prof|sir|madam|shri|smt)\b\.?/gi;
const PUNCT         = /[.,''`"()]/g;

/** Entity types that must never merge across the boundary. */
const HARD_TYPE_BLOCK = new Set(['person', 'org', 'name', 'place', 'date', 'money', 'version', 'filename',
  // FI-2: identifier-class types — exact-match identity, never fuzzy-merged
  'phone', 'ip', 'mac', 'hash', 'coordinate', 'code_symbol', 'chemical', 'medical_code', 'legal_cite']);

const MERGE_THRESHOLD  = 0.82; // ≥ → same entity
const REVIEW_THRESHOLD = 0.62; // [REVIEW, MERGE) → ambiguous, surfaced not merged

/** Canonicalize a raw mention to its comparison form. */
export function normalizeMention(raw) {
  return String(raw)
    .replace(HONORIFIC, ' ')
    .replace(LEGAL_SUFFIX, ' ')
    .replace(PUNCT, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function tokens(norm) { return norm.split(' ').filter(Boolean); }

function isAcronymOf(short, long) {
  const st = short.replace(/\s/g, '');
  const initials = tokens(long).map(t => t[0]).join('');
  return st.length >= 2 && st === initials;
}

/**
 * "j smith" ↔ "john smith", "j. r. smith" ↔ "john robert smith".
 * Same token count, same surname (last token), and every earlier token is
 * either equal or one is the single-letter initial of the other. Requires
 * a shared full (>1 char) surname so "j smith" ↔ "j jones" can't match.
 */
function initialAbbreviationMatch(ta, tb) {
  if (ta.length !== tb.length || ta.length < 2) return false;
  if (ta[ta.length - 1] !== tb[tb.length - 1] || ta[ta.length - 1].length < 2) return false;
  let sawInitial = false;
  for (let i = 0; i < ta.length - 1; i++) {
    const x = ta[i], y = tb[i];
    if (x === y) continue;
    if ((x.length === 1 && y.startsWith(x)) || (y.length === 1 && x.startsWith(y))) { sawInitial = true; continue; }
    return false;
  }
  return sawInitial;
}

/**
 * Similarity in [0,1] for two normalized mentions of the same type.
 * Returns { score, reason } — reason feeds the merge's evidence.
 */
export function mentionSimilarity(aNorm, bNorm) {
  if (!aNorm || !bNorm) return { score: 0, reason: 'empty' };
  if (aNorm === bNorm) return { score: 1, reason: 'exact-normalized-match' };

  const ta = tokens(aNorm), tb = tokens(bNorm);
  const setA = new Set(ta), setB = new Set(tb);

  // Compact-form equality: "open ai" ↔ "openai", "e bay" ↔ "ebay".
  if (aNorm.replace(/\s/g, '') === bNorm.replace(/\s/g, '')) return { score: 0.9, reason: 'spacing-variant' };

  // Acronym / initialism (IBM ↔ international business machines).
  if (isAcronymOf(aNorm, bNorm) || isAcronymOf(bNorm, aNorm)) return { score: 0.88, reason: 'acronym-match' };

  // Initial-abbreviated name: "j smith" ↔ "john smith", "j. r. r. tolkien".
  const initMatch = initialAbbreviationMatch(ta, tb);
  if (initMatch) return { score: 0.85, reason: 'initial-abbreviation' };

  // Token subset: "john" ⊂ "john smith", "openai" ⊂ "openai platform".
  const shared = [...setA].filter(t => setB.has(t));
  const smaller = Math.min(setA.size, setB.size);
  const larger  = Math.max(setA.size, setB.size);

  // Conflicting tokens (both have a token the other's position excludes) —
  // e.g. "john a smith" vs "john b smith": shared john+smith, but a≠b.
  const conflict = detectTokenConflict(ta, tb, shared);

  if (shared.length === smaller && smaller > 0) {
    // Full subset. Strong, but longer extra tokens dilute + conflicts kill it.
    const base = 0.78 + 0.12 * (smaller / larger);
    return { score: conflict ? Math.min(base, 0.58) : Math.min(base, 0.95), reason: conflict ? 'subset-with-conflict' : 'token-subset' };
  }

  // Jaccard for partial overlap.
  const union = new Set([...setA, ...setB]).size;
  const jaccard = shared.length / union;
  const score = conflict ? jaccard * 0.6 : jaccard;
  return { score, reason: conflict ? 'partial-overlap-conflict' : 'token-overlap' };
}

/** Two mentions sharing a surname but differing on a middle token → conflict. */
function detectTokenConflict(ta, tb, shared) {
  if (ta.length >= 3 && tb.length >= 3 && ta[0] === tb[0] && ta[ta.length - 1] === tb[tb.length - 1]) {
    const midA = ta.slice(1, -1), midB = tb.slice(1, -1);
    if (midA.length && midB.length && !midA.some(m => midB.includes(m))) return true;
  }
  // Different embedded numbers (v2 vs v3, John1 vs John2).
  const numA = ta.join(' ').match(/\d+/g) ?? [], numB = tb.join(' ').match(/\d+/g) ?? [];
  if (numA.length && numB.length && !numA.some(n => numB.includes(n))) return true;
  return false;
}

/**
 * Resolve a flat list of typed mentions into canonical entities.
 *
 * @param {Array<{ value, type, fileId, fileName, factId?, evidenceId? }>} mentions
 * @returns {{ entities: Array, ambiguous: Array }}
 *   entities:  [{ id, canonical, type, aliases, mentions, files:Set, confidence }]
 *   ambiguous: [{ a, b, score, reason }]  (REVIEW ≤ score < MERGE — never merged)
 */
export function resolveEntities(mentions) {
  // Block by type, then union-find within each type block.
  const byType = new Map();
  for (const m of mentions) {
    const type = m.type ?? 'name';
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push({ ...m, norm: normalizeMention(m.value) });
  }

  const entities = [];
  const ambiguous = [];

  for (const [type, list] of byType) {
    // Group identical normalized forms first (cheap, certain).
    const groups = new Map(); // norm → members[]
    for (const m of list) {
      if (!groups.has(m.norm)) groups.set(m.norm, []);
      groups.get(m.norm).push(m);
    }
    const clusters = [...groups.entries()].map(([norm, members]) => ({
      reps: [norm], members, mergeConfidence: 1,
    }));

    // Agglomerate clusters whose representatives are similar enough.
    let merged = true;
    while (merged) {
      merged = false;
      outer:
      for (let i = 0; i < clusters.length; i++) {
        for (let j = i + 1; j < clusters.length; j++) {
          const best = bestPairScore(clusters[i].reps, clusters[j].reps);
          if (HARD_TYPE_BLOCK.has(type) && best.score < MERGE_THRESHOLD && best.score >= REVIEW_THRESHOLD) {
            ambiguous.push({ a: clusters[i].reps[0], b: clusters[j].reps[0], type, score: round(best.score), reason: best.reason });
          }
          if (best.score >= MERGE_THRESHOLD) {
            clusters[i].reps = [...new Set([...clusters[i].reps, ...clusters[j].reps])];
            clusters[i].members.push(...clusters[j].members);
            clusters[i].mergeConfidence = Math.min(clusters[i].mergeConfidence, best.score);
            clusters.splice(j, 1);
            merged = true;
            break outer;
          }
        }
      }
    }

    for (const c of clusters) {
      const canonical = pickCanonical(c.members);
      const files = new Set(c.members.map(m => m.fileId));
      entities.push({
        id: `ent:${type}:${normalizeMention(canonical).replace(/\s+/g, '_')}`,
        canonical, type,
        aliases: [...new Set(c.members.map(m => m.value))].filter(v => v !== canonical),
        mentions: c.members.map(m => ({ value: m.value, fileId: m.fileId, fileName: m.fileName, factId: m.factId ?? null, evidenceId: m.evidenceId ?? null })),
        files,
        confidence: round(c.members.length > 1 || c.reps.length > 1 ? c.mergeConfidence : 1),
      });
    }
  }

  // De-dup ambiguous pairs.
  const seen = new Set();
  const ambDedup = ambiguous.filter(p => {
    const k = [p.a, p.b].sort().join('|');
    if (seen.has(k)) return false; seen.add(k); return true;
  });

  return { entities, ambiguous: ambDedup };
}

function bestPairScore(repsA, repsB) {
  let best = { score: 0, reason: 'none' };
  for (const a of repsA) for (const b of repsB) {
    const s = mentionSimilarity(a, b);
    if (s.score > best.score) best = s;
  }
  return best;
}

/** Prefer the longest, most-complete surface form as the display name. */
function pickCanonical(members) {
  const counts = new Map();
  for (const m of members) counts.set(m.value, (counts.get(m.value) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[0].length - a[0].length || b[1] - a[1])[0][0];
}

const round = (n) => Math.round(n * 100) / 100;

export const _thresholds = { MERGE_THRESHOLD, REVIEW_THRESHOLD };
