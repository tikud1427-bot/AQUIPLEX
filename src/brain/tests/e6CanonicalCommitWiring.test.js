import assert from 'node:assert/strict';
import { e6CommitEnabled } from '../index.js';

const old = process.env.AQUA_E6_COMMIT;
delete process.env.AQUA_E6_COMMIT;
assert.equal(e6CommitEnabled(), false);

process.env.AQUA_E6_COMMIT = 'on';
assert.equal(e6CommitEnabled(), true);

process.env.AQUA_E6_COMMIT = 'ON';
assert.equal(e6CommitEnabled(), true);

process.env.AQUA_E6_COMMIT = 'off';
assert.equal(e6CommitEnabled(), false);

if (old === undefined) delete process.env.AQUA_E6_COMMIT;
else process.env.AQUA_E6_COMMIT = old;

console.log('e6CanonicalCommitWiring: 4/4 passed');
