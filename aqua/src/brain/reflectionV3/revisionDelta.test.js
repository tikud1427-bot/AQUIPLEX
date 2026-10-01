import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRevisionDeltaV2 } from './revisionDelta.js';

test('E9/PR-7 keeps named subjects and before/after changes bounded', () => {
  const out = buildRevisionDeltaV2({
    ownerId: 'owner:a',
    entitiesChanged: [
      { label: 'A', change: 'added' }, { label: 'B', change: 'typed' }, { label: 'C', change: 'grew' },
      { label: 'D', change: 'grew' }, { label: 'E', change: 'grew' }, { label: 'F', change: 'grew' },
    ],
    assumptionsRevised: [
      { subject: 'priority', from: 'churn', to: 'pricing', reason: 'correction' },
      { subject: 'deadline', from: 'Friday', to: 'Monday' },
      { subject: 'extra', from: 'a', to: 'b' },
    ],
  });
  assert.equal(out.version, 2);
  assert.equal(out.subjects.length, 5);
  assert.equal(out.revisions.length, 2);
  assert.equal(out.worldModelUpdated, true);
});
