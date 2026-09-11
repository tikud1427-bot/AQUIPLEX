/**
 * UUS U0 — "capture truth" regression suite (node:test).
 * Run: node --test src/mind/tests/u0CaptureTruth.test.js
 *
 * Three defects, all reproduced against the shipped code before the fix:
 *
 *   1. WORD SENSE. `TECH_TERMS` was one flat regex containing ordinary English
 *      words. "go deep, don't over-explain" minted knowledge:tech:go — 3/3 on
 *      bare verbs. Noise in ordinary chat; on a first-run "here's what I
 *      understand about you" card it is the line that costs the user's trust.
 *
 *   2. COMPOUND ROLES. "I'm a founder and a software engineer" stored
 *      `profession = "founder"`. The `i_am_a` pattern terminates on `\s+and\b`.
 *
 *   3. EXPLICIT DECLARATIONS. A stated profession landed at confidence 0.35,
 *      because a new belief gets `0.25 + changeRate × strength` and identity's
 *      changeRate is 0.12 — correct for inference, wrong for a direct
 *      statement. `fromExplicit()` already existed; only correctBelief used it.
 *
 * Defects 1 and 2 are bug fixes and ship unflagged. Defect 3 changes stored
 * confidence for existing users, so it rides on AQUA_UUS.
 *
 * Proven to bite. Reverting all four production files to the shipped versions
 * fails 7 of these 18; each file is independently defended —
 *   observers.js       → 4 failing   (word sense + the explicit signal)
 *   beliefEngine.js    → 2 failing   (the explicit branch)
 *   memoryExtractor.js → 1 failing   (extractor provenance)
 *   memorySchema.js    → 1 failing   (compound roles)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEmptyMind, DIMENSIONS, STATUS, beliefKey } from '../mindSchema.js';
import { observeSignal, observeSignals, lockBelief } from '../beliefEngine.js';
import { observeTurn } from '../observers.js';
import { extractFactsWithReport } from '../../memory/memoryExtractor.js';

const techOf = (userMessage) =>
  observeTurn({ userMessage, taskType: 'conversation' }).hints.tech.slice().sort();

const professionOf = (msg) =>
  extractFactsWithReport(msg).facts.find(f => f.key === 'profession')?.value ?? null;

/** Run fn with AQUA_UUS set to `on` / absent, always restoring the prior value. */
function withUus(on, fn) {
  const prior = process.env.AQUA_UUS;
  if (on) process.env.AQUA_UUS = 'on'; else delete process.env.AQUA_UUS;
  try { return fn(); } finally {
    if (prior === undefined) delete process.env.AQUA_UUS; else process.env.AQUA_UUS = prior;
  }
}

// ── 1. Word sense ────────────────────────────────────────────────────────────

test('U0: the three reproduced false positives are gone', () => {
  // Verbatim from the audit. Each of these minted knowledge:tech:go.
  assert.deepEqual(techOf("Go deep, don't over-explain."), []);
  assert.deepEqual(techOf('I want to go to the beach.'), []);
  assert.deepEqual(techOf('Just go ahead.'), []);
});

test('U0: ordinary English uses of ambiguous terms never register as tech', () => {
  const nonTechnical = [
    'The rust on my bike is bad.',
    'I need to react to this feedback.',
    'Let me express my thanks.',
    'A node in the graph.',
    'The azure sky was clear.',
    'She is swift and clean.',
    'My daughter Ruby is six.',
    'The angular shape of the roof.',
    'He drank a flask of coffee.',
    'We flew home with a tailwind.',
  ];
  for (const msg of nonTechnical) {
    assert.deepEqual(techOf(msg), [], `should not detect tech in: ${msg}`);
  }
});

test('U0: genuine technical uses are still detected', () => {
  assert.deepEqual(techOf('I write Go every day.'), ['go']);       // preceding cue
  assert.deepEqual(techOf('I prefer Go.'), ['go']);
  assert.deepEqual(techOf('Go code is easy to read.'), ['go']);    // following cue
  assert.deepEqual(techOf('I code in Swift.'), ['swift']);
  assert.deepEqual(techOf('a React component'), ['react']);
  assert.deepEqual(techOf('an Express server'), ['express']);
  assert.deepEqual(techOf('I use tailwind.'), ['tailwind']);
  assert.deepEqual(techOf('deployed to Azure'), ['azure']);
});

test('U0: a stack listing qualifies its ambiguous members', () => {
  // Postgres is unambiguous and qualifies itself; React inherits across "+".
  assert.deepEqual(techOf('The React + Postgres stack stays.'), ['postgres', 'react']);
  // Rust qualifies via "write", then Go inherits across "and".
  assert.deepEqual(techOf('I write Rust and Go.'), ['go', 'rust']);
  assert.deepEqual(techOf('We use Go, Python and Rust.'), ['go', 'python', 'rust']);
});

test('U0: evidence must be LOCAL — a tech word elsewhere does not qualify one', () => {
  // The load-bearing negative. The tempting shortcut is "if the message
  // mentions any technology, read every candidate technically". It is wrong:
  // this sentence is about walking, and Python says nothing about that.
  // Without this the guard silently rots back into the original bug.
  assert.deepEqual(techOf('I go with Python daily.'), ['python']);
  assert.deepEqual(techOf('I want to go and learn Python.'), ['python']);
});

test('U0: unambiguous terms are unaffected by the guard', () => {
  assert.deepEqual(techOf('typescript'), ['typescript']);
  assert.deepEqual(techOf('kubernetes and terraform'), ['kubernetes', 'terraform']);
  // Normalization preserved exactly: node.js → node, next.js → nextjs.
  assert.deepEqual(techOf('node.js and typescript'), ['node', 'typescript']);
  assert.deepEqual(techOf('next.js'), ['nextjs']);
});

test('U0: the pre-existing observer expectation still holds', () => {
  // Pinned by mind.test.js too; duplicated here because this suite is the one
  // that would break it.
  const { hints } = observeTurn({
    userMessage: "Our investors want the demo simpler — it's too flashy. Keep it minimal. The React + Postgres stack stays.",
    taskType: 'planning',
  });
  assert.ok(hints.tech.includes('react') && hints.tech.includes('postgres'));
});

// ── 2. Compound roles ────────────────────────────────────────────────────────

test('U0: a compound role keeps both halves', () => {
  assert.equal(professionOf("I'm a founder and a software engineer."), 'founder and software engineer');
  assert.equal(professionOf("I'm a founder and software engineer."), 'founder and software engineer');
});

test('U0: a coordinated CLAUSE is not a job title', () => {
  // "I'm a developer and I love Rust" must fall through to the single-role
  // pattern rather than storing the whole clause as a profession.
  assert.equal(professionOf("I'm a developer and I love Rust."), 'developer');
});

test('U0: single roles are unchanged', () => {
  assert.equal(professionOf('I am a student.'), 'student');
  assert.equal(professionOf("I'm the founder of Aquiplex."), 'founder');
  // Intensity idiom still rejected by the profession schema.
  assert.equal(professionOf("I'm a bit tired."), null);
});

// ── 3. Explicit declarations ─────────────────────────────────────────────────

const schemaFact = { key: 'profession', value: 'founder', confidence: 0.85, extractor: 'schema' };
const fallbackFact = { key: 'favorite_editor', value: 'vim', confidence: 0.7, extractor: 'custom_fallback' };

function observeFacts(mind, extractedFacts) {
  const { signals } = observeTurn({ userMessage: 'x', taskType: 'conversation', extractedFacts });
  observeSignals(mind, signals);
  return mind;
}

test('U0: the extractor kind now survives into the fact', () => {
  // Without this, nothing downstream can tell a curated first-person schema
  // match from an opaque custom_ fallback.
  const { facts } = extractFactsWithReport("I'm a founder.");
  assert.equal(facts.find(f => f.key === 'profession')?.extractor, 'schema');
});

test('U0: flag OFF is byte-identical to the old behaviour', () => {
  withUus(false, () => {
    const mind = observeFacts(createEmptyMind('o'), [schemaFact]);
    const b = mind.beliefs[beliefKey(DIMENSIONS.IDENTITY, 'profession')];
    assert.equal(+b.confidence.toFixed(2), 0.35);   // 0.25 + 0.12 × 0.85
    assert.equal(b.privacy.source, 'fact_bridge');
  });
});

test('U0: flag ON gives a stated fact explicit standing', () => {
  withUus(true, () => {
    const mind = observeFacts(createEmptyMind('o'), [schemaFact]);
    const b = mind.beliefs[beliefKey(DIMENSIONS.IDENTITY, 'profession')];
    assert.equal(b.confidence, 0.9);
    assert.equal(b.privacy.source, 'explicit');
  });
});

test('U0: the custom_ fallback never earns explicit standing', () => {
  // The precision boundary. custom_fallback promotes transient states ("I'm
  // exhausted today") into durable facts; granting those 0.9 would amplify a
  // known precision problem rather than fix a confidence one.
  withUus(true, () => {
    const mind = observeFacts(createEmptyMind('o'), [fallbackFact]);
    const b = mind.beliefs[beliefKey(DIMENSIONS.PREFERENCES, 'editor')];
    assert.notEqual(b.privacy.source, 'explicit');
    assert.ok(b.confidence < 0.5, `fallback should stay inference-grade, got ${b.confidence}`);
  });
});

test('U0: ordinary inference is not inflated when the flag is on', () => {
  // The fix must not become a general confidence boost. A plain observation
  // signal keeps exactly the confidence it had before.
  withUus(true, () => {
    const mind = createEmptyMind('o');
    observeSignal(mind, { dimension: DIMENSIONS.KNOWLEDGE, key: 'tech:go', value: 'working_knowledge', strength: 0.35 });
    const b = mind.beliefs[beliefKey(DIMENSIONS.KNOWLEDGE, 'tech:go')];
    assert.ok(b.confidence < 0.4, `inference must stay inference, got ${b.confidence}`);
    assert.equal(b.privacy.source, 'inference');
  });
});

test('U0: a NEW belief from an explicit statement carries explicit provenance', () => {
  // The create branch inherited whatever source the caller passed, so a brand
  // new belief could hold 0.9 confidence while claiming something inferred it —
  // "confident" on the understanding card, next to the wrong reason. Found by
  // the U4 route test, pinned here where the behaviour lives.
  const mind = createEmptyMind('o');
  observeSignal(mind, { dimension: DIMENSIONS.IDENTITY, key: 'profession', value: 'founder', explicit: true });
  const b = mind.beliefs[beliefKey(DIMENSIONS.IDENTITY, 'profession')];
  assert.equal(b.confidence, 0.9);
  assert.equal(b.privacy.source, 'explicit');
});

test('U0: an explicit statement supersedes an inferred value and versions it', () => {
  const mind = createEmptyMind('o');
  observeSignal(mind, { dimension: DIMENSIONS.IDENTITY, key: 'profession', value: 'engineer', strength: 0.5 });
  observeSignal(mind, { dimension: DIMENSIONS.IDENTITY, key: 'profession', value: 'founder', explicit: true });
  const b = mind.beliefs[beliefKey(DIMENSIONS.IDENTITY, 'profession')];
  assert.equal(b.value, 'founder');
  assert.equal(b.confidence, 0.9);
  assert.equal(b.privacy.source, 'explicit');
  assert.equal(b.history.length, 1, 'prior value versioned, never overwritten');
  assert.equal(b.history[0].value, 'engineer');
});

test('U0: a user-pinned belief still wins over an explicit signal', () => {
  const mind = createEmptyMind('o');
  observeSignal(mind, { dimension: DIMENSIONS.IDENTITY, key: 'profession', value: 'engineer', strength: 0.5 });
  lockBelief(mind, DIMENSIONS.IDENTITY, 'profession', true);
  observeSignal(mind, { dimension: DIMENSIONS.IDENTITY, key: 'profession', value: 'founder', explicit: true });
  const b = mind.beliefs[beliefKey(DIMENSIONS.IDENTITY, 'profession')];
  assert.equal(b.value, 'engineer', 'lock is the user speaking; nothing outranks it');
});

test('U0: explicit applies to supporting evidence only', () => {
  // Nothing emits an explicit contradiction, and treating one as explicit
  // would let a single negative reading overwrite a stated fact.
  const mind = createEmptyMind('o');
  observeSignal(mind, { dimension: DIMENSIONS.IDENTITY, key: 'profession', value: 'founder', explicit: true });
  const before = mind.beliefs[beliefKey(DIMENSIONS.IDENTITY, 'profession')].confidence;
  observeSignal(mind, { dimension: DIMENSIONS.IDENTITY, key: 'profession', value: 'founder', explicit: true, support: false, strength: 0.5 });
  const after = mind.beliefs[beliefKey(DIMENSIONS.IDENTITY, 'profession')];
  assert.ok(after.confidence < before, 'contradiction still lowers confidence');
  assert.equal(after.status, STATUS.ACTIVE);
});
