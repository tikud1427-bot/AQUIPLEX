/**
 * AQUA Brain — Retrieval V3 fusion + rerank primitives (E7).
 *
 * V3 deliberately separates two jobs that were previously conflated:
 *   1. lane fusion: independent retrieval lanes vote by rank (RRF), so a
 *      candidate supported by several weak signals can outrank a candidate
 *      that won one lane by accident;
 *   2. final rerank: the existing Context Engine scorer remains the semantic
 *      quality function, while the fused lane score is a bounded tie-breaker.
 *
 * Pure. No I/O, no embeddings, no model calls. This makes the fusion contract
 * testable before the live canonical-claim dense lane is wired.
 */

export const RRF_DEFAULT_K = 60;
export const RRF_DEFAULT_WEIGHT = 0.12;

/**
 * Reciprocal Rank Fusion.
 *
 * @param {Array<Array<{id:string, score?:number, candidate?:object}>>} lanes
 * @param {{k?:number, limit?:number}} opts
 * @returns {Array<{id:string, rrf:number, laneCount:number, ranks:object, candidate?:object}>}
 */
export function reciprocalRankFusion(lanes = [], { k = RRF_DEFAULT_K, limit = Infinity } = {}) {
  const kk = Number.isFinite(k) && k > 0 ? k : RRF_DEFAULT_K;
  const votes = new Map();

  for (let laneIndex = 0; laneIndex < lanes.length; laneIndex++) {
    const lane = Array.isArray(lanes[laneIndex]) ? lanes[laneIndex] : [];
    const seen = new Set();
    for (let i = 0; i < lane.length; i++) {
      const row = lane[i];
      if (!row?.id || seen.has(row.id)) continue;
      seen.add(row.id);
      const rank = i + 1;
      let v = votes.get(row.id);
      if (!v) {
        v = { id: row.id, rrf: 0, laneCount: 0, ranks: {}, candidate: row.candidate };
        votes.set(row.id, v);
      }
      v.rrf += 1 / (kk + rank);
      v.laneCount += 1;
      v.ranks[laneIndex] = rank;
      if (!v.candidate && row.candidate) v.candidate = row.candidate;
    }
  }

  return [...votes.values()]
    .sort((a, b) => b.rrf - a.rrf || b.laneCount - a.laneCount || String(a.id).localeCompare(String(b.id)))
    .slice(0, Math.max(0, limit));
}

/**
 * Attach fused rank evidence to candidates and produce a deterministic final
 * ordering. The candidate's existing Context Engine score remains dominant;
 * RRF only breaks close scores, which prevents a second ranking system from
 * silently overriding the ten-dimensional relevance model.
 */
export function rerankWithFusion(candidates = [], fused = [], { tieEpsilon = 0.04, fusionWeight = RRF_DEFAULT_WEIGHT } = {}) {
  const byId = new Map(fused.map(x => [String(x.id), x]));
  const weight = Number.isFinite(fusionWeight) ? Math.max(0, Math.min(0.5, fusionWeight)) : RRF_DEFAULT_WEIGHT;
  const epsilon = Number.isFinite(tieEpsilon) ? Math.max(0, tieEpsilon) : 0.04;

  const maxRrf = fused.reduce((m, x) => Math.max(m, x.rrf), 0) || 1;
  return candidates.map((c, index) => {
    const f = byId.get(String(c.id));
    const normalizedRrf = f ? f.rrf / maxRrf : 0;
    const fusedScore = (c.score ?? 0) + weight * normalizedRrf;
    return {
      ...c,
      rrfScore: f ? f.rrf : 0,
      fusedLaneCount: f?.laneCount ?? 0,
      fusedScore,
      _fusionRank: f ? fused.findIndex(x => x.id === f.id) : Number.MAX_SAFE_INTEGER,
      _stableIndex: index,
      _tieEpsilon: epsilon,
    };
  }).sort((a, b) => {
    const delta = (b.score ?? 0) - (a.score ?? 0);
    if (Math.abs(delta) > epsilon) return delta;
    return b.fusedScore - a.fusedScore || b.fusedLaneCount - a.fusedLaneCount || a._fusionRank - b._fusionRank || a._stableIndex - b._stableIndex;
  });
}

/** Group candidates into the independent retrieval lanes V3 can fuse. */
export function lanesFromCandidates(candidates = []) {
  const groups = new Map();
  for (const c of candidates) {
    const lanes = Array.isArray(c.lanes) && c.lanes.length ? c.lanes : [laneOf(c)];
    for (const lane of lanes) {
      if (!groups.has(lane)) groups.set(lane, []);
      groups.get(lane).push({ id: c.id, score: c.score ?? 0, candidate: c });
    }
  }
  for (const rows of groups.values()) rows.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
  return [...groups.entries()].map(([name, rows]) => ({ name, rows }));
}

function laneOf(c) {
  const via = String(c?.via ?? '').toLowerCase();
  if (via.startsWith('dense')) return 'dense';
  if (via.startsWith('graph')) return 'graph';
  if (via.startsWith('polarity')) return 'structured';
  if (via.startsWith('lexical')) return 'lexical';
  if (c?.kind === 'entity') return 'entity';
  if (c?.kind === 'event') return 'timeline';
  return 'unknown';
}
