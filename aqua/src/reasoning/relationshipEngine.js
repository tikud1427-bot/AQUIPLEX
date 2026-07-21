/**
 * AQUA Relationship + Contradiction Engines — Cross-File Reasoning (Phase 3)
 *
 * RELATIONSHIP BUILDER — infers typed relationships between resolved
 * entities from co-occurrence in grounded facts. If a fact mentions both a
 * person and an org, that's evidence of a Person↔Organization relationship;
 * the relationship's confidence grows with the number of independent files
 * that co-mention them, and it always carries the supporting facts +
 * evidence + source files. The engine NEVER invents a relationship: no
 * co-occurrence, no edge. Relationship kind is 'derived' (an inference from
 * observed facts), never 'observed' — the epistemic tiers stay separate.
 *
 * CONTRADICTION DETECTOR (cross-file) — the Phase-2 validator found
 * conflicts within one owner's facts; this operates across FILES on
 * RESOLVED entities: same canonical entity, contradictory numbers / dates /
 * negation across different source files. It SURFACES both sides with their
 * evidence and does NOT resolve them (explicit non-goal). Each contradiction
 * records the two facts, their files, and why they conflict.
 *
 * Both pure. They consume resolved entities (entityResolver) + grounded
 * facts (evidenceStore) and emit graph-ready records.
 */

// ── Relationship inference ────────────────────────────────────────────────────

const REL_BY_TYPES = {
  'person|org':       'affiliated_with',
  'person|person':    'associated_with',
  'person|project':   'works_on',
  'org|project':      'owns',
  'org|org':          'related_to',
  'person|place':     'located_in',
  'org|place':        'located_in',
};

/**
 * @param {Array} entities - resolved entities (entityResolver output)
 * @param {Array} facts    - grounded facts
 * @param {object} store   - evidenceStore (evidence hydration)
 * @param {string} ownerId
 * @returns {Array} relationships [{ id, from, to, type, kind:'derived', confidence, supportingFacts:[id], evidence:[id], sourceFiles:[ukoId], reason }]
 */
export function buildRelationships(entities, facts, store, ownerId) {
  // Map every alias/canonical → entity id, for fast fact→entity linking.
  const nameToEntity = new Map();
  for (const e of entities) {
    for (const name of [e.canonical, ...e.aliases]) nameToEntity.set(String(name).toLowerCase(), e);
  }

  // For each fact, which resolved entities does it mention?
  const pairCounts = new Map(); // "idA|idB" → { files:Set, facts:Set, evidence:Set }
  for (const fact of facts) {
    const hit = new Set();
    for (const raw of fact.entities ?? []) {
      const e = nameToEntity.get(String(raw).toLowerCase());
      if (e) hit.add(e);
    }
    const list = [...hit];
    if (list.length < 2) continue;
    const evidence = store.evidenceForFact(ownerId, fact.id);
    const files = new Set(evidence.map(ev => ev.sourceFileId));
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [a, b] = [list[i], list[j]].sort((x, y) => x.id.localeCompare(y.id));
        const key = `${a.id}|${b.id}`;
        const bucket = pairCounts.get(key) ?? { a, b, files: new Set(), facts: new Set(), evidence: new Set() };
        for (const f of files) bucket.files.add(f);
        bucket.facts.add(fact.id);
        for (const ev of evidence) bucket.evidence.add(ev.id);
        pairCounts.set(key, bucket);
      }
    }
  }

  const relationships = [];
  for (const { a, b, files, facts: fset, evidence } of pairCounts.values()) {
    const type = REL_BY_TYPES[[a.type, b.type].sort().join('|')] ?? 'related_to';
    // Confidence: more independent files co-mentioning → stronger, capped.
    const confidence = round(Math.min(0.95, 0.5 + 0.15 * (files.size - 1) + 0.05 * (fset.size - 1)));
    relationships.push({
      id: `rel:${a.id}|${b.id}`,
      from: a.id, to: b.id, type, kind: 'derived',
      confidence,
      supportingFacts: [...fset],
      evidence: [...evidence],
      sourceFiles: [...files],
      reason: `co-mentioned in ${fset.size} fact(s) across ${files.size} file(s)`,
    });
  }
  return relationships;
}

// ── Cross-file contradiction detection ───────────────────────────────────────

/**
 * @returns {Array} contradictions [{ id, entity, type:'numeric'|'negation'|'date', factIds:[a,b], statements:[a,b], sourceFiles:[[..],[..]], evidence:[[..],[..]], reason }]
 */
export function detectCrossFileContradictions(entities, facts, store, ownerId) {
  const nameToEntity = new Map();
  for (const e of entities) for (const name of [e.canonical, ...e.aliases]) nameToEntity.set(String(name).toLowerCase(), e);

  // Group facts by resolved entity.
  const byEntity = new Map(); // entityId → facts[]
  for (const fact of facts) {
    for (const raw of fact.entities ?? []) {
      const e = nameToEntity.get(String(raw).toLowerCase());
      if (!e) continue;
      if (!byEntity.has(e.id)) byEntity.set(e.id, []);
      byEntity.get(e.id).push(fact);
    }
  }

  const contradictions = [];
  const seen = new Set();
  for (const [entId, group] of byEntity) {
    const entity = entities.find(e => e.id === entId);
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const fa = group[i], fb = group[j];
        const evA = store.evidenceForFact(ownerId, fa.id);
        const evB = store.evidenceForFact(ownerId, fb.id);
        const filesA = new Set(evA.map(e => e.sourceFileId));
        const filesB = new Set(evB.map(e => e.sourceFileId));
        // Cross-FILE only: the two facts must come from different files.
        const crossFile = [...filesA].some(f => ![...filesB].includes(f)) || [...filesB].some(f => ![...filesA].includes(f));
        if (!crossFile) continue;

        const kind = conflictKind(fa.statement, fb.statement);
        if (!kind) continue;
        const key = [fa.id, fb.id].sort().join('|');
        if (seen.has(key)) continue; seen.add(key);

        contradictions.push({
          id: `contra:${key}`,
          entity: entity?.canonical ?? entId,
          type: kind,
          factIds: [fa.id, fb.id],
          statements: [fa.statement, fb.statement],
          sourceFiles: [[...filesA], [...filesB]],
          evidence: [fa.evidence, fb.evidence],
          reason: `${kind} disagreement about "${entity?.canonical ?? entId}" across different files`,
        });
      }
    }
  }
  return contradictions;
}

function conflictKind(a, b) {
  const numA = numbers(a), numB = numbers(b);
  // FI-2: SIGNIFICANT figures compared separately — two statements sharing a
  // date ("… on 2026-01-05") but disagreeing on the amount (4000000 vs
  // 9000000) are a numeric conflict; the shared date components must not
  // mask it. Significant = ≥4 digits and not year-shaped. Requires stronger
  // textual overlap (≥4 shared words) than the fallback, to stay conservative.
  const sigA = significant(numA), sigB = significant(numB);
  if (sigA.length && sigB.length && !sigA.some(n => sigB.includes(n)) && !sigB.some(n => sigA.includes(n)) && overlap(a, b) >= 4) {
    return 'numeric';
  }
  if (numA.length && numB.length && !numA.some(n => numB.includes(n)) && overlap(a, b) >= 3) {
    // Distinguish date-shaped conflicts from plain numeric.
    if (/\b(19|20)\d{2}\b/.test(a) && /\b(19|20)\d{2}\b/.test(b)) return 'date';
    return 'numeric';
  }
  const negA = NEG.test(a), negB = NEG.test(b);
  if (negA !== negB && overlap(a, b) >= 4) return 'negation';
  return null;
}

const NEG = /\b(not|no|never|isn't|aren't|won't|cannot|can't|failed|rejected|denied)\b/i;
function numbers(s) { return [...String(s).matchAll(/\d[\d,]*(?:\.\d+)?/g)].map(m => m[0].replace(/,/g, '')); }
function significant(ns) { return ns.filter(n => n.length >= 4 && !/^(19|20)\d\d$/.test(n)); }
function overlap(a, b) {
  const wa = new Set(String(a).toLowerCase().match(/[a-z]{3,}/g) ?? []);
  const wb = new Set(String(b).toLowerCase().match(/[a-z]{3,}/g) ?? []);
  let n = 0; for (const w of wa) if (wb.has(w)) n++;
  return n;
}
const round = (n) => Math.round(n * 100) / 100;
