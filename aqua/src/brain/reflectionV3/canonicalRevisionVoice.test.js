import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exclusionReason, buildCanonicalDirective, selectCanonicalRevision } from './canonicalRevisionVoice.js';

const sup = (n, over = {}) => ({ transitionId: `00000000-0000-4000-8000-00000000000${n}`, createdAt: `2026-01-01T00:0${n}:00Z`,
  toState: 'superseded', reason: 'e9-contradiction:newer competing snapshot', oldText: 'I live in Berlin', currentState: 'superseded',
  newText: 'I moved to Paris', newActor: 'e6:e6-v1', newRef: 'conv-a:turn:2', ...over });

test('exclusions', () => {
  assert.equal(exclusionReason(sup(1), { conversationId: 'conv-b' }), null);
  assert.equal(exclusionReason(sup(1), { conversationId: 'conv-a' }), 'said-in-this-conversation');
  assert.equal(exclusionReason(sup(1, { newActor: 'user' })), 'user-correction');
  assert.equal(exclusionReason(sup(1, { reason: 'user-correction' })), 'user-correction');
  assert.equal(exclusionReason(sup(1, { currentState: 'active' })), 'no-longer-current');
  assert.equal(exclusionReason(sup(1, { newText: null })), 'missing-statement');
  assert.equal(exclusionReason(sup(1, { toState: 'disputed', currentState: 'disputed' }), { conversationId: 'conv-a' }), null);
});

test('the directive quotes only the stored statements, older first, and asks', () => {
  const d = buildCanonicalDirective(sup(1));
  assert.deepEqual([...d.matchAll(/"([^"]+)"/g)].map(m => m[1]), ['I live in Berlin', 'I moved to Paris']);
  assert.match(d, /Ask whether you have it right/);
  assert.equal(buildCanonicalDirective(sup(1, { oldText: '  ' })), '');
});

test('newest eligible wins; the watermark passes everything considered', () => {
  const r = selectCanonicalRevision([sup(3, { newRef: 'conv-b:turn:9' }), sup(1), sup(2)], { conversationId: 'conv-b' });
  assert.equal(r.chosen.transitionId.endsWith('2'), true);
  assert.equal(r.watermark.transitionId.endsWith('3'), true);
  assert.equal(selectCanonicalRevision([]).directive, '');
});
