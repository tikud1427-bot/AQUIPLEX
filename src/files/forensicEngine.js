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
/**
 * The TEXTUAL half of the `edited_number` rule, extracted as a seam.
 *
 * Extracted so a forensics eval can score the PREDICATE the engine actually
 * uses — a copy in the harness would drift the first time either side changed,
 * and the baseline would then measure a rule nobody ships. Same reasoning as
 * `_conflictKindForTests` in relationshipEngine.
 *
 * The FILE gate is deliberately NOT here: it is provenance policy, and
 * FINDING-2's false positives all passed it legitimately, exactly as
 * FINDING-1's did. The text is where the error is.
 */
export function maskNumbers(text) {
  return String(text).replace(/\d[\d,]*(?:\.\d+)?/g, '#');
}

export function maskIsUsable(key) {
  return /#/.test(key) && key.length >= 20;
}

const NUMBER_RE = /\d[\d,]*(?:\.\d+)?/g;

/**
 * How many numeric positions differ between two same-shaped sentences?
 * −1 when the shapes are incomparable (different count of numbers).
 *
 * FINDING-2. The rule fired on 20 ledger rows across 2 files and produced 90
 * accusations where the truth was 0. Measured on the labelled set, every
 * genuine doctoring changed EXACTLY ONE number while every table row changed
 * two or four in lockstep — the row index, the value and the date all moving
 * together, because they are different rows rather than one altered row:
 *
 *   doctored   "Payment of 250000 …"  →  "Payment of 750000 …"        1 differs
 *   table row  "Item 4 … 1004 … 05-14" → "Item 5 … 1005 … 06-15"      4 differ
 *
 * So the count of differing positions, not the mask equality alone, is what
 * separates the two. `severity: 'alert'` is the reason precision is worth a
 * declared recall cost here: this finding tells a user their document may be
 * forged, and it was wrong 17 times out of 27.
 */
export function numericDiffCount(a, b) {
  const A = String(a).match(NUMBER_RE) ?? [];
  const B = String(b).match(NUMBER_RE) ?? [];
  if (A.length !== B.length) return -1;
  let d = 0;
  for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) d++;
  return d;
}

/**
 * Would this pair be reported as an edited number, on TEXT alone?
 *
 * WHAT THIS FIX DOES NOT DO, measured and kept in the dataset as failing cases
 * rather than left to be discovered in production:
 *
 *   e030  two table rows differing ONLY in the row index still fire. The
 *         single-differing-number shape is indistinguishable from a doctored
 *         figure on text alone; closing it needs table structure, which this
 *         engine does not have.
 *   e031  a doctoring that changed the amount AND the date is now MISSED.
 *   e032  likewise an amount and a percentage.
 *
 * Recall therefore falls from 1.000 to 0.818 by construction. That trade is
 * deliberate for a rule at `severity: 'alert'`, and it is a trade rather than
 * an improvement, so it is stated here and measured in the gate rather than
 * described as a clean win.
 */
export function _looksEditedForTests(a, b) {
  const ka = maskNumbers(a), kb = maskNumbers(b);
  if (!maskIsUsable(ka) || !maskIsUsable(kb)) return false;
  if (ka !== kb) return false;              // different sentence shape
  if (String(a) === String(b)) return false; // identical including numbers → not edited
  return numericDiffCount(a, b) === 1;
}

/**
 * Pairwise comparisons performed by the `edited_number` rule.
 *
 * Exported for tests only. Incrementing an integer is the entire cost of this
 * seam, and it buys a pin that is exact and load-independent rather than
 * merely usually-right — the instrument AQUA_INDEXED_NOT_SCAN.md argues for
 * and the one `relationshipEngine.js` already uses for the contradiction pass.
 */
let editedNumberComparisons = 0;
export function _editedNumberComparisonsForTests() { return editedNumberComparisons; }
export function _resetEditedNumberComparisonsForTests() { editedNumberComparisons = 0; }

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
  //
  // ⚠️ THIS IS THE SUPERLINEAR STAGE OF THE FI-2 PASS, AND IT IS NOW COUNTED.
  //
  // `fileIntelligence2.e2e.test.js` pinned the whole pass with a TIMING ratio
  // and said what should replace it: "should be replaced by [a counter] when
  // the next superlinear stage is identified." Timing each stage separately at
  // 600 and 1200 facts identified it — everything else is flat, this is not:
  //
  //     rebuildGraph  1.19×      consensus   1.19×
  //     forensics     4.60×      gaps        1.74×
  //                              whatCaused  1.61×
  //
  // The cause is the pairwise loop below. `maskNumbers` collapses statements
  // that differ only in their digits into one key, so a corpus of rows from
  // the same table — the exact shape this rule exists to catch — lands in a
  // SINGLE group and is then compared every-pair. 600 facts is ~180k
  // comparisons; 1200 is ~719k. Quadratic, and the 4× matches the clock.
  //
  // The counter is the instrument, not the clock. Nine timing readings of the
  // old pin spread 2.08–2.90× across sample counts without converging, with
  // its 2.4 threshold sitting inside that spread — it was measuring GC, not
  // growth. A comparison count is exact and load-independent, the same
  // conclusion `relationshipEngine.js` reached for the contradiction pass.
  //
  // NOT FIXED HERE. Bucketing this the way FIX-5 bucketed contradictions is a
  // real change to a shipped forensic rule, and it needs its own before/after
  // on `forensic-edited.v1`. This PR makes the cost VISIBLE and pins it so the
  // fix can be measured. See `editedNumberCost.test.js`.
  const masked = new Map(); // number-masked normalized statement → [{fact, files}]
  for (const f of facts) {
    const key = maskNumbers(f.normalizedRepresentation ?? f.statement);
    if (!maskIsUsable(key)) continue;
    const evs = ES.evidenceForFact(ownerId, f.id);
    const files = [...new Set(evs.map(e => e.sourceFileId))];
    if (!masked.has(key)) masked.set(key, []);
    masked.get(key).push({ key, f, files, names: [...new Set(evs.map(e => e.sourceFileName ?? e.sourceFileId))], cits: evs.map(formatCitation) });
  }
  // ── FIX: BUCKET BY "ALL SLOTS BUT ONE", THE WAY FIX-5 BUCKETED CONTRADICTIONS ──
  //
  // The pass above collapses statements differing only in their digits into one
  // key, so a table's rows — the exact shape this rule exists to examine — land
  // in a SINGLE group that was then compared every-pair: n(n−1)/2, measured at
  // 11,175 / 44,850 / 179,700 comparisons for 150 / 300 / 600 facts.
  //
  // THIS IS AN EXACT TRANSFORM, NOT A HEURISTIC, AND THAT IS WHY IT IS SAFE.
  // The rule fires only when EXACTLY ONE numeric slot differs. Within a mask
  // group every statement has the same slot count, so for each statement and
  // each slot k we can key on "every slot except k". Two statements differ in
  // exactly one slot IFF they share such a key and are not identical — so:
  //
  //   · no qualifying pair can be missed  — it always collides on its own slot
  //   · no pair is counted twice          — differing in slot k, they collide
  //                                         on key k and on no other
  //   · every pair examined already passes numericDiffCount === 1
  //
  // Which means the comparisons that remain are exactly the candidate pairs,
  // and the ones removed were all guaranteed non-matches. Verified by snapshot
  // rather than argument: the findings on the labelled corpus are byte-identical
  // before and after, and `editedNumberCost.test.js` re-pins the new counts.
  const slotBuckets = new Map();
  for (const group of masked.values()) {
    if (group.length < 2) continue;
    for (const item of group) {
      const nums = String(item.f.normalizedRepresentation ?? item.f.statement).match(NUMBER_RE) ?? [];
      for (let k = 0; k < nums.length; k++) {
        // The mask key is included so two different sentence skeletons that
        // happen to share a numeric profile cannot meet.
        const key = `${item.key}\u0000${k}\u0000${nums.slice(0, k).join(',')}\u0000${nums.slice(k + 1).join(',')}`;
        if (!slotBuckets.has(key)) slotBuckets.set(key, []);
        slotBuckets.get(key).push(item);
      }
    }
  }

  for (const group of slotBuckets.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
      editedNumberComparisons++;
      const A = group[i], B = group[j];
      if (A.f.normalizedRepresentation === B.f.normalizedRepresentation) continue;   // identical incl. numbers
      // FINDING-2 — one changed number is a doctored figure; several changing
      // together are different rows of the same table. See numericDiffCount.
      // Applied here, on the SAME predicate the eval scores, so the shipped
      // rule and the measured rule cannot drift apart.
      if (numericDiffCount(A.f.normalizedRepresentation ?? A.f.statement,
                           B.f.normalizedRepresentation ?? B.f.statement) !== 1) continue;
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
