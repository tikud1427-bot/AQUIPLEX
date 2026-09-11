/**
 * The E6 understanding pipeline, S0 → S5.
 *
 * Three things matter more than the rest:
 *
 *   1. SECRETS DO NOT REACH THE PROVIDER. Nothing scanned before this module
 *      existed, and segments go to a third party.
 *   2. THE MISSING STAGES ARE VISIBLE. S6 is absent, so subjects and objects
 *      are surface strings. A caller that mistook them for entity ids would
 *      mint edges to nodes nothing can reach.
 *   3. IT IS THE SAME CODE THE SHADOW RUN MEASURES. The eval adapter
 *      delegates here; two compositions would drift and the eval would keep
 *      reporting on the old one.
 *
 * Run: node --test src/brain/tests/pipeline.test.js
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  runUnderstandingPipeline, STAGES, STAGES_WITH_S6, NOT_IMPLEMENTED, MAX_MESSAGE_CHARS,
} from '../understanding/pipeline.js';
import { normalizeMention } from '../../reasoning/entityResolver.js';
import { __clearExtractionCache } from '../understanding/extractionClient.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');

const worksAt = {
  subject: 'self', predicate: 'works_at', object: { entity: 'Nummo' },
  polarity: 'asserted', modality: 'fact', timePrecision: 'none',
  statementText: 'I work at Nummo', confidenceExtraction: 0.9,
};

/** Records exactly what was sent to the provider. */
const spy = (claims = [worksAt]) => {
  const fn = async ({ user }) => { fn.sent.push(user); return { model: 'stub-1', text: JSON.stringify({ claims }) }; };
  fn.sent = [];
  return fn;
};

/** A minimal owner-scoped entity store, matching S6's reader contract. */
const store = (names = []) => {
  const list = names.map((n, i) => ({ id: `e${i}`, name: n }));
  return {
    all: () => list,
    byNormalized: n => list.find(e => normalizeMention(e.name) === n) ?? null,
    byAlias: () => null,
  };
};

beforeEach(() => __clearExtractionCache());

/**
 * Discards are keyed `gate:reason` — the gate number alone lost the cause.
 * The first live E6 shadow run reported `{"2": 2}`, and gate 2 covers both
 * `object-missing` and `object-not-in-quote`: one is the model omitting a
 * field, the other inventing content. This finds the entry by stage prefix so
 * these tests keep pinning the stage while the reason rides along.
 */
const gateKey = (r, gate) =>
  Object.keys(r.stats.byGate).find(k => k === gate || k.startsWith(`${gate}:`)) ?? gate;

describe('S0 — secrets never reach the provider', () => {
  test('an API key in the message is REDACTED before transmission', async () => {
    // Before this module nothing between the user's text and a third-party
    // request looked for credentials. secretGuard shipped and no stage called
    // it. A pasted .env, a key in a stack trace, a connection string in a
    // debugging question — all went verbatim.
    const callModel = spy();
    const r = await runUnderstandingPipeline(
      'I work at Nummo. My key is sk-live-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH and it works.',
      { callModel });

    assert.ok(r.stats.s0.redactions > 0, 'the scan found something');
    for (const sent of callModel.sent) {
      assert.ok(!sent.includes('sk-live-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH'),
        'a credential reached the provider');
    }
  });

  test('redaction happens BEFORE segmentation', async () => {
    // A credential straddling a sentence boundary would otherwise be split and
    // each half sent separately — still exposed, and harder to notice.
    const src = readFileSync(path.join(HERE, '..', 'understanding', 'pipeline.js'), 'utf8');
    const redactAt = src.indexOf('redactSecrets(text)');
    const segmentAt = src.indexOf('segmentMessage(clean)');
    assert.ok(redactAt > 0 && segmentAt > 0);
    assert.ok(redactAt < segmentAt, 'segmentation must run on the redacted text');
  });

  test('ordinary text is untouched and passes through', async () => {
    const callModel = spy();
    const r = await runUnderstandingPipeline('I work at Nummo.', { callModel });
    assert.equal(r.stats.s0.redactions, 0);
    assert.ok(callModel.sent[0].includes('I work at Nummo'));
  });

  test('an oversize message is refused before any provider call', async () => {
    const callModel = spy();
    const r = await runUnderstandingPipeline('x'.repeat(MAX_MESSAGE_CHARS + 1), { callModel });
    assert.equal(r.stats.s0.admitted, false);
    assert.equal(r.stats.s0.reason, 'too-large');
    assert.equal(callModel.sent.length, 0, 'nothing was spent');
  });

  test('empty input is refused without a call', async () => {
    const callModel = spy();
    for (const bad of ['', '   ', null, undefined, 42]) {
      const r = await runUnderstandingPipeline(bad, { callModel });
      assert.equal(r.stats.s0.admitted, false);
    }
    assert.equal(callModel.sent.length, 0);
  });
});

describe('the missing stages are declared, not skipped silently', () => {
  test('S6 runs ONLY with a store, and says so when it does not', async () => {
    // Resolving against no store would mark every subject provisional and
    // report a resolution rate of zero — a number that looks like a
    // measurement of the resolver and is actually a measurement of the caller
    // forgetting an argument.
    const without = await runUnderstandingPipeline('I work at Nummo.', { callModel: spy() });
    assert.equal(without.entityResolution, 'unresolved');
    assert.deepEqual(without.stagesRun, STAGES);
    assert.equal(without.stagesRun.includes('S6'), false);

    const withStore = await runUnderstandingPipeline('I work at Nummo.', {
      callModel: spy(), entityStore: store(['Nummo']), selfEntityId: 'owner-self' });
    assert.equal(withStore.entityResolution, 'resolved');
    assert.deepEqual(withStore.stagesRun, STAGES_WITH_S6);
  });

  test('S6 attaches entity ids and marks which claims are READY for S7', async () => {
    const r = await runUnderstandingPipeline('I work at Nummo.', {
      callModel: spy(), entityStore: store(['Nummo']), selfEntityId: 'owner-self' });
    const [c] = r.claims;
    assert.equal(c.subjectEntityId, 'owner-self', 'deixis resolved by grammar');
    assert.ok(c.objectEntityId, 'the company resolved');
    assert.equal(c.resolution.ready, true);
    assert.equal(r.readyForS7.length, 1);
  });

  test('an UNRESOLVED end keeps a claim out of readyForS7', async () => {
    // E6/PR-8 refuses to build an edge from a surface string. A claim whose
    // object is provisional has no id yet, so letting it through would mint an
    // edge to a node that does not exist.
    const r = await runUnderstandingPipeline('I work at Nummo.', {
      callModel: spy(), entityStore: store([]), selfEntityId: 'owner-self' });
    assert.equal(r.claims.length, 1);
    assert.equal(r.readyForS7.length, 0);
    assert.match(r.claims[0].resolution.blockedBy, /^object:/);
    assert.equal(r.stats.s6.provisional, 1);
  });

  test('S7, S8 and S9 are still NOT run', async () => {
    const r = await runUnderstandingPipeline('I work at Nummo.', {
      callModel: spy(), entityStore: store(['Nummo']), selfEntityId: 'owner-self' });
    for (const s of ['S7', 'S8', 'S9']) {
      assert.equal(r.stagesRun.includes(s), false, `${s} must not claim to have run`);
    }
    assert.equal('edges' in r, false);
    assert.equal('commitPlan' in r, false);
    assert.match(NOT_IMPLEMENTED.S7_S9, /provisional/,
      'and the reason is stated: S6 emits provisional ids a caller must insert first');
  });

  test("S0's unimplemented halves are listed", async () => {
    assert.deepEqual(NOT_IMPLEMENTED.S0_partial, ['owner-budget', 'rate-bounds']);
  });
});

describe('the pipeline runs the stages in blueprint order', () => {
  test('a claim-bearing message yields a dated, validated claim', async () => {
    const r = await runUnderstandingPipeline('I work at Nummo.', { callModel: spy() });
    assert.equal(r.claims.length, 1);
    const [c] = r.claims;
    assert.equal(c.predicate, 'works_at');
    assert.ok('timePrecision' in c, 'S5 ran');
    assert.ok(c.confidence, 'S4 set a ceilinged confidence');
    assert.ok(c.segment && Number.isInteger(c.segment.start), 'S1 spans are carried');
  });

  test('S2 rejects a segment before it costs a call', async () => {
    const callModel = spy();
    const r = await runUnderstandingPipeline('Can you write me a python script?', { callModel });
    assert.equal(r.stats.gated, 0);
    assert.equal(callModel.sent.length, 0, 'the gate is cost control, so it must run first');
  });

  test('S4 discards are attributed to a GATE', async () => {
    const r = await runUnderstandingPipeline('I work at Nummo.', {
      callModel: spy([{ ...worksAt, statementText: 'The user is employed at Nummo' }]) });
    assert.equal(r.claims.length, 0);
    assert.equal(r.stats.byGate[gateKey(r, '1')], 1, 'gate ① — the quote is not verbatim');
  });

  test('an unregistered predicate becomes a PROPOSAL, carrying its quote', async () => {
    // Refusing is not forgetting. Dropping the rejection loses the only
    // evidence that the vocabulary is too small.
    const r = await runUnderstandingPipeline('I work at Nummo.', {
      callModel: spy([{ ...worksAt, predicate: 'enjoys_working_at' }]) });
    assert.equal(r.stats.proposed, 1);
    assert.equal(r.proposals.length, 1);
    assert.equal(r.proposals[0].predicate, 'enjoys_working_at');
    assert.equal(r.claims.length, 0);
  });

  test('S5 does NOT invent a date when asserted_at is absent', async () => {
    // The pipeline must not paper over a missing anchor with the clock — a
    // claim wrongly stamped "now" outranks every correctly-dated one.
    const r = await runUnderstandingPipeline('I joined last month.', {
      callModel: spy([{ ...worksAt, statementText: 'I joined last month' }]) });
    assert.equal(r.claims[0].validFrom, null);
    assert.equal(r.claims[0].timePrecision, 'relative');
  });

  test('a transport failure is counted, never thrown', async () => {
    const r = await runUnderstandingPipeline('I work at Nummo.', {
      callModel: async () => { throw new Error('ECONNRESET'); } });
    assert.equal(r.stats.errors, 1);
    assert.deepEqual(r.claims, []);
  });

  test('no transport yields nothing and spends nothing', async () => {
    const r = await runUnderstandingPipeline('I work at Nummo.', {});
    assert.deepEqual(r.claims, []);
  });
});

describe('one composition, not two', () => {
  test('the eval adapter delegates rather than re-composing', async () => {
    // Two compositions drift the first time a stage changes, and the eval
    // keeps reporting on the old one — while looking entirely healthy.
    const src = readFileSync(path.join(ROOT, 'eval/adapters/e6Extractor.mjs'), 'utf8');
    assert.ok(src.includes('runUnderstandingPipeline'), 'the adapter must call the pipeline');
    for (const stage of ['segmentMessage(', 'gateSegment(', 'validateAgainstSegment(', 'applyTemporal(']) {
      assert.ok(!src.includes(stage), `the adapter still runs ${stage} itself`);
    }
  });

  test('the pipeline carries no eval-shaped concerns', () => {
    // `self` → first-person surfaces is a property of how the CORPUS labels
    // subjects, not of understanding. Putting it here would bake a test
    // artefact into production output.
    const src = readFileSync(path.join(HERE, '..', 'understanding', 'pipeline.js'), 'utf8');
    assert.ok(!src.includes('surfaces'), 'surface expansion belongs to the eval adapter');
  });
});

// ── A discard says WHICH rule it tripped ─────────────────────────────────────

/**
 * 🔴 ONE NUMBER, ELEVEN RULES, ELEVEN DIFFERENT FIXES.
 *
 * S3 collapsed every contract rejection into `?:contract`. A 200-case eval
 * reported `?:contract: 22` and there was no way to learn whether that was a
 * predicate the vocabulary lacks, an object typed as an entity where the
 * registry wants a literal, or a missing statement span — three problems with
 * nothing in common except the count they shared.
 *
 * It mattered: two of the three negation cases that fail the promotion gate on
 * every run are contract discards, and `negation` is the only category the gate
 * is judged on.
 *
 * BITE, MEASURED (revert the named property → count failures):
 *   the rule is carried into the key   → 3 fail
 *   the key stays bounded              → 1 fail
 */
describe('S3 contract discards name the rule they tripped', () => {
  const seg = 'I own the billing service.';
  const respond = claim => async () => ({
    text: JSON.stringify({ claims: [claim] }), model: 'stub/model',
  });
  // ⚠️ THE CACHE MUST GO BETWEEN CASES OR THE SECOND ASSERTION IS THE FIRST.
  // `extractionClient` memoises on the segment hash, and every case here uses
  // the SAME sentence on purpose — the variable under test is the claim, not
  // the text. Without this, run two replays run one's response and the test
  // reports that two different defects produced the same key, which is exactly
  // the conclusion it exists to disprove.
  const run = async claim => {
    __clearExtractionCache();
    return runUnderstandingPipeline(seg, {
      ownerId: 'o', conversationId: 'c', callModel: respond(claim),
    });
  };

  // `owns` takes an ENTITY — it declares an inverse, and an inverse forces it
  // (see predicateRegistry.js). This fixture was `{ literal: … }` until that
  // contradiction was fixed, and the tests below flipped direction with it:
  // the mismatch to provoke is now a literal where an entity belongs.
  const base = {
    subject: 'self', predicate: 'owns', object: { entity: 'billing service' },
    polarity: 'asserted', modality: 'fact', timePrecision: 'none',
    statementText: seg,
  };

  test('an object-kind mismatch is a PROPOSAL, carrying the kind observed', async () => {
    // This asserted a byGate key until the named-discard run showed that every
    // contract rejection in 525 calls was this one rule, on objects like
    // `uses → Postgres` and `blocks → Priya`. A person typed as a literal is
    // the registry being wrong, not the claim — so the evidence survives.
    const r = await run({ ...base, object: { literal: 'billing service' } });
    assert.equal(r.stats.proposed, 1);
    assert.equal(r.stats.discarded, 0, 'the claim was destroyed instead of proposed');
    const p = r.proposals.find(x => x.kind === 'object-shape');
    assert.ok(p, `no object-shape proposal: ${JSON.stringify(r.proposals)}`);
    assert.equal(p.predicate, 'owns');
    assert.equal(p.observed, 'literal', 'the proposal does not say what shape arrived');
  });

  test('an object-shape proposal is DISTINGUISHABLE from a predicate proposal', async () => {
    // Two different repairs: one grows the vocabulary, the other corrects the
    // shape of a term already in it. Collapsing them would recreate the
    // one-number problem this whole block exists to end.
    const shape = await run({ ...base, object: { literal: 'billing service' } });
    const vocab = await run({ ...base, predicate: 'enjoys_immensely' });
    assert.equal(shape.proposals[0].kind, 'object-shape');
    assert.equal(vocab.proposals[0].kind, 'predicate');
  });

  test('two different contract rules are still DIFFERENT keys', () => {
    // The property the old code destroyed: unrelated defects shared one number.
    // Object-kind now routes to proposals, so this checks the pair that still
    // discards — a bad enum value against a missing span.
    return Promise.all([
      run({ ...base, modality: 'speculative' }),
      run({ ...base, statementText: '' }),
    ]).then(([a, b]) => {
      const ka = Object.keys(a.stats.byGate).find(k => k.startsWith('?:contract'));
      const kb = Object.keys(b.stats.byGate).find(k => k.startsWith('?:contract'));
      assert.ok(ka && kb, `missing keys: ${ka} / ${kb}`);
      assert.notEqual(ka, kb, 'two different contract rules produced the same key');
    });
  });

  test('a missing statement span is named too', async () => {
    const r = await run({ ...base, statementText: '' });
    assert.ok(Object.keys(r.stats.byGate).some(k => k.includes('missing-statement-text')));
  });

  test('the key space stays BOUNDED — the predicate name never enters it', async () => {
    // `bad-modality:speculative` interpolates the value. Keying on the full
    // reason would grow the map with every value a model invents, on a hot
    // path. G6.
    const r = await run({ ...base, modality: 'speculative' });
    for (const k of Object.keys(r.stats.byGate)) {
      assert.ok(!k.includes(' '), `byGate key carries free text: ${k}`);
      assert.ok(!k.includes('speculative'), `byGate key carries a free value: ${k}`);
    }
  });

  test('an unregistered predicate is still a PROPOSAL, not a discard', async () => {
    // Unchanged behaviour, pinned because this edit sits directly beside it:
    // "unknown predicate → propose, don't force" is how the vocabulary grows.
    const r = await run({ ...base, predicate: 'enjoys_immensely' });
    assert.equal(r.stats.proposed, 1);
    assert.equal(r.stats.discarded, 0);
  });
});
