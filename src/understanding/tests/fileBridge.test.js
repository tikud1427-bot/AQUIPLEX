/**
 * UUS U3 — file understanding → the Mind (node:test).
 *
 * THE DEFECT
 * ----------
 * `mindObserve` had exactly one caller: the chat pipeline. `fileEngine.js` and
 * `routes/upload.js` contained zero `mind` references, so uploading a README, a
 * pitch deck or a resume filled the evidence store, the graph and the PIC and
 * produced no beliefs, no goals, no identity — while both the world-model card
 * and the Understanding dashboard render Mind data.
 *
 * WHAT MOST OF THIS SUITE ACTUALLY GUARDS
 * ---------------------------------------
 * Restraint. Bridging files to beliefs is easy; the hard part is not burying
 * three true things about a person under two hundred package names from a
 * codebase upload. Most tests below assert what does NOT get written.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-u3-'));

const { toSignals, toGoalTitles, readUko } = await import('../fileBridge.js');
const { observeIngest } = await import('../observeIngest.js');
const { DIMENSIONS, createEmptyMind, beliefKey } = await import('../../mind/mindSchema.js');
const { observeSignals } = await import('../../mind/beliefEngine.js');

const uko = (over = {}) => ({
  id: 'uko_1',
  structuredContent: { title: 'README.md' },
  entities: [], topics: [], timeline: [], facts: [],
  ...over,
});

function withUus(on, fn) {
  const prior = process.env.AQUA_UUS;
  if (on) process.env.AQUA_UUS = 'on'; else delete process.env.AQUA_UUS;
  try { return fn(); } finally {
    if (prior === undefined) delete process.env.AQUA_UUS; else process.env.AQUA_UUS = prior;
  }
}

// ── 1. It learns something ───────────────────────────────────────────────────

test('U3: a README teaches the Mind what the person works with', () => {
  const signals = toSignals(uko({
    entities: [
      { type: 'technology', value: 'PostgreSQL', count: 6 },
      { type: 'language', value: 'TypeScript', count: 11 },
    ],
    topics: [{ topic: 'distributed systems', weight: 0.8 }],
  }));

  const keys = signals.map(s => s.key);
  assert.ok(keys.includes('tech:postgresql'));
  assert.ok(keys.includes('tech:typescript'));
  assert.ok(keys.includes('domain:distributed_systems'));
  assert.ok(signals.every(s => s.dimension === DIMENSIONS.KNOWLEDGE));
});

test('U3: a roadmap yields goals', () => {
  const titles = toGoalTitles(uko({
    timeline: [
      { order: 1, event: 'Q3 goal: ship the public beta', source: 'roadmap' },
      { order: 2, event: 'Tuesday standup moved to 10am', source: 'notes' },
    ],
  }));
  assert.deepEqual(titles, ['Q3 goal: ship the public beta']);
});

test('U3: signals reach the Mind through the one belief writer', () => {
  const mind = createEmptyMind('o');
  observeSignals(mind, toSignals(uko({ entities: [{ type: 'technology', value: 'Redis', count: 4 }] })));
  const b = mind.beliefs[beliefKey(DIMENSIONS.KNOWLEDGE, 'tech:redis')];
  assert.ok(b, 'belief written');
  assert.equal(b.privacy.source, 'fact_bridge');
});

// ── 2. Restraint — what must NOT be written ──────────────────────────────────

test('U3: a single passing mention is not knowledge', () => {
  // "We could try Kafka someday" appears once. Once is a mention, not a skill.
  const signals = toSignals(uko({ entities: [{ type: 'technology', value: 'Kafka', count: 1 }] }));
  assert.deepEqual(signals, []);
});

test('U3: a codebase upload cannot flood the dashboard', () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ type: 'technology', value: `pkg${i}`, count: 50 - (i % 40) }));
  const signals = toSignals(uko({ entities: many, topics: Array.from({ length: 40 }, (_, i) => ({ topic: `t${i}`, weight: 0.9 })) }));
  assert.ok(signals.length <= 13, `expected a hard ceiling, got ${signals.length}`);
});

test('U3: people and organisations in a document are NOT the user\'s relationships', () => {
  // A citation list is not a colleague list; "AWS" in a README is not an
  // employer. The graph already holds these with real provenance — promoting
  // them to beliefs is where a document starts inventing a social life.
  const signals = toSignals(uko({
    entities: [
      { type: 'person', value: 'Ada Lovelace', count: 9 },
      { type: 'org', value: 'AWS', count: 12 },
      { type: 'date', value: '2024-01-01', count: 5 },
      { type: 'url', value: 'https://example.com', count: 7 },
    ],
  }));
  assert.deepEqual(signals, []);
});

test('U3: a low-confidence topic does not become a belief', () => {
  assert.deepEqual(toSignals(uko({ topics: [{ topic: 'misc', weight: 0.2 }] })), []);
});

test('U3: file evidence stays weaker than a person saying it', () => {
  // If a README could outrank its author, correcting AQUA would mean deleting
  // files. Every file signal must sit below conversational strength.
  const signals = toSignals(uko({ entities: [{ type: 'technology', value: 'Go', count: 30 }] }));
  assert.ok(signals[0].strength < 0.5, `file strength ${signals[0].strength} must stay below conversational`);
  assert.equal(signals[0].source, 'fact_bridge');
  assert.notEqual(signals[0].source, 'explicit');
});

test('U3: topic strength scales with the pipeline\'s own confidence', () => {
  const strong = toSignals(uko({ topics: [{ topic: 'compilers', weight: 0.9 }] }))[0];
  const weak = toSignals(uko({ topics: [{ topic: 'compilers', weight: 0.55 }] }))[0];
  assert.ok(strong.strength > weak.strength, 'discarding the only calibration available would be a waste');
});

test('U3: a spreadsheet of numbers produces no goals', () => {
  const titles = toGoalTitles(uko({
    facts: [{ text: 'Revenue in March was 41,200' }, { text: 'April was 38,900' }],
    timeline: [{ order: 1, event: 'March', source: 'sheet1' }],
  }));
  assert.deepEqual(titles, []);
});

test('U3: malformed input never throws', () => {
  // This runs on the upload path. A crash here is a failed upload.
  for (const bad of [null, undefined, {}, { entities: null, topics: null }, { entities: [null, {}] }]) {
    assert.deepEqual(readUko(bad).signals.length >= 0, true);
    assert.ok(Array.isArray(toGoalTitles(bad)));
  }
});

// ── 3. The write seam ────────────────────────────────────────────────────────

test('U3: the seam is inert with the flag off', () => {
  withUus(false, () => {
    assert.deepEqual(observeIngest({ ownerId: 'o', ukoIds: ['u1'] }), { ok: false, skipped: 'disabled' });
  });
});

test('U3: nothing to read is not an error', () => {
  withUus(true, () => {
    assert.equal(observeIngest({ ownerId: 'o', ukoIds: [] }).skipped, 'nothing-to-read');
    assert.equal(observeIngest({ ownerId: null, ukoIds: ['u1'] }).skipped, 'nothing-to-read');
  });
});

test('U3: the write is deferred — the upload response never waits on it', async () => {
  await withUus(true, async () => {
    let deferred = null;
    let wrote = false;
    const mind = createEmptyMind('o');
    const res = observeIngest({
      ownerId: 'o', ukoIds: ['u1'],
      deps: {
        defer: (fn) => { deferred = fn; },
        getMind: () => mind,
        getUKO: () => uko({ entities: [{ type: 'technology', value: 'Redis', count: 5 }] }),
        observeSignals: (m, s) => { wrote = true; return observeSignals(m, s); },
        trackGoals: () => [],
      },
    });
    assert.deepEqual(res, { ok: true, files: 1 });
    assert.equal(wrote, false, 'nothing written before the deferred callback runs');
    deferred();
    assert.equal(wrote, true);
    assert.ok(mind.beliefs[beliefKey(DIMENSIONS.KNOWLEDGE, 'tech:redis')]);
  });
});

test('U3: one bad file does not stop the others', () => {
  withUus(true, () => {
    let deferred = null;
    const mind = createEmptyMind('o');
    const seen = [];
    observeIngest({
      ownerId: 'o', ukoIds: ['bad', 'good'],
      deps: {
        defer: (fn) => { deferred = fn; },
        getMind: () => mind,
        getUKO: (_o, id) => {
          if (id === 'bad') throw new Error('corrupt');
          return uko({ entities: [{ type: 'technology', value: 'Vite', count: 3 }] });
        },
        observeSignals: (m, s) => { seen.push(...s); return s; },
        trackGoals: () => [],
      },
    });
    deferred();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].key, 'tech:vite');
  });
});

test('U3: a throwing store fails open — never propagates to the upload', () => {
  withUus(true, () => {
    let deferred = null;
    observeIngest({
      ownerId: 'o', ukoIds: ['u1'],
      deps: { defer: (fn) => { deferred = fn; }, getMind: () => { throw new Error('store down'); } },
    });
    assert.doesNotThrow(() => deferred());
  });
});

test('U3: goals route through trackGoals, never written directly', () => {
  // trackGoals owns goal identity, fuzzy matching and confidence. A second
  // write path would create duplicates that look like the user set the same
  // goal twice.
  withUus(true, () => {
    let deferred = null;
    const calls = [];
    observeIngest({
      ownerId: 'o', ukoIds: ['u1'],
      deps: {
        defer: (fn) => { deferred = fn; },
        getMind: () => createEmptyMind('o'),
        getUKO: () => uko({ timeline: [{ order: 1, event: 'Goal: launch the beta', source: 'roadmap' }] }),
        observeSignals: () => [],
        trackGoals: (_m, arg) => { calls.push(arg); return ['g1']; },
      },
    });
    deferred();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].extractedFacts, [{ key: 'goal', value: 'Goal: launch the beta' }]);
  });
});

test('U3: fileBridge is pure — it cannot reach a store', async () => {
  const src = fs.readFileSync(new URL('../fileBridge.js', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map(m => m[1]);
  assert.deepEqual(imports, ['../mind/mindSchema.js'],
    'the translator must import the schema and nothing else');
});
