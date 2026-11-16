/**
 * PWI Phase 1, fix 2 (2026-11-15) — the legacy veto when the canonical query
 * FAILS, by failure injection.
 *
 * Before: `legacyVetoFor` returned `() => true` on any query error — every
 * legacy fact and the whole identity card withheld for the turn (the P0
 * 2026-10-12 shape, for a database that passes the reachability probe and then
 * errors). After: the fallback veto = the owner's deletions (always) ∪ this
 * process's last successful canonical veto for the same owner (≤ 10 min).
 *
 * The database is a scripted fake pool (pool._setPoolForTests): it answers
 * owner-scoped rows, or throws the error a test injects — statement timeout,
 * connection reset, undefined table (schema drift).
 *
 * Invariants checked:
 *   · ordinary legacy facts are no longer suppressed on a query error
 *   · deleted information is never exposed: forgotten values, sentences,
 *     "forget everything" — on the fallback AND on the degraded read
 *   · nothing crosses owners: neither the snapshot nor the deletion list
 *   · the snapshot expires; account purge drops it
 *   · sensitive-category protection is untouched (the veto only removes)
 *   · the success path vetoes exactly as before the refactor
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-veto-fallback-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
process.env.AQUA_EMBEDDINGS = 'off';
process.env.DATABASE_URL = 'postgresql://aqua:aqua@127.0.0.1:1/aqua_fake';   // configured; every query goes to the fake below
delete process.env.AQUA_CANONICAL_READ;

const pool = await import('../../core/db/pool.js');
pool._resetForTests();
const Brain = await import('../index.js');
const R = await import('../../memory/recallRedactions.js');
const mem = await import('../../memory/engine.js');
const { storeFact } = await import('../../memory/longTermMemory.js');
const { sensitivePolicy } = await import('../../memory/sensitivity.js');

const A = 'user:veto-a';
const B = 'user:veto-b';

// ── the scripted database ────────────────────────────────────────────────────
let inject = null;          // an Error to throw on every query, or null
const queriedOwners = [];
const DB = {
  [A]: {
    archived: ['c-maya'],
    claims: [
      { claim_id: 'c-work', predicate: 'works_at', polarity: 'asserted', state: 'active', modality: 'fact', subject_type: 'self', subj: 'you', val: 'northbeam' },
      { claim_id: 'c-city', predicate: 'located_in', polarity: 'asserted', state: 'superseded', modality: 'fact', subject_type: 'self', subj: 'you', val: 'lisbon' },
      { claim_id: 'c-maya', predicate: 'related_to', polarity: 'asserted', state: 'archived', modality: 'fact', subject_type: 'person', subj: 'maya', val: 'co-founder' },
    ],
  },
  [B]: { archived: [], claims: [] },
};
const FAKE_POOL = {
  async query(sql, params = []) {
    if (inject) throw inject;
    const owner = params[0];
    queriedOwners.push(owner);
    const d = DB[owner] ?? { archived: [], claims: [] };
    if (/aqua_lifecycle_transitions/.test(sql)) return { rows: d.archived.map(id => ({ id })) };
    if (/FROM aqua_claims c/.test(sql)) return { rows: d.claims };
    return { rows: [] };
  },
};
pool._setPoolForTests(FAKE_POOL);

const ERRORS = {
  timeout: Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
  reset: Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' }),
  drift: Object.assign(new Error('relation "aqua_lifecycle_transitions" does not exist'), { code: '42P01' }),
};

const quiet = async fn => {
  const orig = console.warn; const lines = [];
  console.warn = (...a) => lines.push(a.join(' '));
  try { return { value: await fn(), lines }; } finally { console.warn = orig; }
};

beforeEach(() => { inject = null; queriedOwners.length = 0; Brain._resetVetoSnapshotsForTests(); R.__resetForTests(); });

// ── the fix ──────────────────────────────────────────────────────────────────

for (const [name, err] of Object.entries(ERRORS)) {
  test(`injected ${name} (${err.code}): ordinary legacy facts are NOT suppressed (was: every fact vetoed)`, async () => {
    inject = err;
    const { value: veto, lines } = await quiet(() => Brain.legacyVetoFor(A));
    assert.equal(veto({ key: 'name', value: 'Ana' }), false);
    assert.equal(veto({ key: 'workplace', value: 'Nummo' }), false);
    assert.equal(veto({ key: 'goal', value: ['launch the app', 'hire a designer'] }), false);
    assert.ok(lines.some(l => l.includes('serving the fallback veto') && l.includes(`(${err.code})`)), 'the degradation is logged with the error code');
    assert.ok(!lines.join(' ').includes(A), 'the raw owner id is not logged');
  });
}

test('deleted information is never exposed: a forgotten value stays withheld on a failed query', async () => {
  // What memory/forget.js records: the forgotten VALUES and the sentence (forgetClaim: values + statement).
  R.redactPhrases(A, ['Nummo', 'Dev', 'My co-founder Dev runs engineering']);
  inject = ERRORS.timeout;
  const { value: veto } = await quiet(() => Brain.legacyVetoFor(A));
  assert.equal(veto({ key: 'workplace', value: 'Nummo' }), true);
  assert.equal(veto({ key: 'workplace', value: 'nummo' }), true, 'case-insensitive');
  assert.equal(veto({ key: 'organization', value: { name: 'Nummo Labs' } }), true, 'a value containing the forgotten phrase');
  assert.equal(veto({ key: 'cofounder', value: 'Dev' }), true, 'the forgotten person');
  assert.equal(veto({ key: 'cofounder', value: ['Dev', 'Ana'] }), true, 'a collection holding a forgotten item');
  // Known limit (hashes, not text): a value that is only a FRAGMENT of a longer forgotten
  // phrase is not detectable. Every forget path records the values themselves, so this
  // matters only for a value no forget ever named.
  assert.equal(veto({ key: 'cofounder', value: 'runs engineering' }), false);
  assert.equal(veto({ key: 'city', value: 'Bangalore' }), false, 'other facts still answer');
});

test('deleted information is never exposed: "forget everything" withholds every fact stated before it', async () => {
  const at = Date.now();
  R.redactAllBefore(A, at);
  inject = ERRORS.reset;
  const { value: veto } = await quiet(() => Brain.legacyVetoFor(A));
  assert.equal(veto({ key: 'city', value: 'Bangalore', ts: at - 1000 }), true);
  assert.equal(veto({ key: 'city', value: 'Porto', ts: at + 1000 }), false, 'said after the forget');
});

test('a fresh snapshot of the last successful query keeps the canonical veto through a failure', async () => {
  const t0 = 1_000_000;
  const ok = await Brain.legacyVetoFor(A, { now: t0 });
  inject = ERRORS.timeout;
  const { value: fb, lines } = await quiet(() => Brain.legacyVetoFor(A, { now: t0 + 60_000 }));
  for (const item of [
    { key: 'workplace', value: 'Fintrail' },     // canonical holds a current works_at
    { key: 'city', value: 'Lisbon' },            // superseded canonically
    { key: 'cofounder', value: 'Maya' },         // claim about Maya archived by the user
    { key: 'cofounder', value: 'And' },          // the deleted role's slot
    { key: 'name', value: 'Ana' },
  ]) assert.equal(fb(item), ok(item), `${item.key}=${item.value}: fallback must equal the last successful veto`);
  assert.ok(lines.some(l => l.includes('canonical snapshot ageMs=60000')));
});

test('the snapshot expires after 10 minutes: then deletions only', async () => {
  const t0 = 2_000_000;
  await Brain.legacyVetoFor(A, { now: t0 });
  inject = ERRORS.timeout;
  const { value: fb, lines } = await quiet(() => Brain.legacyVetoFor(A, { now: t0 + 10 * 60_000 + 1 }));
  assert.equal(fb({ key: 'city', value: 'Lisbon' }), false);
  assert.ok(lines.some(l => l.includes('deletions only')));
});

test('nothing crosses owners: A\'s snapshot and A\'s deletions never veto B, and each query is scoped to its owner', async () => {
  await Brain.legacyVetoFor(A);
  R.redactPhrases(A, ['Nummo']);
  assert.deepEqual(queriedOwners.filter(o => o !== A), [], 'every query carried owner A only');
  inject = ERRORS.timeout;
  const { value: vb } = await quiet(() => Brain.legacyVetoFor(B));
  assert.equal(vb({ key: 'workplace', value: 'Nummo' }), false, 'A forgot Nummo, B did not');
  assert.equal(vb({ key: 'city', value: 'Lisbon' }), false, 'A\'s superseded value is not B\'s');
  assert.equal(vb({ key: 'workplace', value: 'Fintrail' }), false, 'A\'s current employer claim is not B\'s');
  assert.deepEqual(Brain._vetoSnapshotOwnersForTests(), [A]);
});

test('account purge drops the owner\'s snapshot', async () => {
  await Brain.legacyVetoFor(A);
  assert.deepEqual(Brain._vetoSnapshotOwnersForTests(), [A]);
  Brain.purgeOwner(A);
  assert.deepEqual(Brain._vetoSnapshotOwnersForTests(), []);
});

test('success path unchanged: the canonical veto decides exactly as before', async () => {
  const veto = await Brain.legacyVetoFor(A);
  assert.equal(veto({ key: 'workplace', value: 'Anything' }), true, 'current self works_at owns the attribute');
  assert.equal(veto({ key: 'organization', value: 'Anything' }), true);
  assert.equal(veto({ key: 'city', value: 'Lisbon' }), true, 'superseded value');
  assert.equal(veto({ key: 'city', value: 'Porto' }), false);
  assert.equal(veto({ key: 'cofounder', value: 'Maya' }), true, 'user-archived subject');
  assert.equal(veto({ key: 'cofounder', value: 'And' }), true, 'deleted role slot');
  assert.equal(veto({ key: 'name', value: 'Ana' }), false);
});

test('no database configured: no veto, no query (unchanged)', async () => {
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL; pool._resetForTests();
  try {
    const v = await Brain.legacyVetoFor(A);
    assert.equal(v({ key: 'workplace', value: 'Nummo' }), false);
    assert.deepEqual(queriedOwners, []);
  } finally {
    process.env.DATABASE_URL = saved; pool._resetForTests();
    pool._setPoolForTests(FAKE_POOL);
  }
});

// ── end to end through memoryRetrieve (the answer path's retrieval) ──────────

test('memoryRetrieve on a failed query: facts and identity reach the block, the forgotten one does not, sensitive stays withheld', async () => {
  const O = 'user:veto-e2e';
  DB[O] = { archived: [], claims: [] };
  for (const t of ["I'm Priya.", 'I work at Kestrel Analytics.', 'My co-founder Dev runs engineering.']) {
    mem.memoryObserve(O, { userMessage: t, taskType: 'personal_info', conversationId: 'c-veto', userId: 'veto-e2e', requestId: 'seed' });
  }
  // A value deleted earlier (while the database was up) whose legacy copy came back.
  R.redactPhrases(O, ['Dev']);
  storeFact(O, { key: 'cofounder', category: 'relationship', value: 'Dev', confidence: 0.9, importance: 7, sourceText: 'My co-founder Dev runs engineering.', ts: Date.now() });
  storeFact(O, { key: 'custom_condition', category: 'health', value: 'generalized anxiety', confidence: 0.9, importance: 6, sensitivity: 'health', ts: Date.now() });

  inject = ERRORS.timeout;
  const { value: veto } = await quiet(() => Brain.legacyVetoFor(O));
  const r = mem.memoryRetrieve(O, {
    query: 'What is my name, where do I work, who is my co-founder, and how is my anxiety?', taskType: 'memory_recall',
    legacyUserMemory: 'gapfill', legacyVeto: veto,
    sensitive: sensitivePolicy({ rememberSensitive: false, message: 'where do I work' }),
  });
  assert.match(r.block, /Priya/, 'identity card served (was withheld whole)');
  assert.match(r.block, /Kestrel/i, 'ordinary fact served');
  assert.doesNotMatch(r.block, /\bDev\b/, 'deleted value withheld');
  assert.doesNotMatch(r.block, /anxiety/i, 'sensitive fact withheld without opt-in');
});

test('degraded read (database unreachable): the deletion veto applies there too', async () => {
  const O = 'user:veto-degraded';
  mem.memoryObserve(O, { userMessage: "I'm Tomas. I work at Brightwell.", taskType: 'personal_info', conversationId: 'c-deg', userId: 'veto-degraded', requestId: 'seed' });
  R.redactPhrases(O, ['Brightwell']);
  const r = mem.memoryRetrieve(O, { query: 'Where do I work and what is my name?', taskType: 'memory_recall', legacyUserMemory: true, legacyVeto: Brain.deletionVetoFor(O) });
  assert.match(r.block, /Tomas/);
  assert.doesNotMatch(r.block, /Brightwell/);
});
