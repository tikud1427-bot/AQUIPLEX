/**
 * AQUA Evidence Validator — Phase 2 quality controls
 *
 * The trust layer is only trustworthy if its own integrity is checked.
 * These validators detect exactly the failure modes the brief enumerates —
 * missing provenance, broken references, orphaned evidence, weak OCR /
 * uncertain timestamps (low confidence), duplicate facts, conflicting
 * facts. Pure functions over the store's data; they never mutate. Callers
 * (a maintenance route, a CI check, or a future retrieval guard) decide
 * what to do with the findings.
 *
 * Design: every check returns a list of typed findings
 * { type, severity, ... } so results compose into one report. Severity:
 * 'error' (a broken invariant), 'warning' (a quality risk).
 */
import { normalizeStatement } from './evidence.js';

const WEAK_CONFIDENCE = 0.5;   // OCR/speech below this is "weak" — flag, don't drop

/**
 * Full quality report for one owner's evidence graph.
 * @param {object} deps - the evidenceStore functions (injected for testability)
 * @param {string} ownerId
 */
export function auditEvidence(store, ownerId) {
  const facts    = store.listFacts(ownerId, { limit: 100000 });
  const findings = [];

  findings.push(...detectMissingProvenance(facts));
  findings.push(...detectBrokenReferences(store, ownerId, facts));
  findings.push(...detectOrphanedEvidence(store, ownerId, facts));
  findings.push(...detectWeakConfidence(store, ownerId, facts));
  findings.push(...detectDuplicateFacts(facts));
  findings.push(...detectConflictingFacts(store, ownerId, facts));

  const bySeverity = findings.reduce((a, f) => ((a[f.severity] = (a[f.severity] ?? 0) + 1), a), {});
  return {
    ok: (bySeverity.error ?? 0) === 0,
    counts: { total: findings.length, ...bySeverity, facts: facts.length },
    findings,
  };
}

/** Every fact must be grounded — a fact with no evidence is the cardinal sin. */
export function detectMissingProvenance(facts) {
  return facts.filter(f => !f.evidence?.length)
    .map(f => ({ type: 'missing_provenance', severity: 'error', factId: f.id, statement: f.statement.slice(0, 120) }));
}

/** Evidence ids on a fact that don't exist in the store. */
export function detectBrokenReferences(store, ownerId, facts) {
  const out = [];
  for (const f of facts) {
    for (const evId of f.evidence ?? []) {
      if (!store.getEvidence(ownerId, evId)) {
        out.push({ type: 'broken_reference', severity: 'error', factId: f.id, evidenceId: evId });
      }
    }
  }
  return out;
}

/** Evidence objects that no fact references (dead weight; safe to GC). */
export function detectOrphanedEvidence(store, ownerId, facts) {
  const referenced = new Set(facts.flatMap(f => f.evidence ?? []));
  const stats = store.getEvidenceStats(ownerId);
  // Walk the store's evidence via files (public surface) to find unreferenced ids.
  const out = [];
  const seen = new Set();
  for (const f of facts) for (const evId of f.evidence ?? []) seen.add(evId);
  // Any evidence attached to a file but cited by nobody:
  for (const fileId of filesOf(store, ownerId)) {
    for (const ev of store.evidenceForFile(ownerId, fileId)) {
      if (!referenced.has(ev.id)) {
        out.push({ type: 'orphaned_evidence', severity: 'warning', evidenceId: ev.id, sourceFileId: ev.sourceFileId });
      }
    }
  }
  void stats; void seen;
  return out;
}

/** Weak OCR / low-confidence speech / uncertain timestamps. */
export function detectWeakConfidence(store, ownerId, facts) {
  const out = [];
  for (const f of facts) {
    for (const ev of store.evidenceForFact(ownerId, f.id)) {
      if (ev.confidence < WEAK_CONFIDENCE) {
        out.push({
          type: ev.extractionMethod === 'ocr' ? 'weak_ocr'
            : ev.location?.timestamp != null ? 'uncertain_timestamp' : 'low_confidence',
          severity: 'warning', factId: f.id, evidenceId: ev.id,
          confidence: ev.confidence, method: ev.extractionMethod,
        });
      }
    }
  }
  return out;
}

/** Facts with identical normalized statements (dedup candidates). */
export function detectDuplicateFacts(facts) {
  const byNorm = new Map();
  for (const f of facts) {
    const key = f.normalizedRepresentation ?? normalizeStatement(f.statement);
    (byNorm.get(key) ?? byNorm.set(key, []).get(key)).push(f.id);
  }
  return [...byNorm.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([norm, ids]) => ({ type: 'duplicate_fact', severity: 'warning', normalized: norm.slice(0, 120), factIds: ids }));
}

/**
 * Conflicting facts: same subject entity, contradictory numeric/negation.
 * Heuristic and deliberately conservative — this phase SURFACES candidate
 * conflicts for a human/later engine, it does not resolve them.
 */
export function detectConflictingFacts(store, ownerId, facts) {
  const out = [];
  // Group by shared entity.
  const byEntity = new Map();
  for (const f of facts) {
    for (const e of f.entities ?? []) {
      const k = String(e).toLowerCase();
      (byEntity.get(k) ?? byEntity.set(k, []).get(k)).push(f);
    }
  }
  for (const [entity, group] of byEntity) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (looksConflicting(group[i].statement, group[j].statement)) {
          out.push({
            type: 'conflicting_fact', severity: 'warning', entity,
            factIds: [group[i].id, group[j].id],
            statements: [group[i].statement.slice(0, 100), group[j].statement.slice(0, 100)],
          });
        }
      }
    }
  }
  return out;
}

// ── heuristics ────────────────────────────────────────────────────────────────

function looksConflicting(a, b) {
  const na = numbersIn(a), nb = numbersIn(b);
  // Same leading context but different numbers → candidate numeric conflict.
  if (na.length && nb.length) {
    const shared = na.filter(x => nb.includes(x));
    if (!shared.length && overlapWords(a, b) >= 3) return true;
  }
  // Negation polarity flip on otherwise-similar sentences.
  const negA = /\b(not|no|never|isn't|aren't|won't|cannot|can't)\b/i.test(a);
  const negB = /\b(not|no|never|isn't|aren't|won't|cannot|can't)\b/i.test(b);
  if (negA !== negB && overlapWords(a, b) >= 4) return true;
  return false;
}

function numbersIn(s) { return [...String(s).matchAll(/\d[\d,]*(?:\.\d+)?/g)].map(m => m[0].replace(/,/g, '')); }
function overlapWords(a, b) {
  const wa = new Set(String(a).toLowerCase().match(/[a-z]{3,}/g) ?? []);
  const wb = new Set(String(b).toLowerCase().match(/[a-z]{3,}/g) ?? []);
  let n = 0; for (const w of wa) if (wb.has(w)) n++;
  return n;
}

function filesOf(store, ownerId) {
  // getEvidenceStats gives counts; we need file ids — derive from facts' evidence.
  const files = new Set();
  for (const f of store.listFacts(ownerId, { limit: 100000 })) {
    for (const ev of store.evidenceForFact(ownerId, f.id)) files.add(ev.sourceFileId);
  }
  return files;
}
