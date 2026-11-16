/**
 * core/conversationTurnLock.js — audit D-14 (2026-11-16): one turn at a time
 * per conversation, bounded waits, idempotent release, stale reclaim, and no
 * cross-conversation blocking.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { acquireConversationTurn, activeTurnLeases, _resetTurnLocksForTests } from '../conversationTurnLock.js';

beforeEach(() => _resetTurnLocksForTests());

test('a second turn waits for the first, then proceeds in order', async () => {
  const order = [];
  const r1 = await acquireConversationTurn('c1', { waitMs: 1000 });
  const p2 = acquireConversationTurn('c1', { waitMs: 1000 }).then(r => { order.push('second-acquired'); return r; });
  await new Promise(r => setTimeout(r, 30));
  order.push('first-done');
  r1();
  const r2 = await p2;
  assert.deepEqual(order, ['first-done', 'second-acquired']);
  r2();
  assert.equal(activeTurnLeases(), 0);
});

test('still busy after the wait → null (route answers 409); unrelated conversations are not blocked', async () => {
  const r1 = await acquireConversationTurn('busy', { waitMs: 10 });
  assert.equal(await acquireConversationTurn('busy', { waitMs: 20 }), null);
  const other = await acquireConversationTurn('other', { waitMs: 0 });
  assert.equal(typeof other, 'function');
  other(); r1();
});

test('release is idempotent and a reclaimed (stale) lease cannot be released by its old holder', async () => {
  const r1 = await acquireConversationTurn('s', { staleMs: 5 });
  r1(); r1();
  const r2 = await acquireConversationTurn('s', { staleMs: 5 });
  await new Promise(r => setTimeout(r, 15));
  const r3 = await acquireConversationTurn('s', { staleMs: 5, waitMs: 0 });
  assert.equal(typeof r3, 'function', 'stale lease reclaimed');
  r2();                                   // the old holder releasing must not free r3's lease
  assert.equal(await acquireConversationTurn('s', { staleMs: 60_000, waitMs: 0 }), null);
  r3();
});

test('AQUA_CONVERSATION_TURN_LOCK=off → no-op release (rollback)', async () => {
  const env = { AQUA_CONVERSATION_TURN_LOCK: 'off' };
  const a = await acquireConversationTurn('x', { env });
  const b = await acquireConversationTurn('x', { env, waitMs: 0 });
  assert.equal(typeof a, 'function'); assert.equal(typeof b, 'function');
  assert.equal(activeTurnLeases(), 0);
});
