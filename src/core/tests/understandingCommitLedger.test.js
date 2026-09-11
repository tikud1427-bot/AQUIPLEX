import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HERE = new URL('.', import.meta.url).pathname;
const migration = readFileSync(join(HERE, '../db/migrations/0010_understanding_commit_ledger.sql'), 'utf8');
const repo = readFileSync(join(HERE, '../worldModel/worldModelRepository.js'), 'utf8');

test('E6/S9 durable commit ledger exists with the exact idempotency tuple', () => {
  assert.match(migration, /UNIQUE \(owner_id, source_id, segment_start, segment_end, extractor_version\)/);
  assert.match(migration, /FOREIGN KEY|REFERENCES aqua_sources/);
  assert.match(repo, /export async function recordUnderstandingCommit/);
  assert.match(repo, /aqua_understanding_commit_ledger/);
});

test('ledger API rejects malformed ranges before touching the database', async () => {
  const { recordUnderstandingCommit } = await import('../worldModel/worldModelRepository.js');
  await assert.rejects(
    () => recordUnderstandingCommit({
      ownerId: 'o', sourceId: '00000000-0000-0000-0000-000000000000',
      segmentRange: [4, 2], extractorVersion: 'e6-v1', actor: 'extractor'
    }),
    /segmentRange/
  );
});

test('canonical understanding commit creates its source before reserving the ledger FK', () => {
  const sourcePos = repo.indexOf('INSERT INTO aqua_sources');
  const ledgerPos = repo.indexOf('recordUnderstandingCommit({ownerId,sourceId');
  assert.ok(sourcePos >= 0 && ledgerPos >= 0 && sourcePos < ledgerPos,
    'aqua_sources must exist before the ledger row is inserted');
});

test('S9 ledger reservation is race-safe at the database uniqueness boundary', () => {
  assert.match(repo, /ON CONFLICT \(owner_id,source_id,segment_start,segment_end,extractor_version\)\s+DO NOTHING/);
});
