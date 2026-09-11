/**
 * AQUA Consolidation Engine — Persistent Intelligence Core (Phase 4)
 *
 * "Knowledge should continuously improve. Prevent fragmentation." One pass,
 * five operations, all over the EXISTING stores (evidenceStore is the source
 * of truth; the graph is derived; this engine only merges provenance and
 * annotates — it never rewrites a statement and never deletes anything):
 *
 *   1. MERGE DUPLICATE FACTS   same normalized statement → one survivor
 *      (highest confidence, then newest). Evidence unions onto the survivor
 *      (evidence sharing means this costs id references, not copies); the
 *      duplicates are marked { archived, supersededBy } — historical
 *      knowledge is archived, never destroyed. fact_supersession revisions
 *      + lifecycle transitions recorded on both sides.
 *
 *   2. HANDLE CONFLICTS        facts sitting on a `contradicts` edge in the
 *      reasoning graph are flagged { disputed } and their confidence CAPPED
 *      — a contested claim must not outrank an uncontested one. Surfaced,
 *      never resolved (Phase-3 rule stands).
 *
 *   3. EVOLVE CONFIDENCE       corroboration: evidence spanning N>1 distinct
 *      source files pushes confidence asymptotically toward CONF_CEIL —
 *      the same shape as the Mind layer's reinforcement math. Every move
 *      ≥ CONF_EPSILON records a `confidence` revision (trajectory queryable).
 *
 *   4. DETECT STALE            facts past STALE_MS with zero retrievals in
 *      the window are flagged { stale } — retrieval downweights them; they
 *      remain available (old ≠ wrong).
 *
 *   5. PROMOTE TRUSTED         multi-evidence, repeatedly-retrieved,
 *      undisputed facts gain { trusted } and lifecycle `verified` —
 *      the promotion path retrieval prefers.
 *
 * Deterministic, idempotent (a second run over consolidated knowledge is a
 * no-op), pure over injected deps, fail-open at the call site. Designed to
 * run in the background debounced per owner (see core.js) AND on demand via
 * the maintenance API.
 */
import { normalizeStatement } from '../files/evidence.js';
import { recordRevision } from './versionStore.js';
import { transition, getLifecycle } from './knowledgeLifecycle.js';
import { ledger } from './picStore.js';

export const STALE_MS     = 30 * 24 * 60 * 60 * 1000;
export const CONF_CEIL    = 0.98;
export const CONF_DISPUTE_CAP = 0.60;
export const CONF_EPSILON = 0.01;
const CORROBORATION_RATE  = 0.15;   // per extra independent file, toward the ceiling

/**
 * @param {object} deps    - { evidenceStore, graph } (graph = reasoningGraph module; optional)
 * @param {string} ownerId
 * @param {object} [opts]
 * @param {number} [opts.now]      injectable clock (tests)
 * @returns {object} report
 */
export function consolidateOwner(deps, ownerId, { now = Date.now() } = {}) {
  const { evidenceStore: ES, graph: G = null } = deps;
  const started = Date.now();
  const facts = ES.listFacts(ownerId, { limit: 100000 });

  const report = {
    factsScanned: facts.length,
    duplicatesMerged: 0, confidenceAdjusted: 0,
    disputed: 0, stale: 0, promoted: 0,
  };

  // ── 1. Duplicate merge (normalized-statement groups) ───────────────────────
  const groups = new Map();
  for (const f of facts) {
    if (f.archived) continue;
    const key = normalizeStatement(f.statement);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [survivor, ...dupes] = [...group].sort((a, b) =>
      (b.confidence - a.confidence) || (b.createdAt - a.createdAt));
    const mergedEvidence = [...new Set([survivor, ...dupes].flatMap(f => f.evidence))];
    ES.updateFact(ownerId, survivor.id, { evidence: mergedEvidence });
    transition(ownerId, `fact:${survivor.id}`, 'updated',   { reason: 'duplicate-merge' });
    transition(ownerId, `fact:${survivor.id}`, 'versioned', { reason: 'duplicate-merge' });
    for (const d of dupes) {
      ES.updateFact(ownerId, d.id, { archived: true, supersededBy: survivor.id });
      transition(ownerId, `fact:${d.id}`, 'archived', { reason: `superseded by ${survivor.id}` });
      recordRevision(ownerId, `fact:${d.id}`, {
        kind: 'fact_supersession',
        before: { active: true }, after: { active: false, supersededBy: survivor.id },
        reason: 'identical normalized statement',
      });
      recordRevision(ownerId, `fact:${survivor.id}`, {
        kind: 'fact_supersession',
        before: { evidenceCount: survivor.evidence.length },
        after:  { evidenceCount: mergedEvidence.length, absorbed: d.id },
        reason: 'absorbed duplicate',
      });
      report.duplicatesMerged += 1;
    }
  }

  // ── 2. Disputed flags from the reasoning graph's contradicts edges ─────────
  const disputedIds = new Set();
  if (G) {
    for (const factNode of G.nodesByType(ownerId, 'fact')) {
      for (const e of G.edgesOf(ownerId, factNode.id, { type: 'contradicts' })) {
        disputedIds.add(e.from.replace(/^fact:/, ''));
        disputedIds.add(e.to.replace(/^fact:/, ''));
      }
    }
  }

  // ── 3–5. Per-fact evolution (re-read: merge above changed evidence sets) ───
  for (const fact of ES.listFacts(ownerId, { limit: 100000 })) {
    if (fact.archived) continue;
    const evidence = ES.evidenceForFact(ownerId, fact.id);
    const files = new Set(evidence.map(e => e.sourceFileId)).size;
    const lc = getLifecycle(ownerId, `fact:${fact.id}`);
    let conf = fact.confidence ?? 0.5;
    const before = conf;
    const patch = {};

    if (disputedIds.has(fact.id)) {
      if (!fact.disputed) { patch.disputed = true; report.disputed += 1; }
      conf = Math.min(conf, CONF_DISPUTE_CAP);
    } else {
      // Idempotent corroboration: boost only for NEWLY independent source
      // files (count tracked on the fact) — re-running consolidation over
      // unchanged knowledge must be a no-op, not asymptotic creep.
      const prevFiles = fact.corroboratedFiles ?? 1;
      if (files > prevFiles) {
        conf = conf + (CONF_CEIL - conf) * Math.min(1, CORROBORATION_RATE * (files - prevFiles));
        patch.corroboratedFiles = files;
      }
    }
    conf = Math.round(conf * 100) / 100;
    if (Math.abs(conf - before) >= CONF_EPSILON) {
      patch.confidence = conf;
      report.confidenceAdjusted += 1;
      recordRevision(ownerId, `fact:${fact.id}`, {
        kind: 'confidence', before, after: conf,
        reason: disputedIds.has(fact.id) ? 'dispute cap' : `corroborated across ${files} files`,
      });
    }

    // Stale = untouched (no lifecycle activity — retrieval refreshes lastAt)
    // past the window. Flagged, downweighted at retrieval, never removed.
    const idle = now - (lc?.lastAt ?? fact.createdAt ?? now);
    if (idle > STALE_MS) {
      if (!fact.stale) { patch.stale = true; report.stale += 1; }
    } else if (fact.stale) {
      patch.stale = false;   // touched again — freshness restored
    }

    if (!disputedIds.has(fact.id) && evidence.length >= 2 && (lc?.meta?.retrievals ?? 0) >= 2 && !fact.trusted) {
      patch.trusted = true;
      report.promoted += 1;
      transition(ownerId, `fact:${fact.id}`, 'verified', { reason: 'promoted: multi-evidence + repeatedly retrieved' });
      recordRevision(ownerId, `fact:${fact.id}`, {
        kind: 'state', before: { trusted: false }, after: { trusted: true },
        reason: 'promotion criteria met',
      });
    }

    if (Object.keys(patch).length) ES.updateFact(ownerId, fact.id, patch);
  }

  report.durationMs = Date.now() - started;
  ledger(ownerId, 'consolidation', report);
  return report;
}
