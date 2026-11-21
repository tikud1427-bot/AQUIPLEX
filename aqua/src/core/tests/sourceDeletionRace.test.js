/**
 * G1-1 acceptance remediation — the RUNNING-JOB race.
 *
 * A document-understanding job for an external resource may be mid-extraction
 * when its source or resource is deleted. Every canonical write of that job
 * goes through ONE call: worldModelRepository.commitUnderstanding (one
 * transaction). These tests drive that real repository on the real migrated
 * schema (pg-mem) with the exact input shape brain/index.js builds for an
 * external document chunk (source id from canonicalTurnSourceId(owner,
 * `extuko:<ukoId>`, chunk+1), external_ref `extuko:<ukoId>:chunk:<n>`,
 * `enqueuedAt` = the job's created_at).
 *
 * A "running job" is modelled as: enqueued at T0 (before the deletion) → the
 * deletion commits → the job's commit arrives. That is the race's window.
 *
 * pg-mem limits that matter here:
 *   · pg_advisory_xact_lock is stubbed (always succeeds) and statements run
 *     one at a time, so TRUE concurrency (scenario 4) is proven here by
 *     ORDERING: both sides take the SAME lock as their first statement after
 *     BEGIN, before any read or write. Two real connections racing on Postgres:
 *     sourceDeletion.live.test.js.
 *   · the full extraction path (S8 uses full-text search and `<> ALL`) does not
 *     run on pg-mem; the worker → understandTurn → commit path with a scripted
 *     model is exercised by the live suite.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-g11-race-'));
process.env.AQUA_DATA_DIR = TMP;
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
const envBefore = process.env.DATABASE_URL;

let mem, restorePool, SD, G, WM, poolMod, canonicalTurnSourceId;
before(async () => {
  process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/aqua';
  poolMod = await import('../db/pool.js');
  poolMod._resetForTests();
  const { createMemoryPg } = await import('./helpers/memoryPg.mjs');
  mem = createMemoryPg();
  restorePool = poolMod._setPoolForTests(mem.pool);
  await (await import('../db/migrate.js')).migrate();
  // Same pg-mem artefact as sourceDeletion.test.js: non-unique partial indexes
  // ignore WHERE. Simulator only; production schema unchanged.
  for (const ix of ['aqua_jobs_ready_ix', 'aqua_jobs_running_owner_ix', 'aqua_jobs_dead_ix', 'aqua_jobs_running_heartbeat_ix',
    'aqua_outbox_pending_idx', 'aqua_claims_subject_recent_idx', 'aqua_claims_object_recent_idx', 'aqua_claims_exact_literal_idx']) {
    await mem.pool.query(`DROP INDEX IF EXISTS ${ix}`);
  }
  SD = await import('../worldModel/sourceDeletion.js');
  G = await import('../worldModel/externalDeletionGuard.js');
  WM = await import('../worldModel/worldModelRepository.js');
  ({ canonicalTurnSourceId } = await import('../worldModel/turnSourceIdentity.js'));
});
after(async () => {
  restorePool?.();
  await mem?.close();
  if (envBefore === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = envBefore;
  poolMod?._resetForTests();
});

// ── fixtures ────────────────────────────────────────────────────────────────
const hex = (n, c) => String(c).repeat(n);
const SRC_A = `ext_${hex(12, 'a')}_`;
const SRC_B = `ext_${hex(12, 'b')}_`;
const uko = (src, it, ver = 'abcdef123456') => `${src}${hex(16, it)}_${ver}`;
const item = (src, it) => `${src}${hex(16, it)}_`;
const q = (sql, p = []) => mem.pool.query(sql, p);
const noVectors = () => ({ removeVector: () => true, canonicalNamespace: o => `canonical-claims:${o}` });
let seq = 0;
const freshOwner = () => `user:g11r-${process.pid}-${++seq}`;
const past = (ms = 60_000) => new Date(Date.now() - ms);
const later = (ms = 60_000) => new Date(Date.now() + ms);

let n = 0;
/** A resolved claim exactly as S7/S8 hand it to the repository. */
const claimFor = (text, subject = 'Lena') => ({
  claimId: crypto.randomUUID(), predicate: 'owns', objectKind: 'entity', subject, object: { entity: `Atlas${++n} service` },
  polarity: 'asserted', modality: 'fact', timePrecision: 'none', statementText: text,
  _canonicalSubject: { entityId: `aq:name:${subject.toLowerCase()}`, canonical: subject, name: subject, type: 'person' },
  _canonicalObject: { entityId: `aq:name:atlas${n}`, canonical: `Atlas${n} service`, name: `Atlas${n} service`, type: 'concept' },
  resolution: { ready: true },
});

/**
 * One document job's canonical commit, shaped like brain/index.js builds it.
 * `ukoId` null → an UPLOAD (`file:` ref, upload conversation id).
 */
function commitJob(owner, { ukoId = null, text, enqueuedAt, chunk = 0, hash = 'f'.repeat(64), attachTo = null }) {
  const external = typeof ukoId === 'string' && ukoId.startsWith('ext_');
  const conversationId = external ? `extuko:${ukoId}` : `file:${hash.slice(0, 32)}`;
  return WM.commitUnderstanding({
    ownerId: owner, sourceId: canonicalTurnSourceId(owner, conversationId, chunk + 1),
    actor: 'e6:test', extractorVersion: 'e6-race', segmentRange: { start: 0, end: text.length },
    sourceKind: 'document', trustTier: 3,
    externalRef: external ? SD.externalUnderstandingRef(ukoId, chunk) : `file:note.md:chunk:${chunk}`,
    title: external ? 'External resource — note.md' : 'Uploaded file — note.md',
    ...(enqueuedAt !== undefined ? { enqueuedAt } : {}),
    contentHash: crypto.createHash('sha256').update(text).digest('hex'),
    assertedAt: new Date(),
    // `attachTo`: S8 found the same claim already stored → the sentence is a
    // restatement attached as corroborating evidence, not a new claim.
    ...(attachTo
      ? { claims: [], evidenceAttachments: [{ targetClaimId: attachTo, claim: { statementText: text } }] }
      : { claims: [claimFor(text)] }),
  });
}
const sentence = () => `Lena owns the Atlas${process.pid}x${++n} service`;

const extRows = async (owner, ukoPrefix) => {
  const sources = (await q('SELECT source_id, external_ref FROM aqua_sources WHERE owner_id = $1', [owner])).rows
    .filter(r => String(r.external_ref ?? '').startsWith(`extuko:${ukoPrefix}`));
  let claims = 0, ledger = 0;
  for (const s of sources) {
    claims += Number((await q('SELECT count(*)::int AS n FROM aqua_evidence WHERE owner_id = $1 AND source_id = $2', [owner, s.source_id])).rows[0].n);
    ledger += Number((await q('SELECT count(*)::int AS n FROM aqua_understanding_commit_ledger WHERE owner_id = $1 AND source_id = $2', [owner, s.source_id])).rows[0].n);
  }
  return { sources: sources.length, claims, ledger };
};
const saying = async (owner, text) => (await q('SELECT claim_id FROM aqua_claims WHERE owner_id = $1 AND statement_text = $2', [owner, text])).rows.map(r => r.claim_id);
const embeddingRequestsFor = async (owner, text) => (await q(
  `SELECT payload FROM aqua_outbox WHERE owner_id = $1 AND event_type = 'claim.embedding.requested'`, [owner])).rows
  .filter(r => (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload)?.statementText === text).length;
const refused = r => r?.skipped === true && r?.reason === 'source-deleted' && (r.claims ?? []).length === 0;
const del = (owner, scope) => SD.forgetExternalSourceClaims(owner, scope, noVectors());
const GONE = { sources: 0, claims: 0, ledger: 0 };
const ONE = { sources: 1, claims: 1, ledger: 1 };

describe('G1-1 race · a running job cannot recreate deleted knowledge', () => {
  test('baseline: an external resource\'s job commits normally when nothing was deleted', async () => {
    const O = freshOwner(), text = sentence();
    const r = await commitJob(O, { ukoId: uko(SRC_A, '1'), text, enqueuedAt: past() });
    assert.equal(r.claims.length, 1, JSON.stringify(r));
    assert.deepEqual(await extRows(O, uko(SRC_A, '1')), ONE);
    assert.equal(await embeddingRequestsFor(O, text), 1);
  });

  test('1 · job starts, the whole SOURCE is deleted, job finishes → nothing is written', async () => {
    const O = freshOwner(), text = sentence(), id = uko(SRC_A, '1');
    const enqueuedAt = past();                                   // job enqueued and claimed
    const d = await del(O, { ukoPrefix: SRC_A });                // … the user disconnects the source
    assert.ok(d.complete);
    const r = await commitJob(O, { ukoId: id, text, enqueuedAt }); // … the running job reaches its commit
    assert.ok(refused(r), JSON.stringify(r));
    assert.deepEqual(await extRows(O, SRC_A), GONE);
    assert.deepEqual(await saying(O, text), []);
    assert.equal(await embeddingRequestsFor(O, text), 0, 'an embedding was requested for deleted knowledge');
    assert.equal(Number((await q('SELECT count(*)::int AS n FROM aqua_entities WHERE owner_id = $1', [O])).rows[0].n), 0, 'entities created');
    // the worker treats a refused commit as DONE: no throw → no retry storm, no DLQ
    const { assertUnderstood } = await import('../jobs/workerRuntime.js');
    assert.doesNotThrow(() => assertUnderstood({ canonicalCommit: { enabled: true, commits: [r], committedClaims: 0 }, stats: { errors: 0 } }));
  });

  test('2 · job starts, one RESOURCE is deleted, job finishes → nothing written; sibling resources are unaffected', async () => {
    const O = freshOwner(), gone = uko(SRC_A, '1'), sibling = uko(SRC_A, '2');
    const keep = sentence();
    await commitJob(O, { ukoId: sibling, text: keep, enqueuedAt: past(120_000) });   // sibling already understood
    const enqueuedAt = past();
    await del(O, { ukoPrefix: item(SRC_A, '1') });
    const r = await commitJob(O, { ukoId: gone, text: sentence(), enqueuedAt });
    assert.ok(refused(r), JSON.stringify(r));
    assert.deepEqual(await extRows(O, gone), GONE);
    assert.deepEqual(await extRows(O, sibling), ONE, 'the sibling resource lost knowledge');
    // a RUNNING job for the sibling, enqueued at the same moment, still commits
    const s = await commitJob(O, { ukoId: sibling, text: sentence(), enqueuedAt, chunk: 1 });
    assert.equal(s.claims.length, 1, JSON.stringify(s));
  });

  test('2b · resource UPDATE: the replaced version\'s running job is refused; the kept version\'s commits', async () => {
    const O = freshOwner(), v1 = uko(SRC_A, '3', '111111'), v2 = uko(SRC_A, '3', '222222');
    const enqueuedAt = past();
    await del(O, { ukoPrefix: item(SRC_A, '3'), keepUkoId: v2 });
    assert.ok(refused(await commitJob(O, { ukoId: v1, text: sentence(), enqueuedAt })));
    const cur = await commitJob(O, { ukoId: v2, text: sentence(), enqueuedAt });
    assert.equal(cur.claims.length, 1, JSON.stringify(cur));
    assert.deepEqual(await extRows(O, v1), GONE);
    assert.deepEqual(await extRows(O, v2), ONE);
  });

  test('3 · job finishes BEFORE the deletion → committed, then removed completely by the deletion', async () => {
    const O = freshOwner(), text = sentence(), id = uko(SRC_A, '1');
    const r = await commitJob(O, { ukoId: id, text, enqueuedAt: past() });
    assert.equal(r.claims.length, 1);
    assert.deepEqual(await extRows(O, id), ONE);
    const d = await del(O, { ukoPrefix: SRC_A });
    assert.ok(d.complete);
    assert.equal(d.counts.sources, 1);
    assert.deepEqual(await extRows(O, id), GONE);
    assert.deepEqual(await saying(O, text), []);
    assert.equal(await embeddingRequestsFor(O, text), 0);
  });

  test('4 · concurrency: deletion and commit take the SAME per-source lock first, before any read or write', async () => {
    const O = freshOwner(), id = uko(SRC_A, '7');
    const statements = [];
    const spyPool = {
      connect: async () => {
        const c = await mem.pool.connect();
        return { query: (sql, p) => { statements.push({ sql: String(sql).trim(), p }); return c.query(sql, p); }, release: () => c.release() };
      },
      query: (sql, p) => mem.pool.query(sql, p),
    };
    // deletion side
    await SD.forgetExternalSourceClaims(O, { ukoPrefix: item(SRC_A, '7') }, { pool: spyPool, ...noVectors() });
    assert.match(statements[0].sql, /^BEGIN/);
    assert.match(statements[1].sql, /pg_advisory_xact_lock/);
    const deletionLock = statements[1].p;
    assert.match(statements[2].sql, /^INSERT INTO aqua_external_deletions/);
    assert.ok(statements.findIndex(s => /^COMMIT/.test(s.sql)) > 2);

    // commit side, through the real repository transaction (it uses the module pool)
    statements.length = 0;
    poolMod._setPoolForTests(spyPool);
    let r;
    try { r = await commitJob(O, { ukoId: id, text: sentence(), enqueuedAt: past() }); }
    finally { poolMod._setPoolForTests(mem.pool); }
    assert.ok(refused(r), JSON.stringify(r));
    assert.match(statements[0].sql, /^BEGIN/);
    assert.match(statements[1].sql, /pg_advisory_xact_lock/);
    assert.deepEqual(statements[1].p, deletionLock, 'commit and deletion must contend on the same lock');
    assert.match(statements[2].sql, /FROM aqua_external_deletions/);
    assert.ok(!statements.some(s => /^(INSERT|UPDATE|DELETE)/i.test(s.sql)), `a refused commit wrote: ${statements.map(s => s.sql).join(' | ')}`);
    assert.match(statements.at(-1).sql, /^COMMIT/);

    // a commit that is NOT refused also takes the lock before its first write
    statements.length = 0;
    poolMod._setPoolForTests(spyPool);
    try { r = await commitJob(O, { ukoId: uko(SRC_A, '8'), text: sentence(), enqueuedAt: past() }); }
    finally { poolMod._setPoolForTests(mem.pool); }
    assert.equal(r.claims.length, 1);
    const lockAt = statements.findIndex(s => /pg_advisory_xact_lock/.test(s.sql));
    const firstWrite = statements.findIndex(s => /^(INSERT|UPDATE|DELETE)/i.test(s.sql));
    assert.equal(lockAt, 1);
    assert.ok(firstWrite > lockAt);
    assert.deepEqual(statements[lockAt].p, deletionLock, 'every resource of one source shares the lock');

    // item- and source-level scopes of one source share the key; other sources/owners do not
    assert.equal(G.externalSourceLockKey(O, SRC_A), G.externalSourceLockKey(O, id));
    assert.notEqual(G.externalSourceLockKey(O, SRC_A), G.externalSourceLockKey(O, SRC_B));
    assert.notEqual(G.externalSourceLockKey(O, SRC_A), G.externalSourceLockKey(`${O}-other`, SRC_A));
  });

  test('4b · a deletion that FAILS leaves no tombstone (rolled back with it) — the job is not blocked by it', async () => {
    // pg-mem does not undo writes on ROLLBACK, so this is proven on real
    // Postgres in sourceDeletion.live.test.js; here: the tombstone is the 2nd
    // statement of the SAME transaction that the failure rolls back.
    const O = freshOwner();
    const statements = [];
    const spyPool = { connect: async () => { const c = await mem.pool.connect(); return { query: (s, p) => { statements.push(String(s).trim()); return c.query(s, p); }, release: () => c.release() }; } };
    await assert.rejects(SD.forgetExternalSourceClaims(O, { ukoPrefix: SRC_A }, { pool: spyPool, ...noVectors(), failAfterWrites: () => { throw new Error('boom'); } }));
    const begin = statements.indexOf('BEGIN'), tomb = statements.findIndex(s => /^INSERT INTO aqua_external_deletions/.test(s));
    assert.ok(begin === 0 && tomb === 2 && statements.includes('ROLLBACK') && !statements.includes('COMMIT'));
  });

  test('5 · retry after source deletion: the same job is refused on every attempt; a re-added resource is understood once', async () => {
    const O = freshOwner(), id = uko(SRC_A, '1'), text = sentence();
    const enqueuedAt = past();
    await del(O, { ukoPrefix: SRC_A });
    for (let attempt = 1; attempt <= 3; attempt++) {
      assert.ok(refused(await commitJob(O, { ukoId: id, text, enqueuedAt })), `attempt ${attempt} wrote`);
    }
    assert.deepEqual(await extRows(O, SRC_A), GONE);
    // the user connects the source again: a NEW job, enqueued after the deletion
    const readdAt = later(1000);
    const first = await commitJob(O, { ukoId: id, text, enqueuedAt: readdAt });
    assert.equal(first.claims.length, 1, JSON.stringify(first));
    // idempotency preserved: the re-added job's retry writes nothing new
    const again = await commitJob(O, { ukoId: id, text, enqueuedAt: readdAt });
    assert.equal(again.skipped, true);
    assert.notEqual(again.reason, 'source-deleted');
    assert.deepEqual(await extRows(O, id), ONE);
    assert.equal((await saying(O, text)).length, 1);
  });

  test('a commit without an enqueue time is refused conservatively once its source was deleted', async () => {
    const O = freshOwner();
    await del(O, { ukoPrefix: SRC_A });
    assert.ok(refused(await commitJob(O, { ukoId: uko(SRC_A, '1'), text: sentence(), enqueuedAt: undefined })));
    assert.ok(refused(await commitJob(O, { ukoId: uko(SRC_A, '1'), text: sentence(), enqueuedAt: 'not a date' })));
  });

  test('unrelated work is never blocked: uploads, conversation turns, other sources, other owners', async () => {
    const O = freshOwner(), P = freshOwner();
    await del(O, { ukoPrefix: SRC_A });
    assert.equal((await commitJob(O, { text: sentence(), hash: 'a'.repeat(64) })).claims.length, 1, 'an upload was blocked');
    assert.equal((await commitJob(O, { ukoId: uko(SRC_B, '1'), text: sentence(), enqueuedAt: past() })).claims.length, 1, 'another source was blocked');
    assert.equal((await commitJob(P, { ukoId: uko(SRC_A, '1'), text: sentence(), enqueuedAt: past() })).claims.length, 1, 'another owner was blocked');
    const text = sentence();
    const turn = await WM.commitUnderstanding({ ownerId: O, sourceId: canonicalTurnSourceId(O, 'conv-x', 1), actor: 'e6:test',
      extractorVersion: 'e6-race', segmentRange: { start: 0, end: text.length }, sourceKind: 'conversation',
      externalRef: 'conv-x:turn:1', assertedAt: new Date(), claims: [claimFor(text)] });
    assert.equal(turn.claims.length, 1, 'a conversation turn was blocked');
  });

  test('owner purge removes the owner\'s tombstones', async () => {
    const O = freshOwner();
    await del(O, { ukoPrefix: SRC_A });
    assert.equal(Number((await q('SELECT count(*)::int AS n FROM aqua_external_deletions WHERE owner_id = $1', [O])).rows[0].n), 1);
    await WM.purgeOwner(O);
    assert.equal(Number((await q('SELECT count(*)::int AS n FROM aqua_external_deletions WHERE owner_id = $1', [O])).rows[0].n), 0);
  });
});

describe('G1-1 tagging (acceptance C) · an external email and an upload with IDENTICAL content', () => {
  // Same sentence, same content hash, same file name, same chunk — the only
  // difference is where it came from.
  const EMAIL = uko(SRC_A, 'e');       // e.g. one Gmail message of connection A
  const HASH = 'c'.repeat(64);
  const sourceRow = async (owner, id) => (await q('SELECT source_id, external_ref, kind FROM aqua_sources WHERE owner_id = $1 AND source_id = $2', [owner, id])).rows[0] ?? null;
  const evidenceOf = async (owner, claimId) => (await q(
    `SELECT s.external_ref, ce.role FROM aqua_claim_evidence ce JOIN aqua_evidence e ON e.evidence_id = ce.evidence_id
       JOIN aqua_sources s ON s.source_id = e.source_id WHERE ce.owner_id = $1 AND ce.claim_id = $2`, [owner, claimId])).rows
    .map(r => `${String(r.external_ref).split(':')[0]}:${r.role}`).sort();

  test('they never share a source identity (id, external_ref) — however the worker derives it', async () => {
    const O = freshOwner(), text = sentence();
    const email = await commitJob(O, { ukoId: EMAIL, text, enqueuedAt: past(), hash: HASH });
    const upload = await commitJob(O, { text, hash: HASH });
    const emailSource = canonicalTurnSourceId(O, `extuko:${EMAIL}`, 1);
    const uploadSource = canonicalTurnSourceId(O, `file:${HASH.slice(0, 32)}`, 1);
    assert.notEqual(emailSource, uploadSource);
    assert.equal(email.claims.length, 1); assert.equal(upload.claims.length, 1);
    const e = await sourceRow(O, emailSource), u = await sourceRow(O, uploadSource);
    assert.ok(e && u, 'both sources exist');
    assert.match(e.external_ref, /^extuko:ext_/);
    assert.match(u.external_ref, /^file:/);
    // nothing an external deletion scans for can ever match an upload's ref
    assert.equal(G.ukoIdFromExternalRef(u.external_ref), null);
    // the worker's derivation (workerRuntime DOCUMENT_JOB): external → extuko:<ukoId>, upload → file:<hash32>
    const worker = fs.readFileSync(new URL('../jobs/workerRuntime.js', import.meta.url), 'utf8');
    assert.match(worker, /\? `extuko:\$\{p\.ukoId\}`\s*: `file:\$\{String\(p\.hash \?\? p\.ukoId \?\? 'unknown'\)\.slice\(0, 32\)\}`/);
  });

  test('separate claims: deleting the external source leaves the upload\'s claim, evidence and source intact', async () => {
    const O = freshOwner(), text = sentence();
    const email = await commitJob(O, { ukoId: EMAIL, text, enqueuedAt: past(), hash: HASH });
    const upload = await commitJob(O, { text, hash: HASH });
    const d = await del(O, { ukoPrefix: SRC_A });
    assert.ok(d.complete);
    assert.deepEqual(await saying(O, text), [upload.claims[0].claimId]);
    assert.notEqual(email.claims[0].claimId, upload.claims[0].claimId);
    assert.deepEqual(await evidenceOf(O, upload.claims[0].claimId), ['file:primary']);
    assert.ok(await sourceRow(O, canonicalTurnSourceId(O, `file:${HASH.slice(0, 32)}`, 1)), 'the upload\'s source was deleted');
  });

  test('one shared claim, upload FIRST: deleting the external source keeps the claim with only the upload\'s evidence', async () => {
    const O = freshOwner(), text = sentence();
    const upload = await commitJob(O, { text, hash: HASH });
    const id = upload.claims[0].claimId;
    await commitJob(O, { ukoId: EMAIL, text, enqueuedAt: past(), hash: HASH, attachTo: id });
    assert.deepEqual(await evidenceOf(O, id), ['extuko:corroborating', 'file:primary']);
    const d = await del(O, { ukoPrefix: SRC_A });
    assert.ok(d.complete);
    assert.equal(d.counts.claimsDeleted, 0);
    assert.equal(d.counts.claimsKept, 1);
    assert.deepEqual(await saying(O, text), [id]);
    assert.deepEqual(await evidenceOf(O, id), ['file:primary']);
  });

  test('one shared claim, external FIRST: the upload\'s corroboration keeps the claim alive', async () => {
    const O = freshOwner(), text = sentence();
    const email = await commitJob(O, { ukoId: EMAIL, text, enqueuedAt: past(), hash: HASH });
    const id = email.claims[0].claimId;
    await commitJob(O, { text, hash: HASH, attachTo: id });
    assert.deepEqual(await evidenceOf(O, id), ['extuko:primary', 'file:corroborating']);
    const d = await del(O, { ukoPrefix: SRC_A });
    assert.ok(d.complete);
    assert.equal(d.counts.claimsDeleted, 0, 'the upload\'s knowledge was deleted with the external source');
    assert.deepEqual(await saying(O, text), [id]);
    assert.deepEqual(await evidenceOf(O, id), ['file:corroborating']);
    assert.equal(Number((await q(`SELECT count(*)::int AS n FROM aqua_claims WHERE owner_id = $1 AND claim_id = $2 AND state IN ('active','trusted')`, [O, id])).rows[0].n), 1);
  });
});

describe('G1-1 race · plumbing of the enqueue time', () => {
  test('worker → understandTurn → commit carry the job\'s created_at for external resources only', () => {
    // The full path runs only on live Postgres (S8 full-text search); these are
    // the three hand-offs, read from the source so a refactor cannot drop one silently.
    const src = f => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.match(src('../jobs/workerRuntime.js'), /external \? \{ ukoId: p\.ukoId, enqueuedAt: job\.createdAt \?\? null \}/);
    assert.match(src('../../brain/index.js'), /doc\.enqueuedAt \? \{ enqueuedAt: doc\.enqueuedAt \}/);
    assert.match(src('../worldModel/worldModelRepository.js'), /enqueuedAt: input\.enqueuedAt \?\? null/);
  });
});

describe('G1-1 race · guard unit', () => {
  test('ukoIdFromExternalRef reads only extuko refs', () => {
    const id = uko(SRC_A, '1');
    assert.equal(G.ukoIdFromExternalRef(SD.externalUnderstandingRef(id, 3)), id);
    assert.equal(G.ukoIdFromExternalRef('file:notes.md:chunk:0'), null);
    assert.equal(G.ukoIdFromExternalRef('conv-1:turn:2'), null);
    assert.equal(G.ukoIdFromExternalRef('extuko:not-a-uko:chunk:0'), null);
    assert.equal(G.ukoIdFromExternalRef(null), null);
  });
  test('externalSourceLockKey refuses a non-external scope', () => {
    assert.throws(() => G.externalSourceLockKey('o', 'file:x'));
    assert.throws(() => G.externalSourceLockKey('o', ''));
  });
  test('a tombstone covers a ukoId only by prefix, never the kept version, and only for work enqueued at or before it', async () => {
    const t = new Date('2026-11-20T10:00:00Z');
    const client = { query: async () => ({ rows: [{ uko_prefix: item(SRC_A, '1'), keep_uko_id: uko(SRC_A, '1', '222'), deleted_at: t }] }) };
    const check = (ukoId, enqueuedAt) => G.externalSourceDeletedSince(client, { ownerId: 'o', ukoId, enqueuedAt });
    assert.equal(await check(uko(SRC_A, '1', '111'), new Date(t.getTime() - 1)), true);
    assert.equal(await check(uko(SRC_A, '1', '111'), t), true, 'same instant: blocked');
    assert.equal(await check(uko(SRC_A, '1', '111'), new Date(t.getTime() + 1)), false, 'enqueued after');
    assert.equal(await check(uko(SRC_A, '1', '222'), new Date(t.getTime() - 1)), false, 'kept version');
    assert.equal(await check(uko(SRC_A, '2'), new Date(t.getTime() - 1)), false, 'other resource');
  });
});
