/**
 * AQUA Brain — E9 / PR-6 semantic duplicate consolidation planner.
 *
 * This planner never writes. It accepts a caller-supplied semantic-equivalence
 * oracle (typically an embedding/rerank result that already cleared its eval
 * gate) and emits a reversible merge plan. No similarity threshold is invented
 * here because an unmeasured threshold would violate L14/L16.
 */

const SOURCE_RANK = Object.freeze({ explicit: 4, file: 3, chat: 2, inferred: 1 });
const rank = claim => SOURCE_RANK[claim?.sourceTier ?? claim?.source] ?? 0;
const norm = v => String(v ?? '').trim().toLowerCase();

function comparable(a, b) {
  return norm(a?.subject ?? a?.subjectEntityId) === norm(b?.subject ?? b?.subjectEntityId)
    && norm(a?.predicate) === norm(b?.predicate)
    && norm(a?.polarity ?? 'asserted') === norm(b?.polarity ?? 'asserted')
    && norm(a?.modality ?? 'fact') === norm(b?.modality ?? 'fact');
}

function evidenceCount(claim) {
  return Array.isArray(claim?.evidence) ? claim.evidence.length : Number(claim?.evidenceCount) || 0;
}

function survivor(a, b) {
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra > rb ? a : b;
  const ea = evidenceCount(a), eb = evidenceCount(b);
  if (ea !== eb) return ea >= eb ? a : b;
  return String(a?.claimId ?? a?.id ?? '').localeCompare(String(b?.claimId ?? b?.id ?? '')) <= 0 ? a : b;
}

export async function consolidateSemanticDuplicates({ ownerId, incoming = [], existing = [], semanticEquivalent } = {}) {
  if (!ownerId) return { ownerId: null, survivors: [], merges: [], skipped: 0 };
  if (typeof semanticEquivalent !== 'function') {
    return { ownerId, survivors: [...existing, ...incoming], merges: [], skipped: incoming.length };
  }

  const allExisting = existing.filter(Boolean).map(c => ({ ...c }));
  const survivors = [...allExisting];
  const merges = [];
  let skipped = 0;

  for (const candidate of Array.isArray(incoming) ? incoming : []) {
    if (!candidate) continue;
    if (candidate.ownerId != null && candidate.ownerId !== ownerId) throw new Error('semantic consolidation cannot mix owners');

    let merged = false;
    for (let i = 0; i < survivors.length; i += 1) {
      const incumbent = survivors[i];
      if (incumbent.ownerId != null && incumbent.ownerId !== ownerId) throw new Error('semantic consolidation cannot mix owners');
      if (!comparable(incumbent, candidate)) continue;

      const decision = await semanticEquivalent(candidate, incumbent);
      const equivalent = typeof decision === 'boolean' ? decision : decision?.equivalent === true;
      if (!equivalent) continue;

      const keep = survivor(incumbent, candidate);
      const discard = keep === incumbent ? candidate : incumbent;
      const combinedEvidence = [
        ...(Array.isArray(incumbent.evidence) ? incumbent.evidence : []),
        ...(Array.isArray(candidate.evidence) ? candidate.evidence : []),
      ];
      survivors[i] = { ...keep, evidence: combinedEvidence };
      merges.push({
        ownerId,
        survivorId: keep.claimId ?? keep.id ?? null,
        absorbedId: discard.claimId ?? discard.id ?? null,
        evidenceAdded: combinedEvidence.length - evidenceCount(keep),
        reason: 'semantic-equivalence oracle accepted duplicate consolidation',
      });
      merged = true;
      break;
    }
    if (!merged) survivors.push(candidate), skipped += 1;
  }

  return { ownerId, survivors, merges, skipped };
}
