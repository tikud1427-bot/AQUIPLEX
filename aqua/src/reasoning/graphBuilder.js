/**
 * AQUA Reasoning Graph Builder — Cross-File Reasoning (Phase 3)
 *
 * Orchestrates the modular components into the unified graph, incrementally.
 * This is the ONLY module that knows the others exist; each component
 * (entityResolver, timelineEngine, relationshipEngine) stays independent
 * and separately testable behind its interface, exactly as the brief
 * requires ("future improvements should not require architectural
 * rewrites").
 *
 * rebuildOwnerGraph(owner) — full construction from the owner's stored
 *   facts + evidence: collect mentions → resolve entities → upsert
 *   entity/fact/file/event nodes → add mentions/asserts/about/involves/
 *   related_to/contradicts edges (all provenance-bearing). Idempotent.
 *
 * The graph is derived state over the evidence store (the source of truth),
 * so "incremental" here means: re-deriving is cheap and safe, and
 * removeFileFromGraph() detaches one file without disturbing the rest.
 * Because entity resolution is global (a new file may merge with existing
 * entities), the correct incremental primitive is "re-resolve", which we
 * keep affordable by operating on the compact mention set, not raw text —
 * and we expose addFileToGraph() that re-runs resolution and merges deltas.
 *
 * Everything is grounded: no node without a source file, no edge without
 * provenance (enforced by reasoningGraph.addEdge).
 */
import * as G from './reasoningGraph.js';
import { resolveEntities } from './entityResolver.js';
import { extractEvents } from './timelineEngine.js';
import { buildRelationships, detectCrossFileContradictions } from './relationshipEngine.js';

/**
 * @param {object} deps - { evidenceStore, ukoStore } (injected for tests)
 * @param {string} ownerId
 * @returns {{ stats, entities, ambiguous, contradictions }}
 */
export function rebuildOwnerGraph(deps, ownerId) {
  const { evidenceStore, ukoStore } = deps;
  const facts = evidenceStore.listFacts(ownerId, { limit: 100000 });
  const ukos  = ukoStore.listUKOs(ownerId, { limit: 100000 });

  // 1. File name lookup.
  const fileName = new Map(ukos.map(u => [u.id, u.sourceFile.name]));

  // 2. Collect typed mentions from facts (entity value + which file/fact/evidence).
  const mentions = [];
  for (const fact of facts) {
    const evidence = evidenceStore.evidenceForFact(ownerId, fact.id);
    const fileId = evidence[0]?.sourceFileId ?? null;
    for (const raw of fact.entities ?? []) {
      mentions.push({
        value: raw, type: guessType(raw), fileId,
        fileName: fileName.get(fileId) ?? fileId, factId: fact.id,
        evidenceId: evidence[0]?.id ?? null,
      });
    }
  }

  // 3. Resolve entities across all files.
  const { entities, ambiguous } = resolveEntities(mentions);

  // 4. Nodes: files, entities, facts.
  for (const u of ukos) {
    G.upsertNode(ownerId, { id: `file:${u.id}`, type: 'file', label: u.sourceFile.name, data: { fileType: u.fileType }, sourceFiles: [u.id] }, { fileId: u.id });
  }
  const entityNodeByName = new Map();
  for (const e of entities) {
    G.upsertNode(ownerId, {
      id: e.id, type: 'entity', label: e.canonical,
      kind: 'derived',
      data: { entityType: e.type, aliases: e.aliases, resolutionConfidence: e.confidence, fileCount: e.files.size },
      sourceFiles: [...e.files],
    });
    for (const name of [e.canonical, ...e.aliases]) entityNodeByName.set(String(name).toLowerCase(), e.id);
    // mentions edge: file → entity (provenance = the files it appears in)
    for (const m of e.mentions) {
      if (!m.fileId) continue;
      G.addEdge(ownerId, {
        from: `file:${m.fileId}`, to: e.id, type: 'mentions',
        kind: 'observed', confidence: e.confidence,
        evidence: m.evidenceId ? [m.evidenceId] : [], sourceFiles: [m.fileId],
        reason: `"${m.value}" appears in ${m.fileName}`,
      }, { fileId: m.fileId });
    }
  }
  for (const fact of facts) {
    const evidence = evidenceStore.evidenceForFact(ownerId, fact.id);
    const fileId = evidence[0]?.sourceFileId ?? null;
    G.upsertNode(ownerId, { id: `fact:${fact.id}`, type: 'fact', label: fact.statement.slice(0, 120), kind: 'observed', data: { confidence: fact.confidence }, sourceFiles: fileId ? [fileId] : [] }, { fileId });
    if (fileId) {
      G.addEdge(ownerId, { from: `file:${fileId}`, to: `fact:${fact.id}`, type: 'asserts', kind: 'observed', confidence: fact.confidence, evidence: fact.evidence, sourceFiles: [fileId], reason: 'file asserts fact' }, { fileId });
    }
    // fact → entity (about)
    for (const raw of fact.entities ?? []) {
      const eid = entityNodeByName.get(String(raw).toLowerCase());
      if (eid) G.addEdge(ownerId, { from: `fact:${fact.id}`, to: eid, type: 'about', kind: 'observed', confidence: fact.confidence, evidence: fact.evidence, sourceFiles: fileId ? [fileId] : [], reason: 'fact about entity' }, { fileId });
    }
  }

  // 5. Events → nodes + involves/derived_from edges.
  const events = extractEvents(evidenceStore, ownerId, facts);
  for (const ev of events) {
    const fileId = ev.sourceFiles[0] ?? null;
    G.upsertNode(ownerId, { id: ev.id, type: 'event', label: `${ev.type}: ${ev.statement.slice(0, 80)}`, kind: 'derived', data: { eventType: ev.type, timestamp: ev.timestamp, certainty: ev.certainty }, sourceFiles: ev.sourceFiles }, { fileId });
    G.addEdge(ownerId, { from: ev.id, to: `fact:${ev.factId}`, type: 'derived_from', kind: 'derived', confidence: ev.confidence, evidence: ev.evidence, sourceFiles: ev.sourceFiles, reason: 'event derived from fact' }, { fileId });
    for (const raw of ev.entities) {
      const eid = entityNodeByName.get(String(raw).toLowerCase());
      if (eid) G.addEdge(ownerId, { from: ev.id, to: eid, type: 'involves', kind: 'derived', confidence: ev.confidence, evidence: ev.evidence, sourceFiles: ev.sourceFiles, reason: 'event involves entity' }, { fileId });
    }
  }

  // 6. Relationships (entity↔entity, derived).
  const relationships = buildRelationships(entities, facts, evidenceStore, ownerId);
  for (const rel of relationships) {
    G.addEdge(ownerId, { from: rel.from, to: rel.to, type: 'related_to', kind: 'derived', confidence: rel.confidence, evidence: rel.evidence, sourceFiles: rel.sourceFiles, reason: `${rel.type}: ${rel.reason}`, id: rel.id }, { fileId: rel.sourceFiles[0] ?? null });
  }

  // 7. Cross-file contradictions (fact↔fact, derived; surfaced not resolved).
  const contradictions = detectCrossFileContradictions(entities, facts, evidenceStore, ownerId);
  for (const c of contradictions) {
    G.addEdge(ownerId, {
      from: `fact:${c.factIds[0]}`, to: `fact:${c.factIds[1]}`, type: 'contradicts',
      kind: 'derived', confidence: 0.7,
      evidence: [...c.evidence[0], ...c.evidence[1]],
      sourceFiles: [...c.sourceFiles[0], ...c.sourceFiles[1]],
      reason: c.reason, id: c.id,
    }, { fileId: c.sourceFiles[0][0] ?? null });
  }

  return { stats: G.graphStats(ownerId), entities, ambiguous, contradictions, relationships, events };
}

/** Incremental add: a new file arrived → re-resolve + merge. Grounded, idempotent. */
export function addFileToGraph(deps, ownerId, _ukoId) {
  // Entity resolution is global, so the correct + simple primitive is a
  // re-derive (cheap: operates on the compact fact/mention set, not text).
  // Kept as a named seam so a future delta-merge optimization drops in here
  // without changing callers.
  return rebuildOwnerGraph(deps, ownerId);
}

export function removeFileFromGraph(ownerId, ukoId) {
  return G.removeFile(ownerId, ukoId);
}

function guessType(raw) {
  const s = String(raw);
  if (/@/.test(s)) return 'email';
  if (/^https?:\/\//.test(s)) return 'url';
  if (/^(₹|\$|€|£)/.test(s) || /\b(USD|INR|EUR|GBP)\b/.test(s)) return 'money';
  if (/\.\w{1,5}$/.test(s) && /\.(js|ts|py|pdf|docx?|pptx?|xlsx?|csv|png|jpe?g|mp4|mp3|zip)$/i.test(s)) return 'filename';
  if (/^v?\d+\.\d+/.test(s)) return 'version';
  if (/\b(19|20)\d{2}\b/.test(s) || /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(s)) return 'date';
  // Proper nouns (people AND organizations) resolve under one 'name' type.
  // Splitting them into person/org guesses fragments the same real-world
  // entity across files ("OpenAI" guessed person, "OpenAI Inc." guessed org
  // would never merge). The org/person distinction is genuinely hard from a
  // surface string and not worth breaking entity identity over; the entity's
  // aliases + legal-suffix presence remain available as a downstream signal.
  return 'name';
}
