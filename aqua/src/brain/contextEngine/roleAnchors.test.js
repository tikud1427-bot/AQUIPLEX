import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { roleAnchorsForQuery } from './index.js';

const holders = [
  { entityId: 'sam', label: 'Sam Patel', role: 'mentor' },
  { entityId: 'sora', label: 'Sora Studio', role: 'biggest client' },
  { entityId: 'acme', label: 'Acme', role: 'client' },
  { entityId: 'nadia', label: 'Nadia', role: 'tech lead' },
  { entityId: 'elena', label: 'Elena', role: 'sister' },
];

describe('role references in a question resolve to the current role holder', () => {
  test('a role word in the question anchors on whoever holds that role', () => {
    assert.deepEqual(roleAnchorsForQuery('Where does my mentor work?', holders), ['sam']);
    assert.deepEqual(roleAnchorsForQuery('Who is my tech lead going forward?', holders), ['nadia']);
    assert.deepEqual(roleAnchorsForQuery('Draft a message to my sister about her week', holders), ['elena']);
  });

  test('the head noun decides; plural questions match; every holder of the head is returned', () => {
    assert.deepEqual(roleAnchorsForQuery('Draft a polite message to my biggest client', holders), ['sora', 'acme']);
    assert.deepEqual(roleAnchorsForQuery('List my clients', holders), ['sora', 'acme']);
  });

  test('no role word, no anchor; bad input is empty', () => {
    assert.deepEqual(roleAnchorsForQuery('What is my thesis about?', holders), []);
    assert.deepEqual(roleAnchorsForQuery('', holders), []);
    assert.deepEqual(roleAnchorsForQuery('my mentor', null), []);
  });
});
