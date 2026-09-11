/**
 * AQUA Research Intelligence — File Intelligence 2.0
 *
 * Deterministic literature-analysis primitives over the EXISTING knowledge
 * space: grounded facts (evidenceStore, source of truth), UKOs (ukoStore),
 * and the derived reasoning graph. Pure over injected deps; no model; every
 * item cited; observed vs derived kept separate (the reasoning contract).
 *
 *   compareFiles(a, b)     paper-vs-paper: shared entities, agreements
 *                          (same normalized claim in both), disagreements
 *                          (cross-file contradiction pairs touching both),
 *                          unique claims per side
 *   consensusReport()      claims corroborated by ≥2 independent files vs
 *                          contested (on a `contradicts` edge) vs
 *                          single-source — the consensus / conflict /
 *                          coverage picture of the corpus
 *   hypothesisCandidates() finding-verb statements split into asserted
 *                          findings vs hedged hypotheses (may/might/
 *                          suggests …) — what the corpus claims vs floats
 *   researchGaps()         under-evidenced ground: entities mentioned but
 *                          never explained (`about`-degree 0), single-file
 *                          entities, files that yielded zero claims,
 *                          contested claims still open, timeline anchoring
 *                          ratio
 *   literatureOverview()   one row per file: topics, key entities, claim
 *                          count, agreement/conflict footprint
 *
 * Reuses relationshipEngine's cross-file contradiction detector and the
 * entityResolver output already materialized in the graph — nothing here
 * re-derives what a sibling module owns.
 */
import * as G from './reasoningGraph.js';
import { detectCrossFileContradictions } from './relationshipEngine.js';
import { formatCitation } from '../files/evidence.js';

const HEDGE = /\b(may|might|could|appears?( to)?|possibly|potentially|likely|hypothes\w*|we (speculate|propose|conjecture))\b/i;
const FINDING = /\b(suggests?|indicates?|shows?|demonstrates?|reveals?|concludes?|confirms?|improv(?:es|ed)|reduc(?:es|ed)|increas(?:es|ed)|decreas(?:es|ed)|we (found|observed|show)|results (show|indicate)|evidence (shows|suggests))\b/i;
const round = (n) => Math.round(n * 100) / 100;

function cite(ES, ownerId, fact) {
  return ES.evidenceForFact(ownerId, fact.id).map(formatCitation);
}
function filesOfFact(ES, ownerId, fact) {
  return [...new Set(ES.evidenceForFact(ownerId, fact.id).map(e => e.sourceFileId))];
}
function resolvedEntities(ownerId) {
  return G.nodesByType(ownerId, 'entity').map(n => ({
    id: n.id, canonical: n.label, type: n.data?.entityType,
    aliases: n.data?.aliases ?? [], fileCount: n.data?.fileCount ?? (n.sourceFiles?.length ?? 0),
    files: n.sourceFiles ?? [],
  }));
}

/** Paper-vs-paper comparison. ukoIdA/ukoIdB are UKO ids. */
export function compareFiles(deps, ownerId, ukoIdA, ukoIdB) {
  const { evidenceStore: ES, ukoStore: US } = deps;
  const A = US.getUKO(ownerId, ukoIdA), B = US.getUKO(ownerId, ukoIdB);
  if (!A || !B) return null;

  const factsA = ES.factsForFile(ownerId, ukoIdA);
  const factsB = ES.factsForFile(ownerId, ukoIdB);

  // Shared entities — via the graph's mentions edges (resolved, alias-aware).
  const entIdsA = new Set(G.neighbors(ownerId, `file:${ukoIdA}`, { type: 'entity', edgeType: 'mentions' }).map(x => x.node.id));
  const shared = G.neighbors(ownerId, `file:${ukoIdB}`, { type: 'entity', edgeType: 'mentions' })
    .filter(x => entIdsA.has(x.node.id))
    .map(({ node }) => ({ entity: node.label, type: node.data?.entityType, aliases: node.data?.aliases ?? [] }));

  // Agreements — identical normalized claims present in both files.
  const normB = new Map(factsB.map(f => [f.normalizedRepresentation, f]));
  const agreements = [];
  for (const fa of factsA) {
    const fb = normB.get(fa.normalizedRepresentation);
    if (!fb) continue;
    agreements.push({
      statement: fa.statement, confidence: round(Math.max(fa.confidence, fb.confidence)),
      citations: { [A.sourceFile.name]: cite(ES, ownerId, fa), [B.sourceFile.name]: cite(ES, ownerId, fb) },
      kind: 'observed',
    });
  }

  // Disagreements — cross-file contradictions touching exactly this pair.
  const entities = resolvedEntities(ownerId).map(e => ({ ...e, canonical: e.canonical, aliases: e.aliases, id: e.id }));
  const allFacts = ES.listFacts(ownerId, { limit: 100000 });
  const contra = detectCrossFileContradictions(entities, allFacts, ES, ownerId).filter(c => {
    const fs = new Set([...c.sourceFiles[0], ...c.sourceFiles[1]]);
    return fs.has(ukoIdA) && fs.has(ukoIdB);
  }).map(c => ({
    entity: c.entity, conflictType: c.type, statements: c.statements,
    citations: c.factIds.map(id => cite(ES, ownerId, ES.getFact(ownerId, id))),
    kind: 'derived',
  }));

  const agreedNorm = new Set(agreements.map(a => a.statement));
  const unique = (facts, name) => facts
    .filter(f => !agreedNorm.has(f.statement))
    .slice(0, 8)
    .map(f => ({ statement: f.statement, confidence: round(f.confidence), citations: cite(ES, ownerId, f), kind: 'observed', onlyIn: name }));

  return {
    files: { a: A.sourceFile.name, b: B.sourceFile.name },
    sharedEntities: shared,
    agreements, disagreements: contra,
    uniqueToA: unique(factsA, A.sourceFile.name),
    uniqueToB: unique(factsB, B.sourceFile.name),
  };
}

/** Corpus-level consensus / contested / single-source claim map. */
export function consensusReport(deps, ownerId, { limit = 15 } = {}) {
  const { evidenceStore: ES } = deps;
  const facts = ES.listFacts(ownerId, { limit: 100000 });

  const contestedIds = new Set();
  for (const fn of G.nodesByType(ownerId, 'fact')) {
    for (const e of G.edgesOf(ownerId, fn.id, { type: 'contradicts' })) {
      contestedIds.add(e.from.replace(/^fact:/, '')); contestedIds.add(e.to.replace(/^fact:/, ''));
    }
  }

  const groups = new Map(); // normalized statement → { facts, files:Set }
  for (const f of facts) {
    const key = f.normalizedRepresentation ?? f.statement;
    if (!groups.has(key)) groups.set(key, { facts: [], files: new Set() });
    const g = groups.get(key);
    g.facts.push(f);
    for (const fid of filesOfFact(ES, ownerId, f)) g.files.add(fid);
  }

  const consensus = [], contested = [], singleSource = [];
  for (const g of groups.values()) {
    const best = g.facts.reduce((a, b) => (b.confidence > a.confidence ? b : a));
    const row = {
      statement: best.statement,
      files: g.files.size,
      confidence: round(Math.min(0.98, best.confidence + 0.05 * (g.files.size - 1))), // corroboration boost, read-only mirror of consolidation's shape
      citations: g.facts.flatMap(f => cite(ES, ownerId, f)).slice(0, 6),
    };
    if (g.facts.some(f => contestedIds.has(f.id))) contested.push({ ...row, kind: 'derived' });
    else if (g.files.size >= 2) consensus.push({ ...row, kind: 'observed' });
    else singleSource.push({ ...row, kind: 'observed' });
  }
  const byStrength = (a, b) => b.files - a.files || b.confidence - a.confidence;
  return {
    consensus: consensus.sort(byStrength).slice(0, limit),
    contested: contested.sort(byStrength).slice(0, limit),
    singleSource: singleSource.sort(byStrength).slice(0, limit),
    totals: { claims: groups.size, consensus: consensus.length, contested: contested.length, singleSource: singleSource.length },
  };
}

/** Findings vs hedged hypotheses across the corpus. */
export function hypothesisCandidates(deps, ownerId, { limit = 12 } = {}) {
  const { evidenceStore: ES } = deps;
  const facts = ES.listFacts(ownerId, { limit: 100000 });
  const findings = [], hypotheses = [];
  for (const f of facts) {
    if (!FINDING.test(f.statement) && !HEDGE.test(f.statement)) continue;
    const row = { statement: f.statement, confidence: round(f.confidence), citations: cite(ES, ownerId, f), kind: 'observed' };
    if (HEDGE.test(f.statement)) hypotheses.push({ ...row, hedged: true });
    else findings.push(row);
  }
  return {
    findings: findings.slice(0, limit),
    hypotheses: hypotheses.slice(0, limit),
    note: 'findings = asserted result statements; hypotheses = hedged (may/might/suggests) — the corpus claims the first and floats the second',
  };
}

/** Where the corpus is thin: unexplained entities, unmined files, open disputes. */
export function researchGaps(deps, ownerId, { limit = 10 } = {}) {
  const { evidenceStore: ES, ukoStore: US, queryEngine: QE } = deps;
  const ents = resolvedEntities(ownerId);

  const unexplained = [], singleFile = [];
  for (const e of ents) {
    const aboutDeg = G.neighbors(ownerId, e.id, { type: 'fact', edgeType: 'about' }).length;
    if (aboutDeg === 0) unexplained.push({ entity: e.canonical, type: e.type, files: e.fileCount });
    else if (e.fileCount === 1) singleFile.push({ entity: e.canonical, type: e.type });
  }

  const ukos = US.listUKOs(ownerId, { limit: 100000 });
  const unmined = ukos.filter(u => ES.factsForFile(ownerId, u.id).length === 0)
    .map(u => ({ file: u.sourceFile.name, fileType: u.fileType }));

  const contested = QE.contradictionsFor(ES, ownerId).slice(0, limit)
    .map(c => ({ reason: c.reason, sideA: c.sideA.statement, sideB: c.sideB.statement, kind: 'derived' }));

  const tl = QE.timelineAcross(ES, ownerId);
  return {
    unexplainedEntities: unexplained.slice(0, limit),
    singleSourceEntities: singleFile.slice(0, limit),
    unminedFiles: unmined.slice(0, limit),
    openDisputes: contested,
    timelineAnchoring: { anchored: tl.anchored, unanchored: tl.unanchored,
      ratio: tl.anchored + tl.unanchored ? round(tl.anchored / (tl.anchored + tl.unanchored)) : null },
    kind: 'derived',
  };
}

/** One row per file — the literature-review table. */
export function literatureOverview(deps, ownerId, { limit = 25 } = {}) {
  const { evidenceStore: ES, ukoStore: US } = deps;
  const ukos = US.listUKOs(ownerId, { limit: 100000 }).slice(0, limit);
  const contestedIds = new Set();
  for (const fn of G.nodesByType(ownerId, 'fact')) {
    for (const e of G.edgesOf(ownerId, fn.id, { type: 'contradicts' })) {
      contestedIds.add(e.from.replace(/^fact:/, '')); contestedIds.add(e.to.replace(/^fact:/, ''));
    }
  }
  return ukos.map(u => {
    const facts = ES.factsForFile(ownerId, u.id);
    const ents = G.neighbors(ownerId, `file:${u.id}`, { type: 'entity', edgeType: 'mentions' })
      .slice(0, 5).map(x => x.node.label);
    return {
      file: u.sourceFile.name, fileType: u.fileType,
      topics: (u.topics ?? []).slice(0, 4).map(t => t.topic),
      keyEntities: ents,
      claims: facts.length,
      contestedClaims: facts.filter(f => contestedIds.has(f.id)).length,
      meanClaimConfidence: facts.length ? round(facts.reduce((a, f) => a + f.confidence, 0) / facts.length) : null,
    };
  });
}
