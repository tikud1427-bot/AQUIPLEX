import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rememberFocus, recallFocus, purgeOwner, isDeictic, _sizeForTests } from '../contextEngine/conversationFocus.js';
import { referenceNouns } from '../../core/worldModel/canonicalReadModel.js';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('focus is per (owner, conversation), opaque ids only, and expires', () => {
  rememberFocus('o1', 'c1', [id(1), 'not-a-uuid', id(2)], 1000);
  assert.deepEqual(recallFocus('o1', 'c1', 2000), [id(1), id(2)]);
  assert.deepEqual(recallFocus('o1', 'c2', 2000), [], 'another conversation');
  assert.deepEqual(recallFocus('o2', 'c1', 2000), [], 'another owner');
  assert.deepEqual(recallFocus('o1', 'c1', 1000 + 31 * 60 * 1000), [], 'TTL');
});

test('bounded (G6) and purgeable per owner (G4)', () => {
  for (let i = 0; i < 2100; i++) rememberFocus(`bulk-${i}`, 'c', [id(i)]);
  assert.ok(_sizeForTests() <= 2000);
  rememberFocus('victim', 'c1', [id(7)]); rememberFocus('victim', 'c2', [id(8)]);
  assert.equal(purgeOwner('victim'), 2);
  assert.deepEqual(recallFocus('victim', 'c1'), []);
});

test('deictic detection', () => {
  for (const q of ['Who owns that?', 'Tell me more about it', 'What did they decide?']) assert.ok(isDeictic(q), q);
  for (const q of ['Where do I work?', 'What is blocking the launch?']) assert.ok(!isDeictic(q), q);
});

test('reference nouns: possessive/definite phrases, role nouns only after my/our', () => {
  assert.deepEqual(referenceNouns('When is our iOS launch?'), { heads: ['ios', 'launch'], roles: [] });
  assert.deepEqual(referenceNouns('Who is my manager?').roles, ['manager']);
  assert.deepEqual(referenceNouns('Who is the manager?').roles, [], '"the manager" is not the user\'s manager');
  assert.deepEqual(referenceNouns('What is the best way to start?'), { heads: [], roles: [] });
});
