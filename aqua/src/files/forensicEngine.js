/**
 * AQUA Forensic Engine — File Intelligence 2.0
 *
 * Deterministic evidence-integrity analysis over the EXISTING stores. Pure
 * over injected deps ({ ukoStore, evidenceStore }); no model, no I/O, no
 * mutation — findings are surfaced with evidence, never acted on. Every
 * finding: { type, severity: 'info'|'warning'|'alert', confidence, files,
 * explanation, ...detail }. Confidence is the strength of the SIGNAL, not
 * an accusation — forensic output is investigative leads, not verdicts.
 *
 * Signals (all computable from what ingest already persists):
 *   duplicate_content       identical sourceFile.hash under different names
 *                           — the same bytes submitted as separate evidence
 *   revised_document        same (case-folded) name, different hash — a
 *                           document that changed between uploads; the
 *                           newer UKO is the revision
 *   future_dated_content    a dated statement whose parsed date is in the
 *                           future relative to `now` — fabrication signal
 *   scanned_document        a 'document' whose evidence is OCR-method —
 *                           print-and-rescan breaks the digital text layer
 *                           (classic manipulation-laundering path)
 *   weak_evidence_file      a file whose mean evidence confidence < 0.6 —
 *                           conclusions resting on it inherit the weakness
 *   edited_number           two facts, different files, statements equal
 *                           after number-masking but numbers differ — the
 *                           shape of a doctored figure
 *   deep_nesting            evidence located ≥2 archive levels deep —
 *                           content placed where casual review misses it
 *   assertion_without_entities  a file asserting facts that reference no
 *                           entities — structure anomaly worth a look
 *
 * fileForensics(ownerId, ukoId) is the per-file dossier: hash, size,
 * parser/extractor, extraction-method mix, evidence confidence stats,
 * dates found, and the subset of report findings touching this file.
 */
import { formatCitation } from './evidence.js';

const WEAK_MEAN = 0.6;
const round = (n) => Math.round(n * 100) / 100;

/** Full forensic report for one owner's knowledge space. */
export function forensicReport(deps, ownerId, { now = Date.now() } = {}) {
  const { ukoStore: US, evidenceStore: ES } = deps;
  const ukos = US.listUKOs(ownerId, { limit: 100000 });
  const facts = ES.listFacts(ownerId, { limit: 100000 });
  const findings = [];

  // ── duplicate_content + revised_document ──
  const byHash = new Map(); const byName = new Map();
  for (const u of ukos) {
    const h = u.sourceFile?.hash; const n = String(u.sourceFile?.name ?? '').toLowerCase();
    if (h) { if (!byHash.has(h)) byHash.set(h, []); byHash.get(h).push(u); }
    if (n) { if (!byName.has(n)) byName.set(n, []); byName.get(n).push(u); }
  }
  for (const [hash, group] of byHash) {
    const names = [...new Set(group.map(u => u.sourceFile.name))];
    if (group.length > 1 && names.length > 1) {
      findings.push({
        type: 'duplicate_content', severity: 'warning', confidence: 0.95,
        files: names, hash,
        explanation: `Identical content (sha256 ${hash.slice(0, 12)}…) uploaded under ${names.length} different names — one piece of evidence presented as several.`,
      });
    }
  }
  for (const [name, group] of byName) {
    const hashes = [...new Set(group.map(u => u.sourceFile.hash))];
    if (hashes.length > 1) {
      const sorted = [...group].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
      findings.push({
        type: 'revised_document', severity: 'warning', confidence: 0.9,
        files: [group[0].sourceFile.name], versions: sorted.map(u => ({ ukoId: u.id, hash: u.sourceFile.hash, bytes: u.sourceFile.bytes, at: u.createdAt ?? null })),
        explanation: `"${group[0].sourceFile.name}" exists in ${hashes.length} distinct versions — the document changed between uploads.`,
      });
    }
  }

  // ── per-file evidence scans (method mix, confidence, dates, nesting) ──
  const fileFindings = new Map(); // ukoId → partial detail reused by fileForensics
  for (const u of ukos) {
    const evs = ES.evidenceForFile(ownerId, u.id);
    const methods = countBy(evs, e => e.extractionMethod);
    const confs = evs.map(e => e.confidence);
    const mean = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null;
    fileFindings.set(u.id, { methods, mean, evidenceCount: evs.length });

    if (u.fileType === 'document' && methods.ocr) {
      findings.push({
        type: 'scanned_document', severity: 'info', confidence: 0.85,
        files: [u.sourceFile.name], ukoId: u.id,
        explanation: `Document required OCR (${methods.ocr} region(s)) — no digital text layer. Scans break the provenance a digitally-authored file carries; verify against an original if one should exist.`,
      });
    }
    if (mean != null && mean < WEAK_MEAN && evs.length >= 3) {
      findings.push({
        type: 'weak_evidence_file', severity: 'warning', confidence: round(1 - mean),
        files: [u.sourceFile.name], ukoId: u.id, meanConfidence: round(mean),
        explanation: `Mean evidence confidence ${round(mean)} across ${evs.length} items — conclusions drawn from this file inherit that uncertainty.`,
      });
    }
    for (const e of evs) {
      const depth = String(e.location?.nestedPath ?? '').split('/').filter(Boolean).length;
      if (depth >= 2) {
        findings.push({
          type: 'deep_nesting', severity: 'info', confidence: 0.7,
          files: [u.sourceFile.name], citation: formatCitation(e),
          explanation: `Evidence sits ${depth} levels deep inside an archive (${e.location.nestedPath}) — easy to miss in casual review.`,
        });
        break; // one per file is enough signal
      }
    }
  }

  // ── future_dated_content ──
  for (const f of facts) {
    const d = parseAnyDate(f.statement);
    if (d != null && d > now + 24 * 3600 * 1000) {
      const evs = ES.evidenceForFact(ownerId, f.id);
      findings.push({
        type: 'future_dated_content', severity: 'alert', confidence: 0.8,
        files: [...new Set(evs.map(e => e.sourceFileName ?? e.sourceFileId))],
        statement: f.statement.slice(0, 160), date: new Date(d).toISOString().slice(0, 10),
        citations: evs.map(formatCitation),
        explanation: 'Statement carries a date in the future relative to analysis time — dating error or fabrication.',
      });
    }
  }

  // ── edited_number: same sentence shape, different numbers, different files ──
  const masked = new Map(); // number-masked normalized statement → [{fact, files}]
  for (const f of facts) {
    const key = String(f.normalizedRepresentation ?? f.statement).replace(/\d[\d,]*(?:\.\d+)?/g, '#');
    if (!/#/.test(key) || key.length < 20) continue;
    const evs = ES.evidenceForFact(ownerId, f.id);
    const files = [...new Set(evs.map(e => e.sourceFileId))];
    if (!masked.has(key)) masked.set(key, []);
    masked.get(key).push({ f, files, names: [...new Set(evs.map(e => e.sourceFileName ?? e.sourceFileId))], cits: evs.map(formatCitation) });
  }
  for (const group of masked.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
      const A = group[i], B = group[j];
      if (A.f.normalizedRepresentation === B.f.normalizedRepresentation) continue;   // identical incl. numbers
      if (!A.files.some(x => !B.files.includes(x)) && !B.files.some(x => !A.files.includes(x))) continue; // same file(s)
      findings.push({
        type: 'edited_number', severity: 'alert', confidence: 0.75,
        files: [...new Set([...A.names, ...B.names])],
        statements: [A.f.statement, B.f.statement],
        citations: [A.cits, B.cits],
        explanation: 'Two files carry the same sentence with only the numbers changed — the signature of a doctored figure. Verify which value the source of record holds.',
      });
    }
  }

  // ── assertion_without_entities ──
  const factsByFile = new Map();
  for (const f of facts) {
    for (const e of ES.evidenceForFact(ownerId, f.id)) {
      if (!factsByFile.has(e.sourceFileId)) factsByFile.set(e.sourceFileId, []);
      factsByFile.get(e.sourceFileId).push(f);
    }
  }
  for (const [fid, fs] of factsByFile) {
    if (fs.length >= 3 && fs.every(f => !(f.entities?.length))) {
      const u = ukos.find(x => x.id === fid);
      findings.push({
        type: 'assertion_without_entities', severity: 'info', confidence: 0.6,
        files: [u?.sourceFile?.name ?? fid],
        explanation: `${fs.length} extracted statements reference no entities at all — unusual structure; content may be templated or deliberately vague.`,
      });
    }
  }

  const bySeverity = countBy(findings, f => f.severity);
  return {
    ownerFiles: ukos.length, factsScanned: facts.length,
    counts: { total: findings.length, ...bySeverity },
    findings: findings.sort((a, b) => sevRank(b.severity) - sevRank(a.severity) || b.confidence - a.confidence),
    kind: 'derived',
  };
}

/** Per-file forensic dossier. */
export function fileForensics(deps, ownerId, ukoId, opts = {}) {
  const { ukoStore: US, evidenceStore: ES } = deps;
  const u = US.getUKO(ownerId, ukoId);
  if (!u) return null;
  const evs = ES.evidenceForFile(ownerId, ukoId);
  const confs = evs.map(e => e.confidence);
  const report = forensicReport(deps, ownerId, opts);
  const dates = [];
  for (const f of ES.factsForFile(ownerId, ukoId)) {
    const d = parseAnyDate(f.statement);
    if (d != null) dates.push(new Date(d).toISOString().slice(0, 10));
  }
  return {
    file: u.sourceFile.name, ukoId, fileType: u.fileType,
    hash: u.sourceFile.hash, bytes: u.sourceFile.bytes,
    parser: u.provenance?.parser ?? null, analyzer: u.provenance?.analyzer ?? null,
    extractionMethods: countBy(evs, e => e.extractionMethod),
    evidence: {
      count: evs.length,
      meanConfidence: confs.length ? round(confs.reduce((a, b) => a + b, 0) / confs.length) : null,
      minConfidence: confs.length ? round(Math.min(...confs)) : null,
    },
    datesFound: [...new Set(dates)].sort(),
    findings: report.findings.filter(f => f.ukoId === ukoId || (f.files ?? []).includes(u.sourceFile.name)),
    kind: 'derived',
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function countBy(list, fn) {
  const out = {};
  for (const x of list) { const k = fn(x); out[k] = (out[k] ?? 0) + 1; }
  return out;
}
function sevRank(s) { return s === 'alert' ? 3 : s === 'warning' ? 2 : 1; }

function parseAnyDate(text) {
  const iso = String(text).match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) { const t = Date.parse(iso[0]); return Number.isNaN(t) ? null : t; }
  const named = String(text).match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/);
  if (named) { const t = Date.parse(named[0]); return Number.isNaN(t) ? null : t; }
  return null;
}
