import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { _setPoolForTests, _resetForTests } from '../db/pool.js';
import { searchWorldModel } from '../worldModel/worldModelReader.js';

const OWNER = 'user:reader-test';

afterEach(() => { delete process.env.DATABASE_URL; _resetForTests(); });

describe('canonical world-model reader', () => {
  test('returns claim ids as retrieval/semantic identities and preserves entity links', async () => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost/aqua';
    const calls = [];
    const pool = {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rowCount: 1, rows: [{
          claim_id: 'claim-1', predicate: 'works_on', statement_text: 'I am building AQUIPLEX',
          statement_norm: 'i am building aquiplex', polarity: 'asserted', modality: 'fact', state: 'active',
          valid_from: null, valid_to: null, asserted_at: '2026-09-11T00:00:00Z', time_precision: 'none',
          confidence_extraction: 0.9, confidence_source: 0.8, confidence_corroboration: 0.2,
          extractor_version: 'e6-v1', subject_id: 'entity-1', subject_identity: 'aq:self:me', subject_label: 'Me', subject_type: 'self',
          object_id: 'entity-2', object_identity: 'aq:project:aquiplex', object_label: 'AQUIPLEX', object_type: 'project',
          source_type: 'conversation', source_title: 'Conversation',
        }] };
      }
    };
    const restore = _setPoolForTests(pool);
    try {
      const result = await searchWorldModel(OWNER, 'AQUIPLEX', { limit: 5 });
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].id, 'claim-1');
      assert.equal(result.items[0].semanticId, 'claim-1');
      assert.deepEqual(result.items[0].entityIds, ['entity-1', 'entity-2']);
      assert.equal(result.items[0].via, 'canonical-world-model');
      assert.equal(result.items[0].canonical.object.identityKey, 'aq:project:aquiplex');
      assert.match(calls[0].sql, /c\.owner_id=\$1/);
    } finally { restore(); }
  });
});
