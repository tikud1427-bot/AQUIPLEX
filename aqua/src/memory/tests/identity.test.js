/**
 * AQUA Cognitive Identity — Acceptance Tests
 * Run: node --test src/memory/tests/identity.test.js
 *
 * Proves the v4 redesign: identity is canonical structured state, not semantic
 * recall. Runs against a TEMP cwd so the real .aqua-mind.json is never touched
 * (stores resolve their path from process.cwd() at module-load, so chdir must
 * precede the dynamic imports).
 *
 * Coverage:
 *   • extraction — every name form incl. MULTI-WORD, role+company, founded,
 *     work-at, live-in, age, call-me→preferred_name, aliases
 *   • field isolation — changing company/role never erases name (the core bug)
 *   • collection merge — aliases accumulate
 *   • retrieval BYPASS — identity answered from canonical state, never the
 *     ranker, even when crowded by higher-importance facts / tiny factLimit
 *   • cross-conversation — identity set in chat A is visible from chat B
 *   • conflict resolution — explicit correction overwrites + keeps history
 *   • custom de-collision — two unrelated "I'm a X" traits coexist
 *   • migration — legacy custom_trait blob → canonical identity / de-collided
 *   • regressions — the two headline examples from the spec
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-identity-'));
const repoRoot = process.cwd();
process.chdir(tmp);

let engine, ltm, identity, mindStore, idMigrate, extractor;

before(async () => {
  engine     = await import(path.join(repoRoot, 'src/memory/engine.js'));
  ltm        = await import(path.join(repoRoot, 'src/memory/longTermMemory.js'));
  identity   = await import(path.join(repoRoot, 'src/memory/identity.js'));
  mindStore  = await import(path.join(repoRoot, 'src/mind/mindStore.js'));
  idMigrate  = await import(path.join(repoRoot, 'src/memory/identityMigration.js'));
  extractor  = await import(path.join(repoRoot, 'src/memory/memoryExtractor.js'));
});

const tick = () => new Promise(r => setTimeout(r, 4)); // ensure monotonic ts across observes
const findKey = (facts, key) => facts.find(f => f.key === key);

// ── Extraction (pure, no owner) ───────────────────────────────────────────────
test('extraction — every introduction form (incl. multi-word) yields the right identity keys', () => {
  assert.equal(findKey(extractor.extractFacts('My name is John'), 'name').value, 'John');
  assert.equal(findKey(extractor.extractFacts("I'm Chhanda Prabal Das"), 'name').value, 'Chhanda Prabal Das');
  assert.equal(findKey(extractor.extractFacts('I am Ada Lovelace, nice to meet you'), 'name').value, 'Ada Lovelace');
  assert.equal(findKey(extractor.extractFacts('This is Grace Hopper'), 'name').value, 'Grace Hopper');

  // "I'm Chhanda from Assam" must NOT absorb the trailing prepositional phrase
  const fromCase = extractor.extractFacts("I'm Chhanda from Assam");
  assert.equal(findKey(fromCase, 'name').value, 'Chhanda');

  // preferred_name is its own field
  assert.equal(findKey(extractor.extractFacts('call me Chey'), 'preferred_name').value, 'Chey');
  assert.equal(findKey(extractor.extractFacts('I go by Sam'), 'preferred_name').value, 'Sam');
  assert.equal(findKey(extractor.extractFacts('call me Chey'), 'name'), undefined); // no legal-name clobber
});

test('extraction — role + company split from a single statement', () => {
  const f1 = extractor.extractFacts("I'm the founder of Aquiplex");
  assert.equal(findKey(f1, 'profession').value, 'founder');
  assert.equal(findKey(f1, 'workplace').value, 'Aquiplex');

  const f2 = extractor.extractFacts('I founded Aquiplex');
  assert.equal(findKey(f2, 'profession').value, 'Founder');
  assert.equal(findKey(f2, 'workplace').value, 'Aquiplex');
  assert.equal(findKey(f2, 'project').value, 'Aquiplex'); // still ALSO a project

  const f3 = extractor.extractFacts('I co-founded Aquiplex with Chhanda');
  assert.equal(findKey(f3, 'profession').value, 'Co-founder');
  assert.equal(findKey(f3, 'workplace').value, 'Aquiplex');
});

test('extraction — age, location, work-at, aliases', () => {
  assert.equal(findKey(extractor.extractFacts("I'm 29 years old"), 'age').value, 29);
  assert.equal(findKey(extractor.extractFacts('I live in Bangalore, India'), 'city').value, 'Bangalore');
  assert.equal(findKey(extractor.extractFacts('I work at Aquiplex'), 'workplace').value, 'Aquiplex');
  assert.ok(findKey(extractor.extractFacts('You can also call me CP'), 'aliases').value.includes('Cp')
         || findKey(extractor.extractFacts('You can also call me CP'), 'aliases').value.includes('CP'));
});

// ── Field isolation: THE core bug ─────────────────────────────────────────────
test('field isolation — changing company never erases name', async () => {
  const owner = engine.resolveOwner({ userId: 'iso-1' });
  engine.memoryObserve(owner, { userMessage: 'My name is Chhanda Prabal Das.', conversationId: 'c1' });
  await tick();
  engine.memoryObserve(owner, { userMessage: "I'm the founder of Aquiplex.", conversationId: 'c1' });
  await tick();
  engine.memoryObserve(owner, { userMessage: 'I work at Zerith.', conversationId: 'c1' });

  const id = identity.getIdentity(owner);
  assert.equal(id.name.value, 'Chhanda Prabal Das', 'name survived two employment updates');
  assert.equal(id.company.value, 'Zerith', 'company updated to the newest value');
  assert.ok(id.role, 'role still present');
});

test('field isolation — preferred_name does not clobber legal name (and vice-versa)', async () => {
  const owner = engine.resolveOwner({ userId: 'iso-2' });
  engine.memoryObserve(owner, { userMessage: 'My name is Chhanda Prabal Das.', conversationId: 'c1' });
  await tick();
  engine.memoryObserve(owner, { userMessage: 'Call me Chey.', conversationId: 'c1' });

  const id = identity.getIdentity(owner);
  assert.equal(id.name.value, 'Chhanda Prabal Das');
  assert.equal(id.preferred_name.value, 'Chey');
});

test('field isolation — role change keeps company and name intact', async () => {
  const owner = engine.resolveOwner({ userId: 'iso-3' });
  engine.memoryObserve(owner, { userMessage: 'My name is Ada. I am the founder of Aquiplex.', conversationId: 'c1' });
  await tick();
  engine.memoryObserve(owner, { userMessage: 'Actually, I am the CEO of Aquiplex.', conversationId: 'c1' });

  const id = identity.getIdentity(owner);
  assert.equal(id.name.value, 'Ada');
  assert.match(id.role.value.toLowerCase(), /ceo/, 'role updated to CEO');
  assert.equal(id.company.value, 'Aquiplex', 'company preserved through role change');
});

// ── Collection merge ──────────────────────────────────────────────────────────
test('collection merge — aliases accumulate across turns', async () => {
  const owner = engine.resolveOwner({ userId: 'alias-1' });
  engine.memoryObserve(owner, { userMessage: 'Also known as CP.', conversationId: 'c1' });
  await tick();
  engine.memoryObserve(owner, { userMessage: 'You can also call me Chey.', conversationId: 'c1' });

  const id = identity.getIdentity(owner);
  const aliases = id.aliases.value.map(String);
  assert.ok(aliases.length >= 2, `expected ≥2 aliases, got ${JSON.stringify(aliases)}`);
});

// ── Retrieval BYPASS ──────────────────────────────────────────────────────────
test('retrieval bypass — identity answered from canonical state, not the ranker', async () => {
  const owner = engine.resolveOwner({ userId: 'byp-1' });
  engine.memoryObserve(owner, { userMessage: 'My name is Chhanda. I am the founder of Aquiplex.', conversationId: 'c1' });
  // Flood with many higher-noise facts that would dominate a ranked list.
  for (let i = 0; i < 12; i++) {
    ltm.storeFact(owner, { key: `noise_${i}`, value: `topic ${i}`, category: 'custom', importance: 9, confidence: 0.95, ts: Date.now() });
  }

  // Directed identity question + a deliberately tiny factLimit.
  const r = engine.memoryRetrieve(owner, { query: 'what is my name?', factLimit: 2 });
  assert.ok(identity.isIdentityQuery('what is my name?'), 'query recognised as identity');
  assert.match(r.block, /IDENTITY \(user-stated, authoritative/, 'identity card present');
  assert.match(r.block, /Chhanda/, 'name present despite tiny factLimit + noise flood');
  // Identity block leads the memory block.
  assert.ok(r.block.indexOf('IDENTITY (user-stated') < (r.block.indexOf('USER PROFILE') === -1 ? Infinity : r.block.indexOf('USER PROFILE')),
    'identity card comes before the ranked fact profile');

  // "What company do I run?" → company surfaces from canonical state.
  const r2 = engine.memoryRetrieve(owner, { query: 'what company do I run?', factLimit: 2 });
  assert.match(r2.block, /Aquiplex/, 'company answered from identity, not ranking');
});

test('retrieval — identity card rides along on NON-identity queries too', async () => {
  const owner = engine.resolveOwner({ userId: 'byp-2' });
  engine.memoryObserve(owner, { userMessage: 'My name is Ada. I am the founder of Aquiplex.', conversationId: 'c1' });
  const r = engine.memoryRetrieve(owner, { query: 'help me debug a null pointer', factLimit: 5 });
  assert.match(r.block, /Ada/, 'identity is always available, even when not asked');
});

// ── Cross-conversation persistence ────────────────────────────────────────────
test('cross-conversation — identity set in chat A is visible from chat B (same user)', async () => {
  const ownerA = engine.resolveOwner({ userId: 'xconv-1', conversationId: 'chat-A' });
  engine.memoryObserve(ownerA, { userMessage: 'My name is Chhanda. I founded Aquiplex.', conversationId: 'chat-A' });

  const ownerB = engine.resolveOwner({ userId: 'xconv-1', conversationId: 'chat-B' });
  assert.equal(ownerA, ownerB, 'same user → same owner across conversations');
  const id = identity.getIdentity(ownerB);
  assert.equal(id.name.value, 'Chhanda');
  assert.equal(id.company.value, 'Aquiplex');
});

// ── Conflict resolution ───────────────────────────────────────────────────────
test('conflict — explicit correction overwrites name and keeps history', async () => {
  const owner = engine.resolveOwner({ userId: 'corr-1' });
  engine.memoryObserve(owner, { userMessage: 'My name is Alice.', conversationId: 'c1' });
  await tick();
  engine.memoryObserve(owner, { userMessage: 'Actually, my name is Alicia.', conversationId: 'c1' });

  const id = identity.getIdentity(owner);
  assert.equal(id.name.value, 'Alicia', 'correction won');
  const hist = ltm.getFactHistory(owner, 'name');
  assert.ok(hist.length >= 1 && hist.some(h => h.value === 'Alice'), 'previous legal name kept in history');
});

// ── Custom de-collision ───────────────────────────────────────────────────────
test('custom de-collision — two unrelated custom facts coexist (no shared-bucket clobber)', async () => {
  const owner = engine.resolveOwner({ userId: 'cust-1' });
  // "my X is Y" free facts route to the custom fallback with distinct per-X
  // keys — where the old code funnelled every "I'm X" trait into ONE
  // OVERWRITE-policy `custom_trait` key and lost all but the last.
  engine.memoryObserve(owner, { userMessage: 'My coffee order is oat flat white.', conversationId: 'c1' });
  await tick();
  engine.memoryObserve(owner, { userMessage: 'My keyboard layout is colemak.', conversationId: 'c1' });

  const facts = ltm.getFacts(owner);
  const customs = facts.filter(f => f.category === 'custom' && String(f.key).startsWith('custom_'));
  assert.ok(customs.length >= 2, `both custom facts should survive, got ${JSON.stringify(customs.map(c => c.key))}`);
  assert.equal(facts.find(f => f.key === 'custom_trait'), undefined, 'the collision-prone shared bucket no longer exists');
});

// ── Migration ─────────────────────────────────────────────────────────────────
test('migration — legacy custom_trait blob is promoted to canonical identity', () => {
  const owner = 'user:mig-1';
  const mind = mindStore.getMind(owner);
  mind.facts['name'] = { key: 'name', value: 'Chhanda', category: 'identity', confidence: 0.95, importance: 10, ts: Date.now() };
  mind.facts['custom_trait'] = { key: 'custom_trait', value: 'the founder of Aquiplex', category: 'custom', confidence: 0.7, importance: 4, ts: Date.now() };
  delete mind._identityMigrated;

  idMigrate.migrateIdentity();

  const id = identity.getIdentity(owner);
  assert.equal(id.name.value, 'Chhanda', 'existing name untouched');
  assert.match(id.role.value.toLowerCase(), /founder/, 'role promoted out of custom_trait');
  assert.equal(id.company.value, 'Aquiplex', 'company promoted out of custom_trait');
  assert.equal(mind.facts['custom_trait'], undefined, 'collided bucket cleared');
});

test('migration — non-identity custom_trait is de-collided, not mis-promoted; and is idempotent', () => {
  const owner = 'user:mig-2';
  const mind = mindStore.getMind(owner);
  mind.facts['custom_trait'] = { key: 'custom_trait', value: 'a night owl', category: 'custom', confidence: 0.7, importance: 4, ts: Date.now() };
  delete mind._identityMigrated;

  idMigrate.migrateIdentity();
  assert.equal(mind.facts['custom_trait'], undefined, 'shared bucket removed');
  assert.ok(Object.keys(mind.facts).some(k => k.startsWith('custom_') && k !== 'custom_trait'), 'preserved as a de-collided custom fact');
  const id = identity.getIdentity(owner);
  assert.equal(id.role, undefined, 'a mood/trait was NOT mis-promoted to a role');

  // second run does nothing (idempotent)
  const before = JSON.stringify(mind.facts);
  idMigrate.migrateIdentity();
  assert.equal(JSON.stringify(mind.facts), before, 'idempotent second pass');
});

// ── Regressions: the two headline spec examples ───────────────────────────────
test('regression — "I\'m the founder of Aquiplex" is role+company, NEVER custom_trait', () => {
  const facts = extractor.extractFacts("I'm the founder of Aquiplex");
  assert.equal(facts.find(f => f.key === 'custom_trait'), undefined);
  assert.ok(facts.every(f => !String(f.key).startsWith('custom_')), 'no custom fallback fired');
  assert.equal(findKey(facts, 'profession').value, 'founder');
  assert.equal(findKey(facts, 'workplace').value, 'Aquiplex');
});

test('regression — "I\'m Chhanda Prabal Das" is a name, NEVER custom_trait', () => {
  const facts = extractor.extractFacts("I'm Chhanda Prabal Das");
  assert.equal(facts.find(f => f.key === 'custom_trait'), undefined);
  assert.equal(findKey(facts, 'name').value, 'Chhanda Prabal Das');
});
