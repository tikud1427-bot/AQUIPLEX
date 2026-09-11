import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const SRC = path.resolve(HERE, '..');
const repo = readFileSync(path.join(SRC, 'worldModel/worldModelRepository.js'), 'utf8');
const brain = readFileSync(path.join(SRC, '../brain/index.js'), 'utf8');

assert.match(repo, /export async function commitUnderstanding\(input = \{\}\)/);
assert.match(repo, /ON CONFLICT \(owner_id,source_id,segment_start,segment_end,extractor_version\)/);

const shape = repo.indexOf('const cols={entity:');
const evidence = repo.indexOf('INSERT INTO aqua_evidence', shape);
const guard = repo.indexOf('if(!cols) continue;', shape);
const fields = repo.indexOf('const fields=[\'claim_id\'', guard);
assert.ok(shape >= 0 && guard > shape && evidence > guard && fields > evidence,
  'claim shape must be validated before evidence and claim insertion');

assert.ok(repo.indexOf('INSERT INTO aqua_evidence', shape) > guard,
  'unsupported object kinds must not create orphan evidence');

const bridge = brain.indexOf('commitCanonicalUnderstanding');
assert.ok(bridge >= 0, 'Brain facade must import the canonical commit writer');
assert.match(brain.slice(bridge), /commitCanonicalUnderstanding\(/);

console.log('worldModelCommitContract: 4/4 passed');
