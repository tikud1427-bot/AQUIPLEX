/**
 * AQUA Eval — `edited_number` through the WHOLE rule, not just its predicate.
 *
 * 🔴 WHY THIS LANE EXISTS
 * -----------------------
 * `forensic-edited` grades `_looksEditedForTests(a, b)` and names its own scope
 * in its title: "the textual half". The other half is the loop in
 * `forensicReport` that decides which pairs are ever COMPARED — masking,
 * grouping, the cross-file condition, the identical-representation skip.
 * Nothing graded it.
 *
 * That gap was not theoretical. The `edited_number` grouping was rewritten from
 * an every-pair scan into slot buckets (quadratic → linear, 179,700 → 7,500
 * comparisons at 600 facts). Every one of the twelve metrics in
 * `forensic-edited.v1` sat perfectly still, because the suite never runs the
 * loop. Correctness had to be shown with a hand-built snapshot that lived in a
 * scratch file and was deleted afterwards. This is that snapshot, promoted to a
 * gated instrument.
 *
 * SAME PAIRS, SAME SCORER, ONE THING DIFFERENT
 * --------------------------------------------
 * The 36 labelled pairs, `forensicEditedScoring.mjs` shared verbatim with
 * `forensic-edited`. The only variable is whether the pair is handed straight
 * to the predicate or seeded into a real owner and read back out of a real
 * `forensicReport`. So a difference between the two baselines is attributable
 * to the rule's plumbing and to nothing else.
 *
 * ONE CORPUS, NOT ONE PER PAIR, AND THAT IS DELIBERATE
 * ----------------------------------------------------
 * Every pair is seeded into the SAME owner — statement `a` into one file,
 * statement `b` into another. Isolating each pair in its own owner would make
 * every group size two and never exercise the bucketing this lane exists to
 * cover. Sharing one corpus means statements from different cases can also meet
 * each other, so `n_report_findings` is reported alongside the per-pair
 * verdicts: a change that starts emitting spurious cross-case accusations moves
 * that count even when every labelled pair still scores correctly.
 *
 * A pair counts as FIRED when some emitted finding names both of its
 * statements — the thing a user would actually be shown, rather than an
 * internal boolean.
 */
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scorePair, aggregatePairs } from './forensicEditedScoring.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DS = JSON.parse(readFileSync(path.join(HERE, '../datasets/forensic-edited.v1.json'), 'utf8'));
const OWNER = 'owner:eval-forensic-report';

let fired = null;      // Set of `${a}\u0000${b}` pairs some finding named
let findingCount = 0;

/**
 * Build the corpus once, run the real report once, and record what it said.
 *
 * Flags are not touched: `forensicReport` is a plain function over two stores,
 * with no feature gate to get wrong.
 */
async function buildOnce() {
  if (fired) return;
  process.env.AQUA_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), 'aqua-eval-freport-'));

  const ES = await import('../../src/files/evidenceStore.js');
  const US = await import('../../src/files/ukoStore.js');
  const { createEvidence, createFact } = await import('../../src/files/evidence.js');
  const { createUKO } = await import('../../src/files/uko.js');
  const { forensicReport } = await import('../../src/files/forensicEngine.js');

  ES.purgeOwner?.(OWNER);
  US.purgeOwner?.(OWNER);

  const mkFile = id => {
    const u = createUKO({
      ownerId: OWNER,
      sourceFile: { name: `${id}.pdf`, ext: '.pdf', bytes: 1, hash: id.padEnd(64, 'z') },
      fileType: 'document',
    });
    u.id = id;
    US.saveUKO(u);
    return u;
  };
  const addFact = (u, statement, page) => {
    const ev = ES.saveEvidence(OWNER, createEvidence({
      sourceFileId: u.id, sourceFileName: u.sourceFile.name, sourceType: 'document',
      extractionMethod: 'structural', location: { page }, snippet: statement,
    }));
    ES.saveFact(OWNER, createFact({ statement, entities: ['VendorCo'], evidence: [ev] }), { sourceFileId: u.id });
  };

  // Two files, because the rule requires the pair to span different files —
  // a same-file pair is a table, which is the whole distinction being graded.
  const A = mkFile('fileA');
  const B = mkFile('fileB');
  DS.cases.forEach((c, i) => { addFact(A, c.a, i); addFact(B, c.b, i); });

  const report = forensicReport({ ukoStore: US, evidenceStore: ES }, OWNER);
  const edited = report.findings.filter(f => f.type === 'edited_number');
  findingCount = edited.length;

  fired = new Set();
  for (const f of edited) {
    const s = f.statements ?? [];
    for (let i = 0; i < s.length; i++) {
      for (let j = 0; j < s.length; j++) {
        if (i !== j) fired.add(`${s[i]}\u0000${s[j]}`);
      }
    }
  }
}

export default {
  id: 'forensic-report',
  title: 'forensics — what `edited_number` actually EMITS, plumbing included',
  about: [
    'Seeds all 36 labelled pairs into one owner across two files and reads the findings back',
    'out of the real forensicReport, rather than calling the pairwise predicate directly.',
    'Covers the half forensic-edited does not: masking, slot bucketing, the cross-file',
    'condition and the identical-representation skip. Same pairs, same scorer, so the delta',
    'against forensic-edited.v1 isolates the plumbing.',
  ].join('\n'),

  cases: DS.cases,

  async run(testCase) {
    await buildOnce();
    return { status: 'ok', actual: { fired: fired.has(`${testCase.a}\u0000${testCase.b}`) } };
  },

  score(testCase, actual) {
    return scorePair(testCase, actual.fired);
  },

  metrics(scored) {
    return {
      ...aggregatePairs(scored),
      // Corpus-level, not per-pair: catches spurious accusations between
      // statements belonging to DIFFERENT cases, which no per-pair verdict sees.
      n_report_findings: findingCount,
    };
  },
};
