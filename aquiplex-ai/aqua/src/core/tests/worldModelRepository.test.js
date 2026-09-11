import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { _setPoolForTests, _resetForTests } from '../db/pool.js';
import { commitUnderstanding, purgeOwner, applyReflectionDelta } from '../worldModel/worldModelRepository.js';

const OWNER = 'user:test-world-model';
const ENTITY_A = 'aq:self:me';
const ENTITY_B = 'aq:project:aquiplex';

function fakeDb() {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql: String(sql), params });
      const text = String(sql).replace(/\s+/g, ' ');
      if (/^SELECT commit_key FROM aqua_world_model_commits/.test(text)) return { rows: [] };
      if (/^SELECT entity_id FROM aqua_entities WHERE owner_id=\$1 AND identity_key/.test(text)) return { rows: [] };
      if (/^SELECT entity_id, identity_key FROM aqua_entities/.test(text)) return { rows: [] };
      if (/^SELECT claim_id FROM aqua_claims/.test(text)) return { rows: [] };
      if (/^SELECT 1 FROM aqua_edges/.test(text)) return { rows: [] };
      if (/^(INSERT|UPDATE|DELETE|ALTER|CREATE|BEGIN|COMMIT|ROLLBACK)/.test(text)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() { queries.push({ sql: 'RELEASE' }); },
  };
  const pool = { async connect() { return client; }, async query(sql, params) { return client.query(sql, params); } };
  return { pool, queries };
}

function entityById() {
  return new Map([
    [ENTITY_A, { entityId: ENTITY_A, name: 'Me', kind: 'self' }],
    [ENTITY_B, { entityId: ENTITY_B, name: 'AQUIPLEX', kind: 'project' }],
  ]);
}

const claim = (segment, text = 'I am building AQUIPLEX.') => ({
  subjectEntityId: ENTITY_A,
  subjectCanonical: 'Me',
  predicate: 'works_on',
  objectEntityId: ENTITY_B,
  objectCanonical: 'AQUIPLEX',
  objectKind: 'entity',
  object: { entity: 'AQUIPLEX' },
  polarity: 'asserted', modality: 'fact', confidenceExtraction: 0.95,
  statementText: text, segment,
});

afterEach(() => {
  delete process.env.AQUA_E6_COMMIT;
  delete process.env.DATABASE_URL;
  _resetForTests();
});

describe('canonical world-model repository', () => {
  test('commits multiple claims in one segment with exactly one idempotency row', async () => {
    process.env.AQUA_E6_COMMIT = 'on';
    process.env.DATABASE_URL = 'postgres://test:test@localhost/aqua';
    const db = fakeDb();
    const restore = _setPoolForTests(db.pool);
    try {
      const result = await commitUnderstanding({ readyForS7: [claim([0, 20]), claim([0, 20], 'I am actively building AQUIPLEX.') ] }, {
        ownerId: OWNER, conversationId: 'conv-1', extractorVersion: 'e6-v1', actor: 'test', entityById: entityById(),
      });
      assert.equal(result.claims, 2);
      const commits = db.queries.filter(q => /INSERT INTO aqua_world_model_commits/.test(q.sql));
      assert.equal(commits.length, 1, 'segment idempotency must be recorded once, after all claims');
      const evidence = db.queries.filter(q => /INSERT INTO aqua_evidence/.test(q.sql));
      assert.equal(evidence.length, 2);
      const edges = db.queries.filter(q => /INSERT INTO aqua_edges/.test(q.sql));
      assert.equal(edges.length, 2);
    } finally { restore(); }
  });

  test('commits each distinct segment under its own idempotency key', async () => {
    process.env.AQUA_E6_COMMIT = 'on';
    process.env.DATABASE_URL = 'postgres://test:test@localhost/aqua';
    const db = fakeDb();
    const restore = _setPoolForTests(db.pool);
    try {
      const result = await commitUnderstanding({ readyForS7: [claim([0, 20]), claim([21, 45], 'AQUIPLEX is my current project.') ] }, {
        ownerId: OWNER, conversationId: 'conv-2', extractorVersion: 'e6-v1', actor: 'test', entityById: entityById(),
      });
      assert.equal(result.segments.length, 2);
      assert.equal(db.queries.filter(q => /INSERT INTO aqua_world_model_commits/.test(q.sql)).length, 2);
    } finally { restore(); }
  });

  test('disabled commit is an honest no-op', async () => {
    const result = await commitUnderstanding({ readyForS7: [claim([0, 20])] }, { ownerId: OWNER, conversationId: 'conv-3', extractorVersion: 'e6-v1', actor: 'test' });
    assert.deepEqual(result, { committed: false, disabled: true, claims: 0 });
  });

  test('reflection application archives canonical claims with an auditable lifecycle and outbox trail', async () => {
    process.env.AQUA_E6_COMMIT = 'on';
    process.env.DATABASE_URL = 'postgres://test:test@localhost/aqua';
    const db = fakeDb();
    // This test needs a real existing claim lookup, so wrap the fake client
    // with the one canonical row Reflection is expected to mutate.
    const originalConnect = db.pool.connect;
    db.pool.connect = async () => {
      const client = await originalConnect();
      const originalQuery = client.query;
      client.query = async (sql, params = []) => {
        const text = String(sql).replace(/\s+/g, ' ');
        if (/^SELECT claim_id,state,statement_text,predicate,subject_entity_id FROM aqua_claims/.test(text)) {
          return { rows: [{ claim_id: 'old', state: 'active', statement_text: 'Aqua is beta', predicate: 'status', subject_entity_id: 'entity-1' }] };
        }
        return originalQuery(sql, params);
      };
      return client;
    };
    const restore = _setPoolForTests(db.pool);
    try {
      const report = await applyReflectionDelta(OWNER, {
        obsoleted: [{ factId: 'old', supersededBy: 'new', reason: 'newer canonical claim' }],
        assumptionsRevised: [],
      });
      assert.equal(report.archived.length, 1);
      assert.ok(db.queries.some(q => /UPDATE aqua_claims SET state='archived'/.test(q.sql)));
      assert.ok(db.queries.some(q => /INSERT INTO aqua_lifecycle_transitions/.test(q.sql)));
      assert.ok(db.queries.some(q => /INSERT INTO aqua_revisions/.test(q.sql)));
      assert.ok(db.queries.some(q => /INSERT INTO aqua_events/.test(q.sql)));
      assert.ok(db.queries.some(q => /INSERT INTO aqua_outbox/.test(q.sql)));
    } finally { restore(); }
  });

  test('purge deletes canonical data in dependency-safe order', async () => {
    process.env.AQUA_E6_COMMIT = 'on';
    process.env.DATABASE_URL = 'postgres://test:test@localhost/aqua';
    const db = fakeDb();
    const restore = _setPoolForTests(db.pool);
    try {
      const result = await purgeOwner(OWNER);
      assert.equal(result.skipped, null);
      const deletes = db.queries.filter(q => /^DELETE FROM/.test(q.sql)).map(q => q.sql.match(/^DELETE FROM (\w+)/)?.[1]);
      assert.deepEqual(deletes, [
        'aqua_claim_evidence','aqua_edges','aqua_events','aqua_lifecycle_transitions','aqua_revisions',
        'aqua_corrections','aqua_outbox','aqua_world_model_commits','aqua_claims','aqua_evidence',
        'aqua_sources','aqua_entity_aliases','aqua_entity_merges','aqua_entities',
      ]);
    } finally { restore(); }
  });
});
