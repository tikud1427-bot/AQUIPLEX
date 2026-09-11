/**
 * AQUA Eval — the forensics `edited_number` rule
 * Blueprint: the prerequisite FINDING-2 named
 *
 * FINDING-2 measured 90 alert-severity "doctored figure" findings from 20
 * ordinary ledger rows, and declined to fix it:
 *
 *   *"`differentSubjects` would almost certainly fix it — and that is exactly
 *   why it should not be reached for casually. Applying a gate validated
 *   against the CONTRADICTION evals to a FORENSICS rule assumes the two mean
 *   the same thing by the same test."*
 *
 * This is the test that stops it being an assumption.
 *
 * PRECISION MATTERS MORE HERE THAN ANYWHERE ELSE IN THIS PROJECT
 * -------------------------------------------------------------
 * A false contradiction is noise in a graph. A false `edited_number` **accuses
 * a document of being tampered with**, at `severity: 'alert'`, in the surface
 * a user reads when they are already suspicious.
 *
 * So the set is weighted toward ordinary pairs (21 to 8) and precision and
 * recall are reported separately — never averaged. A single accuracy figure
 * over an unbalanced set would flatter a rule that flags everything, which is
 * the behaviour under investigation.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _looksEditedForTests } from '../../src/files/forensicEngine.js';
// One scorer, two lanes. `forensic-report` grades the SAME pairs through the
// full rule, and a copied scorer would make the two incomparable in exactly
// the dimension they exist to isolate.
import { scorePair, aggregatePairs } from './forensicEditedScoring.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DS = JSON.parse(readFileSync(path.join(HERE, '../datasets/forensic-edited.v1.json'), 'utf8'));

export default {
  id: 'forensic-edited',
  title: 'forensics — does `edited_number` only fire on edited numbers',
  about: [
    'Runs the textual half of the edited_number rule over 33 labelled pairs: 11 genuine',
    'alterations and 22 ordinary pairs, 16 of them the per-item-table shape FINDING-2 measured',
    'firing 90 times on 20 rows. Precision and recall reported separately — this rule accuses a',
    'document of tampering, so a false positive is louder than a missed one.',
    'Four cases were added WITH the fix and are expected to fail: e030 is a table row whose only',
    'differing number is the row index, which text alone cannot separate from a doctored figure;',
    'e031/e032 are doctorings that moved two numbers and are now missed. Counts carry an n_ prefix',
    'because the reporter renders any value in [0,1] as a percentage, and a single false positive',
    'printed as "100.0%" is a number that will be misquoted.',
  ].join('\n'),

  cases: DS.cases,

  async run(testCase) {
    return { status: 'ok', actual: { fired: _looksEditedForTests(testCase.a, testCase.b) } };
  },

  score(testCase, actual) {
    return scorePair(testCase, actual.fired);
  },

  metrics(scored) {
    return aggregatePairs(scored);
  },
};
