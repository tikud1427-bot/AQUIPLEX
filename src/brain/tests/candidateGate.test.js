/**
 * E6/PR-2 — the candidate gate.
 *
 * `gate-core` scores the gate in aggregate on the corpus its cues were tuned
 * against. This file asserts the properties that aggregate cannot: that the
 * gate is not weaker than the system it replaces, that each cue earns its
 * place, that the negative cues do not swallow real claims, and that it still
 * works on a corpus it was never tuned on.
 *
 * Run: node --test src/brain/tests/candidateGate.test.js
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gateSegment, isCandidate, MIN_SEGMENT_LENGTH } from '../understanding/candidateGate.js';
import { extractConversationEntities } from '../knowledgeExtraction/conversationEntities.js';
import { _internals } from '../knowledgeExtraction/conversationFacts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const dataset = rel => JSON.parse(readFileSync(path.join(ROOT, 'eval/datasets', rel), 'utf8'));

describe('candidate gate — never weaker than the lane it replaces', () => {
  test('every segment the CURRENT extractor accepts is still admitted', () => {
    // The one guarantee E6 cannot break. If the new gate rejected something
    // the shipping lane accepts, promoting E6 would lose claims that work
    // today — a regression disguised as an upgrade.
    const cases = dataset('extraction-core.v1.json').cases;
    const regressions = cases.filter(c =>
      extractConversationEntities(c.text, { knownEntities: [] }).length > 0
      && !isCandidate(c.text));
    assert.deepEqual(regressions.map(c => c.id), [],
      `${regressions.length} segments accepted by the current extractor are rejected by the gate`);
  });

  test('the length floor matches conversationFacts — one floor, not two', () => {
    assert.equal(MIN_SEGMENT_LENGTH, _internals.MIN_SENTENCE_LENGTH,
      'two different minimum lengths in one pipeline is a silent disagreement about what is worth reading');
  });
});

describe('candidate gate — each positive signal earns its place', () => {
  const admittedVia = (text, reason) => {
    const g = gateSegment(text);
    assert.equal(g.admit, true, `${JSON.stringify(text)} should be admitted`);
    assert.equal(g.reason, reason, `${JSON.stringify(text)} admitted via ${g.reason}, expected ${reason}`);
  };

  test('entity extractor — first filter, matches today\'s behaviour', () => {
    admittedVia('I work at Nummo.', 'entity-extractor');
  });

  test('declarative intent — first-person statement with no named entity', () => {
    admittedVia('I usually do deep work in the mornings.', 'declarative-intent');
  });

  test('third-person subject — now found by the extractor, not the cue fallback', () => {
    // This asserted `cue:proper-noun`. It still admits, but by a BETTER route:
    // the entity extractor now finds "Sam" directly, because Tier 2 tests for a
    // finite verb rather than demanding a copula. The cue existed to paper over
    // exactly that gap.
    //
    // The route matters, not just the admission. `cue:proper-noun` means "no
    // entity was resolved but the shape looked like a claim"; `entity-extractor`
    // means the subject is a real resolved node other turns can attach facts
    // to. The second is what a world model needs.
    admittedVia('Sam owns the mobile app.', 'entity-extractor');
  });

  // THE REMAINING CUES NEVER FIRE ON THE EVAL CORPUS, AND THAT IS THE CORPUS,
  // NOT THE CUES. Every case in extraction-core.v1 is properly capitalised, so
  // `cue:proper-noun` absorbs all 45 third-person admits and the other three
  // report zero. sentenceParser's own history says why that is a corpus gap
  // rather than dead code: it removed a capital-letter lookahead because
  // "lowercase input is normal input, not malformed input", and casual chat is
  // full of it. So each cue is exercised below on the lowercase form, where it
  // is the ONLY thing standing between a real claim and silence.
  test('cue: temporal — fires on lowercase, where proper-noun cannot help', () => {
    admittedVia('the migration starts next monday', 'cue:temporal');
  });

  test('cue: negation — polarity is a claim', () => {
    admittedVia('the launch is not blocked by design', 'cue:negation');
  });

  test('cue: definite subject', () => {
    admittedVia('the parser rewrite is on hold', 'cue:definite-subject');
  });

  test('EVERY cue is load-bearing — measured, not assumed', () => {
    // A cue that never fires anywhere is untested surface pretending to be
    // coverage. The corpus alone cannot establish this, so the lowercase forms
    // are included in the population.
    const corpus = dataset('extraction-core.v1.json').cases.map(c => c.text);
    const lowercase = [
      'the migration starts next monday',
      'the launch is not blocked by design',
      'the parser rewrite is on hold',
    ];
    const fired = new Set([...corpus, ...lowercase].map(t => gateSegment(t).reason));
    for (const cue of ['cue:proper-noun', 'cue:temporal', 'cue:negation', 'cue:definite-subject']) {
      assert.ok(fired.has(cue), `${cue} never fires — remove it or justify it`);
    }
  });

  test('OPEN: a lowercase third-person name is still missed', () => {
    // "sam owns the mobile app" — no capital, no temporal marker, no negation,
    // no definite article. Nothing in the gate can see it. Recorded as a known
    // hole rather than left for production to find, and it is the shape a
    // fast typist produces constantly.
    assert.equal(isCandidate('sam owns the mobile app'), false,
      'INVERT THIS TEST when a lowercase-name cue exists');
  });
});

describe('candidate gate — negative cues reject the right things', () => {
  const rejectedFor = (text, reason) => {
    const g = gateSegment(text);
    assert.equal(g.admit, false, `${JSON.stringify(text)} should be rejected`);
    assert.equal(g.reason, reason, `${JSON.stringify(text)} rejected for ${g.reason}, expected ${reason}`);
  };

  test('questions and requests are not claims', () => {
    rejectedFor('Can you write me a python script?', 'question-or-request');
  });

  test('KNOWN COST: a question naming an entity is still admitted', () => {
    // "What is the capital of France?" reaches the ENTITY filter before the
    // question check and is admitted on France. Moving the question check
    // ahead of the filters was measured and is worse: it saves 3 false admits
    // and loses 6 modality claims ("Karan asked whether he owns the search
    // service", "Suppose the launch slipped to November"), because those open
    // with words INTERROGATIVE_OPENER matches. A miss is permanent and a false
    // admit is one call, so the ordering stays and the cost is recorded.
    const g = gateSegment('What is the capital of France?');
    assert.equal(g.admit, true);
    assert.equal(g.reason, 'entity-extractor',
      'INVERT THIS TEST if the ordering is ever changed — and re-measure modality recall first');
  });

  test('a first-person REQUEST is not self-disclosure', () => {
    // "I need to check the logs" and "I work at Nummo" are both first-person
    // declaratives; only one says something durable.
    rejectedFor('I need to check the logs.', 'requests-information');
  });

  test('conversational repair is not a claim', () => {
    rejectedFor('Never mind, I figured it out.', 'meta-conversational');
  });

  test('too short to carry a resolvable claim', () => {
    rejectedFor('Yes.', 'too-short');
  });

  test('the negative cues do NOT swallow real claims', () => {
    // The danger of a rejection rule: it fires on something that matters.
    // These all contain a word the negative cues look for and are all claims.
    for (const text of [
      'I need two more engineers before the launch.',
      'We want to hit 10,000 merchants by December.',
      'I actually moved to Pune last year.',
    ]) {
      assert.equal(isCandidate(text), true, `${JSON.stringify(text)} is a claim and was rejected`);
    }
  });
});

describe('candidate gate — measured', () => {
  const score = (texts, isClaim) => {
    let tp = 0, fp = 0, fn = 0;
    for (const t of texts) {
      const admit = isCandidate(t.text ?? t);
      const should = isClaim(t);
      if (admit && should) tp++; else if (admit && !should) fp++; else if (!admit && should) fn++;
    }
    return { recall: tp + fn ? tp / (tp + fn) : 0, precision: tp + fp ? tp / (tp + fp) : 0 };
  };

  test('IN-SAMPLE: recall beats the 0.613 the current gate achieves', () => {
    const cases = dataset('extraction-core.v1.json').cases;
    const { recall, precision } = score(cases, c => (c.claims ?? []).length > 0);
    assert.ok(recall >= 0.98, `gate recall ${recall.toFixed(3)}`);
    assert.ok(precision >= 0.88, `gate precision ${precision.toFixed(3)} — precision is the extraction bill, and it was traded down deliberately for recall`);
    assert.ok(recall > 0.613, 'must beat the entity-presence gate it replaces');
  });

  test('OUT-OF-SAMPLE: capture-core turns, never consulted while tuning', () => {
    // capture-core was written for PR-2 of the Bridge phase to measure whether
    // conversations become world-model state. Its turns had nothing to do with
    // designing these cues, which is what makes it a fair second look.
    //
    // It has no negative cases, so this can only confirm recall. Gate
    // PRECISION has never been measured out-of-sample — an open gap, recorded
    // here rather than left implicit in a good-looking number.
    const turns = [...new Set(dataset('capture-core.v1.json').cases.flatMap(c => c.turns))];
    assert.ok(turns.length >= 20, `only ${turns.length} turns — the loader stopped finding content`);
    const admitted = turns.filter(t => isCandidate(t));
    assert.equal(admitted.length, turns.length,
      `${turns.length - admitted.length} claim-bearing turns rejected: ${turns.filter(t => !isCandidate(t)).join(' | ')}`);
  });

  test('the misses are RECORDED, not hidden', () => {
    // 11 of 160 still never reach an extractor. Naming the categories means a
    // future change that makes one of them worse is visible as a change to
    // this list rather than as a decimal drifting in an aggregate.
    const cases = dataset('extraction-core.v1.json').cases;
    const missedCats = {};
    for (const c of cases) {
      if ((c.claims ?? []).length > 0 && !isCandidate(c.text)) {
        missedCats[c.cat] = (missedCats[c.cat] ?? 0) + 1;
      }
    }
    assert.deepEqual(missedCats, { modality: 1 },
      'the miss profile changed — if it improved, update this; if it grew, something regressed');
  });
});

describe('candidate gate — degenerate input', () => {
  for (const [label, input] of [['null', null], ['undefined', undefined], ['number', 42], ['object', {}]]) {
    test(`${label} is rejected without throwing`, () => {
      assert.deepEqual(gateSegment(input), { admit: false, reason: 'not-a-string' });
    });
  }
  test('empty and whitespace are rejected as too short', () => {
    assert.equal(gateSegment('').reason, 'too-short');
    assert.equal(gateSegment('    ').reason, 'too-short');
  });
});
