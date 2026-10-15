/**
 * Owner adoption must not cross accounts.
 * Run: node aqua/scripts/run-tests.mjs src/memory/tests/ownerAdoptionIsolation.test.js
 *
 * resolveOwner({ userId, conversationId }) merges a pre-login `conv:` mind
 * into the caller's `user:` mind and tombstones the source. Several routes
 * forward a CLIENT-SUPPLIED conversationId into it (brain GETs via
 * ?conversationId=, POST /intelligence/orchestrate, POST /project/workspace).
 * Before the fix, any signed-in account could name another conversation's id
 * and absorb its orphaned memory. Each test below fails on that code.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-adopt-iso-'));
process.env.AQUA_DATA_DIR = tmp;
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
const repoRoot = process.cwd();
process.chdir(tmp);

let engine, ltm, mindStore, convStore;

before(async () => {
  const load = (p) => import(pathToFileURL(path.join(repoRoot, p)).href);
  engine    = await load('src/memory/engine.js');
  ltm       = await load('src/memory/longTermMemory.js');
  mindStore = await load('src/mind/mindStore.js');
  convStore = await load('src/memory/conversationStore.js');
});

test("an account cannot adopt the orphaned memory of another account's conversation", () => {
  convStore.getOrCreateConversation('victim-conv', { userId: 'victim' });
  engine.memoryObserve('conv:victim-conv', { userMessage: 'My name is Ananya.', conversationId: 'victim-conv' });
  assert.ok(ltm.getFact('conv:victim-conv', 'name'), 'precondition: orphan mind holds a fact');

  const owner = engine.resolveOwner({ userId: 'attacker', conversationId: 'victim-conv' });

  assert.equal(owner, 'user:attacker', 'the caller still resolves to their own owner');
  assert.equal(ltm.getFact('user:attacker', 'name'), null, "victim's fact must not reach the attacker");
  assert.equal(mindStore.peekMind('conv:victim-conv').adoptedInto ?? null, null, 'victim mind must not be tombstoned');
});

test('an unowned (pre-login) conversation known to the store is not adoptable by whoever names it', () => {
  convStore.getOrCreateConversation('anon-known', {});
  engine.memoryObserve('conv:anon-known', { userMessage: 'My name is Ravi.', conversationId: 'anon-known' });

  engine.resolveOwner({ userId: 'stranger', conversationId: 'anon-known' });

  assert.equal(ltm.getFact('user:stranger', 'name'), null);
  assert.equal(mindStore.peekMind('conv:anon-known').adoptedInto ?? null, null);
});

test('the owner of a conversation still adopts its memory', () => {
  convStore.getOrCreateConversation('own-conv', { userId: 'owner-1' });
  engine.memoryObserve('conv:own-conv', { userMessage: 'My name is Meera.', conversationId: 'own-conv' });

  engine.resolveOwner({ userId: 'owner-1', conversationId: 'own-conv' });

  assert.match(String(ltm.getFact('user:owner-1', 'name')?.value ?? ''), /meera/i);
  assert.equal(mindStore.peekMind('conv:own-conv').adoptedInto, 'user:owner-1');
});

test('a conversation id unknown to the store keeps the first-login adoption contract', () => {
  engine.memoryObserve('conv:client-only', { userMessage: 'My name is Kabir.', conversationId: 'client-only' });

  engine.resolveOwner({ userId: 'new-user', conversationId: 'client-only' });

  assert.match(String(ltm.getFact('user:new-user', 'name')?.value ?? ''), /kabir/i);
});
