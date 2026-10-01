/**
 * AQUA Brain — E9 / PR-5 constrained pattern inference.
 *
 * Repetition is not truth. This module therefore returns INFERENCE PROPOSALS,
 * never silently promoted facts. Inferred claims are skipped as inputs so the
 * reflection loop can never self-corroborate its own output.
 */

const DEFAULT_MIN_EPISODES = 3;
const DEFAULT_MIN_SOURCES = 2;
const INFERRED_CEILING = 0.45;

const norm = v => String(v ?? '').trim().toLowerCase();

function objectKey(claim) {
  const object = claim?.object ?? {};
  for (const key of ['entity', 'literal', 'quantity', 'time']) {
    if (object[key] != null) return `${key}:${norm(object[key])}`;
  }
  return `value:${norm(claim?.objectValue ?? claim?.value)}`;
}

function signature(claim) {
  return [
    norm(claim?.subject ?? claim?.subjectEntityId),
    norm(claim?.predicate),
    objectKey(claim),
    norm(claim?.polarity ?? 'asserted'),
  ].join('\u0000');
}

function sourceId(claim) {
  return norm(claim?.sourceId ?? claim?.source ?? claim?.evidence?.[0]?.sourceId);
}

function episodeId(claim) {
  return norm(claim?.episodeId ?? claim?.conversationId ?? claim?.evidence?.[0]?.episodeId);
}

function hasCounterEvidence(candidateClaims, candidate) {
  const subject = norm(candidate?.subject ?? candidate?.subjectEntityId);
  const predicate = norm(candidate?.predicate);
  if (!subject || !predicate) return false;
  const polarity = norm(candidate?.polarity ?? 'asserted');
  const object = objectKey(candidate);
  return candidateClaims.some(other => {
    if (!other || other === candidate) return false;
    if (norm(other.subject ?? other.subjectEntityId) !== subject) return false;
    if (norm(other.predicate) !== predicate) return false;
    const otherPolarity = norm(other.polarity ?? 'asserted');
    if (otherPolarity !== polarity && objectKey(other) === object) return true;
    return false;
  });
}

export function inferPatterns({ ownerId, claims = [], minEpisodes = DEFAULT_MIN_EPISODES, minSources = DEFAULT_MIN_SOURCES } = {}) {
  if (!ownerId || !Array.isArray(claims)) return [];
  const groups = new Map();
  for (const claim of claims) {
    if (!claim) continue;
    if (claim.ownerId != null && claim.ownerId !== ownerId) throw new Error('pattern inference cannot mix owners');
    // Existing inferred proposals are inputs, not corroboration. Reusing a
    // derived claim to prove itself creates the prohibited self-corroboration loop.
    if (String(claim.modality ?? '').toLowerCase() === 'inferred') continue;
    if (String(claim.source ?? claim.sourceTier ?? claim.sourceKind ?? '').toLowerCase().includes('inference')) continue;
    if (String(claim.sourceKind ?? '').toLowerCase() === 'reflection') continue;
    const key = signature(claim);
    const group = groups.get(key) ?? [];
    group.push(claim);
    groups.set(key, group);
  }

  const proposals = [];
  for (const group of groups.values()) {
    const episodes = new Set(group.map(episodeId).filter(Boolean));
    const sources = new Set(group.map(sourceId).filter(Boolean));
    if (episodes.size < Math.max(1, Number(minEpisodes) || DEFAULT_MIN_EPISODES)) continue;
    if (sources.size < Math.max(1, Number(minSources) || DEFAULT_MIN_SOURCES)) continue;
    if (hasCounterEvidence(claims, group[0])) continue;

    const representative = [...group].sort((a, b) => String(a.claimId ?? a.id ?? '').localeCompare(String(b.claimId ?? b.id ?? '')))[0];
    proposals.push({
      ownerId,
      subject: representative.subject ?? null,
      subjectEntityId: representative.subjectEntityId ?? null,
      predicate: representative.predicate ?? null,
      object: representative.object ?? null,
      statementText: representative.statementText ?? representative.statement ?? null,
      polarity: representative.polarity ?? 'asserted',
      confidenceCeiling: INFERRED_CEILING,
      proposedModality: 'inferred',
      extractor: 'reflectionV3.patternInference@1',
      corroboratingEpisodes: [...episodes].slice(0, 8),
      corroboratingSources: [...sources].slice(0, 8),
      evidenceClaimIds: group.map(c => c.claimId ?? c.id).filter(Boolean).slice(0, 32),
    });
  }

  return proposals;
}
