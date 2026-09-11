/**
 * Memory 5.1 — Memory Editor
 * Run: node --test src/memory/tests/memoryEditor.test.js
 *
 * Contract under test: every edit is versioned (never a silent overwrite),
 * archive ≠ delete, merge/split preserve provenance, and each op bridges a
 * `memory`-kind revision into the PIC version store (gated on AQUA_PIC).
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-memedit-'));
process.env.AQUA_DATA_DIR = tmp;
process.chdir(tmp);

const OWNER = 'user:edit-tester';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let ltm, editor, versionStore;

before(async () => {
  ltm          = await import('../longTermMemory.js');
  editor       = await import('../memoryEditor.js');
  versionStore = await import('../../pic/versionStore.js');
});

// ── correct / replace ────────────────────────────────────────────────────────

test('correctFact creates a pinned fact when none exists', () => {
  const r = editor.correctFact(OWNER, 'favorite_editor', 'neovim');
  assert.equal(r.ok, true);
  const f = ltm.getFact(OWNER, r.key);
  assert.equal(f.value, 'neovim');
  assert.equal(f.pinned, true);           // corrections pin (Phase A semantics)
  assert.equal(f.confidence, 0.95);
});

test('correctFact over an existing value keeps the prior in history', () => {
  editor.correctFact(OWNER, 'favorite_color', 'blue');
  const r = editor.correctFact(OWNER, 'favorite_color', 'teal', { reason: 'user said so' });
  assert.equal(r.ok, true);
  const f = ltm.getFact(OWNER, r.key);
  assert.equal(f.value, 'teal');
  assert.equal(f.revision >= 2, true);
  const hist = ltm.getFactHistory(OWNER, r.key);
  assert.equal(hist.length >= 1, true);
  assert.equal(hist[hist.length - 1].value, 'blue');   // never silently overwritten
});

test('replaceFact applies contradiction-damped confidence and does not pin', () => {
  // Build support: same value three times → supportCount grows.
  ltm.storeFact(OWNER, { key: 'primary_db', value: 'mongodb', confidence: 0.9, importance: 6, ts: Date.now() });
  ltm.storeFact(OWNER, { key: 'primary_db', value: 'mongodb', confidence: 0.9, importance: 6, ts: Date.now() });
  ltm.storeFact(OWNER, { key: 'primary_db', value: 'mongodb', confidence: 0.9, importance: 6, ts: Date.now() });
  const before_ = ltm.getFact(OWNER, 'primary_db');
  assert.equal(before_.supportCount >= 3, true);

  const r = editor.replaceFact(OWNER, 'primary_db', 'postgres', { confidence: 0.9 });
  assert.equal(r.ok, true);
  const f = ltm.getFact(OWNER, 'primary_db');
  assert.equal(f.value, 'postgres');
  assert.equal(f.confidence < 0.9, true);              // damped vs established value
  assert.equal(!!f.pinned, false);
  assert.equal(ltm.getFactHistory(OWNER, 'primary_db').some(h => h.value === 'mongodb'), true);
});

test('edits reject empty values', () => {
  assert.equal(editor.correctFact(OWNER, 'x', '').ok, false);
  assert.equal(editor.replaceFact(OWNER, 'x', null).ok, false);
});

// ── pin / archive / restore ──────────────────────────────────────────────────

test('pin and unpin toggle; repeat is a no-op with unchanged flag', () => {
  editor.replaceFact(OWNER, 'shell', 'zsh');
  const key = 'shell';
  assert.equal(editor.pinFact(OWNER, key, true).ok, true);
  assert.equal(ltm.getFact(OWNER, key).pinned, true);
  assert.equal(editor.pinFact(OWNER, key, true).unchanged, true);
  assert.equal(editor.pinFact(OWNER, key, false).ok, true);
  assert.equal(ltm.getFact(OWNER, key).pinned, false);
});

test('archive refuses pinned facts unless forced; archive != delete', () => {
  editor.correctFact(OWNER, 'homeland_ide', 'vscode');       // pinned by correction
  const key = 'homeland_ide';
  const refused = editor.archiveFact(OWNER, key);
  assert.equal(refused.ok, false);
  const forced = editor.archiveFact(OWNER, key, { force: true, reason: 'test_force' });
  assert.equal(forced.ok, true);

  const activeKeys = ltm.getFacts(OWNER).map(f => f.key);
  assert.equal(activeKeys.includes(key), false);             // gone from active view
  const allKeys = ltm.getFacts(OWNER, { includeArchived: true }).map(f => f.key);
  assert.equal(allKeys.includes(key), true);                 // still on disk
  const f = ltm.getFact(OWNER, key);
  assert.equal(f.status, 'archived');
  assert.equal(f.history.some(h => h.reason === 'test_force'), true); // snapshotted

  assert.equal(editor.restoreFact(OWNER, key).ok, true);
  assert.equal(ltm.getFact(OWNER, key).status, 'active');
});

// ── merge ────────────────────────────────────────────────────────────────────

test('mergeFacts: survivor absorbs support, losers archived with supersededBy', () => {
  ltm.storeFact(OWNER, { key: 'workplace',    value: 'Aquiplex', confidence: 0.95, importance: 8, ts: Date.now() });
  ltm.storeFact(OWNER, { key: 'company_name', value: 'Aquiplex', confidence: 0.7,  importance: 5, ts: Date.now() });
  ltm.storeFact(OWNER, { key: 'employer',     value: 'aquiplex', confidence: 0.6,  importance: 5, ts: Date.now() });

  const r = editor.mergeFacts(OWNER, ['workplace', 'company_name', 'employer']);
  assert.equal(r.ok, true);
  assert.equal(r.survivor.key, 'workplace');               // highest confidence wins
  assert.equal(r.survivor.supportCount >= 3, true);        // union of support
  assert.deepEqual([...r.archived].sort(), ['company_name', 'employer']);

  for (const k of r.archived) {
    const loser = ltm.getFact(OWNER, k);
    assert.equal(loser.status, 'archived');
    assert.equal(loser.supersededBy, 'workplace');
    assert.equal(loser.history.some(h => String(h.reason).startsWith('merged_into:')), true);
  }
  const survivor = ltm.getFact(OWNER, 'workplace');
  assert.equal(survivor.mergedFrom.includes('employer'), true);
  assert.equal(survivor.history.some(h => String(h.reason).startsWith('merge_absorbed:')), true);
  assert.equal(ltm.getFacts(OWNER).some(f => f.key === 'employer'), false); // hidden from active
});

test('mergeFacts respects intoKey and propagates a pinned loser', () => {
  ltm.storeFact(OWNER, { key: 'city_a', value: 'Tezpur', confidence: 0.9, importance: 6, ts: Date.now() });
  ltm.storeFact(OWNER, { key: 'city_b', value: 'tezpur', confidence: 0.6, importance: 5, ts: Date.now() });
  editor.pinFact(OWNER, 'city_b', true);

  const r = editor.mergeFacts(OWNER, ['city_a', 'city_b'], { intoKey: 'city_a' });
  assert.equal(r.ok, true);
  assert.equal(r.survivor.key, 'city_a');
  assert.equal(r.survivor.pinned, true);                   // pin survives the merge
});

test('mergeFacts fails when fewer than two keys exist', () => {
  assert.equal(editor.mergeFacts(OWNER, ['nope_1', 'nope_2']).ok, false);
  assert.equal(editor.mergeFacts(OWNER, ['workplace']).ok, false);
});

// ── split ────────────────────────────────────────────────────────────────────

test('splitFact archives the source and creates provenance-carrying parts', () => {
  ltm.storeFact(OWNER, {
    key: 'tech_stack', value: 'node and react', confidence: 0.8, importance: 7,
    ts: Date.now(), sourceConversation: 'conv-split-1', sourceText: 'my stack is node and react',
  });
  const r = editor.splitFact(OWNER, 'tech_stack', [
    { key: 'backend_stack',  value: 'node' },
    { key: 'frontend_stack', value: 'react' },
  ]);
  assert.equal(r.ok, true);
  const source = ltm.getFact(OWNER, 'tech_stack');
  assert.equal(source.status, 'archived');
  assert.equal(source.splitInto.length, 2);
  assert.equal(source.history.some(h => h.reason === 'manual_split'), true);

  for (const partKey of source.splitInto) {
    const part = ltm.getFact(OWNER, partKey);
    assert.ok(part, `part ${partKey} exists`);
    assert.equal(part.metadata.splitFrom, 'tech_stack');
    assert.equal(part.sourceConversation, 'conv-split-1');  // provenance inherited
    assert.equal(part.status, 'active');
  }
});

test('splitFact validates parts (count, values, duplicate keys)', () => {
  ltm.storeFact(OWNER, { key: 'hobby_pair', value: 'chess and go', confidence: 0.8, importance: 5, ts: Date.now() });
  assert.equal(editor.splitFact(OWNER, 'hobby_pair', [{ key: 'only_one', value: 'chess' }]).ok, false);
  assert.equal(editor.splitFact(OWNER, 'hobby_pair', [
    { key: 'dup', value: 'chess' }, { key: 'dup', value: 'go' },
  ]).ok, false);
  assert.equal(editor.splitFact(OWNER, 'hobby_pair', [
    { key: 'a_ok', value: 'chess' }, { key: 'b_bad' },
  ]).ok, false);
  assert.equal(ltm.getFact(OWNER, 'hobby_pair').status, 'active'); // untouched on failure
});

// ── PIC bridge ───────────────────────────────────────────────────────────────

test('edits bridge memory-kind revisions into the PIC version store', async () => {
  const r = editor.correctFact(OWNER, 'bridge_probe', 'v1');
  assert.equal(r.ok, true);
  await sleep(30);                                          // fire-and-forget import settles
  const revs = versionStore.getHistory(OWNER, `memfact:${r.key}`);
  assert.equal(revs.length >= 1, true);
  assert.equal(revs[0].kind, 'memory');
  assert.equal(revs[revs.length - 1].after, 'v1');
});

test('AQUA_PIC=off disables the bridge (kill switch honored)', async () => {
  process.env.AQUA_PIC = 'off';
  try {
    const r = editor.correctFact(OWNER, 'dark_probe', 'v1');
    assert.equal(r.ok, true);                               // the edit itself still lands
    await sleep(30);
    assert.equal(versionStore.getHistory(OWNER, `memfact:${r.key}`).length, 0);
  } finally {
    delete process.env.AQUA_PIC;
  }
});
