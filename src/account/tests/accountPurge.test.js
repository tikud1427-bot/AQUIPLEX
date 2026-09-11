/**
 * Account Purge — erasure regression suite (Google Play User Data policy)
 *
 * Run: node --test src/account/tests/accountPurge.test.js   (aqua/ package)
 *
 * Runs against the REAL stores (no mocks) in an isolated data directory, with
 * TWO users seeded across every subsystem the engine persists. The contract
 * under test is two-sided and both sides matter equally:
 *
 *   ERASURE   — after purging user A, nothing of A's remains anywhere,
 *               including the trash snapshot that a normal single-conversation
 *               delete deliberately keeps.
 *   ISOLATION — user B is byte-for-byte untouched. A deletion that also
 *               damages a bystander is a worse bug than one that under-deletes.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-account-purge-'));
process.env.AQUA_DATA_DIR = TMP;
process.env.AQUA_ARTIFACTS_DIR = path.join(TMP, 'artifacts');
process.chdir(TMP);

const ALICE = 'alice-user-id';
const BOB   = 'bob-user-id';
const ALICE_OWNER = `user:${ALICE}`;
const BOB_OWNER   = `user:${BOB}`;

let purge, convStore, attachments, mindStore, facts, ukoStore, evidenceStore,
    fileIndex, graph, picStore, artifacts, workspaces, uko, ownerResolver;

/** Seed one user across every persistent subsystem. Returns the seeded ids. */
async function seedUser(userId, ownerId, tag) {
  const conversationId = `conv-${tag}`;
  convStore.createConversation({ id: conversationId, userId });
  convStore.addMessage(conversationId, 'user', `hello from ${tag}`);
  convStore.addMessage(conversationId, 'assistant', `hi ${tag}`);

  attachments.attachToConversation(conversationId, {
    name: `${tag}.txt`,
    kind: 'document',
    normalized: {
      format: 'txt', title: `${tag}.txt`, content: `secret ${tag} content`,
      metadata: {}, sections: [], pages: null, language: 'en', truncated: false,
    },
  });

  facts.storeFact(ownerId, { key: 'name', value: tag, confidence: 0.9 });

  const obj = uko.createUKO({
    ownerId,
    conversationId,
    sourceFile: { name: `${tag}.pdf`, ext: '.pdf', bytes: 100, hash: `hash-${tag}` },
    fileType: 'document',
  });
  obj.entities = [{ type: 'org', value: `${tag}-corp`, count: 1 }];
  obj.keywords = [{ term: tag, count: 3 }];
  ukoStore.saveUKO(obj);
  ukoStore.cacheKnowledge(obj);
  fileIndex.indexUKO(ownerId, obj);

  evidenceStore.saveFact(ownerId, {
    id: `fact-${tag}`, claim: `${tag} claim`, evidence: [], createdAt: Date.now(),
  }, { sourceFileId: obj.id });

  graph.upsertNode(ownerId, { id: `node-${tag}`, type: 'entity', label: `${tag}-corp` });
  picStore.ledger(ownerId, 'seed', { tag });

  const artifact = await artifacts.createArtifact({
    ownerId, conversationId, requestId: `req-${tag}`,
    format: 'md', title: `${tag} notes`, packaging: 'raw',
    spec: { format: 'md', title: `${tag} notes`, files: [{ path: 'notes.md' }], packaging: 'raw' },
    files: [{ path: 'notes.md', buffer: Buffer.from(`# ${tag}`), mime: 'text/markdown' }],
  });

  const ws = workspaces.createWorkspace({ ownerId, name: `${tag}-project` });

  return { conversationId, ukoId: obj.id, artifactId: artifact.id, workspaceId: ws.id };
}

let alice, bob, report;

before(async () => {
  purge          = await import('../accountPurge.js');
  convStore      = await import('../../memory/conversationStore.js');
  attachments    = await import('../../upload/attachmentStore.js');
  mindStore      = await import('../../mind/mindStore.js');
  facts          = await import('../../memory/longTermMemory.js');
  ukoStore       = await import('../../files/ukoStore.js');
  evidenceStore  = await import('../../files/evidenceStore.js');
  fileIndex      = await import('../../files/fileSearchIndex.js');
  graph          = await import('../../reasoning/reasoningGraph.js');
  picStore       = await import('../../pic/picStore.js');
  artifacts      = await import('../../artifacts/artifactStore.js');
  workspaces     = await import('../../project/workspaceManager.js');
  uko            = await import('../../files/uko.js');
  ownerResolver  = await import('../../memory/ownerResolver.js');

  alice = await seedUser(ALICE, ALICE_OWNER, 'alice');
  bob   = await seedUser(BOB,   BOB_OWNER,   'bob');

  // A conversation Alice deleted BEFORE requesting account deletion: the
  // normal delete path snapshots it into the trash on purpose.
  convStore.createConversation({ id: 'conv-alice-old', userId: ALICE });
  convStore.addMessage('conv-alice-old', 'user', 'older alice message');
  convStore.clearConversation('conv-alice-old');

  report = await purge.purgeOwnerData({ userId: ALICE });
});

// No cleanup hook on purpose: the stores flush on a debounce, so tearing the
// temp directory down here races them into ENOENT noise. mkdtemp lives under
// the OS temp dir — same discipline as the other store-backed suites.

// ── Contract ─────────────────────────────────────────────────────────────────

test('purge requires a userId', async () => {
  await assert.rejects(() => purge.purgeOwnerData({}), /requires a userId/);
});

test('purge reports no errors and resolves the canonical owner', () => {
  assert.deepEqual(report.errors, []);
  assert.equal(report.ownerId, ownerResolver.ownerForUser(ALICE));
});

// ── Erasure ──────────────────────────────────────────────────────────────────

test('conversations, messages, and attachments are gone', () => {
  assert.equal(convStore.conversationExists(alice.conversationId), false);
  assert.equal(convStore.getConversation(alice.conversationId).length, 0);
  assert.equal(attachments.getAttachments(alice.conversationId).length, 0);
  assert.equal(report.conversations, 1);
});

test('previously deleted conversations do not survive in the trash snapshot', () => {
  const trash = path.join(TMP, '.aqua-history-trash.json');
  const raw = fs.existsSync(trash) ? fs.readFileSync(trash, 'utf8') : '[]';
  assert.equal(raw.includes('older alice message'), false);
  assert.equal(raw.includes(ALICE), false);
});

test('mind, facts, and conversation-scoped mind are gone', () => {
  assert.equal(mindStore.peekMind(ALICE_OWNER), null);
  assert.deepEqual(facts.getFacts(ALICE_OWNER), []);
  assert.equal(mindStore.peekMind(ownerResolver.ownerForConversation(alice.conversationId)), null);
});

test('file intelligence is gone: UKOs, content cache, index, evidence, graph', () => {
  assert.deepEqual(ukoStore.listUKOs(ALICE_OWNER), []);
  assert.equal(ukoStore.getCachedKnowledge('hash-alice', 'document'), null);
  assert.equal(fileIndex.getIndexStats(ALICE_OWNER).files, 0);
  assert.equal(evidenceStore.getEvidenceStats(ALICE_OWNER).facts, 0);
  assert.equal(graph.graphStats(ALICE_OWNER).nodes, 0);
});

test('PIC bucket is gone', () => {
  assert.deepEqual(picStore.getLedger(ALICE_OWNER), []);
});

test('artifacts are gone from the index AND from disk', async () => {
  assert.deepEqual(artifacts.listArtifacts({ ownerId: ALICE_OWNER }), []);
  assert.equal(await artifacts.getArtifact(alice.artifactId), null);
  assert.equal(fs.existsSync(path.join(process.env.AQUA_ARTIFACTS_DIR, alice.artifactId)), false);
  assert.equal(report.artifacts, 1);
});

test('workspaces are gone', () => {
  assert.equal(workspaces.getWorkspace(alice.workspaceId), null);
  assert.equal(report.workspaces, 1);
});

// ── Isolation ────────────────────────────────────────────────────────────────

test("the other user's data is completely untouched", async () => {
  assert.equal(convStore.conversationExists(bob.conversationId), true);
  assert.equal(convStore.getConversation(bob.conversationId).length, 2);
  assert.equal(attachments.getAttachments(bob.conversationId).length, 1);

  assert.notEqual(mindStore.peekMind(BOB_OWNER), null);
  assert.equal(ukoStore.listUKOs(BOB_OWNER).length, 1);
  assert.equal(ukoStore.getCachedKnowledge('hash-bob', 'document')?.fileType, 'document');
  assert.equal(fileIndex.getIndexStats(BOB_OWNER).files, 1);
  assert.equal(evidenceStore.getEvidenceStats(BOB_OWNER).facts, 1);
  assert.equal(graph.graphStats(BOB_OWNER).nodes, 1);
  assert.equal(picStore.getLedger(BOB_OWNER).length, 1);
  assert.equal(artifacts.listArtifacts({ ownerId: BOB_OWNER }).length, 1);
  assert.notEqual(await artifacts.getArtifact(bob.artifactId), null);
  assert.notEqual(workspaces.getWorkspace(bob.workspaceId), null);
});

// ── Idempotence ──────────────────────────────────────────────────────────────

test('purging twice is safe and reports nothing left to remove', async () => {
  const second = await purge.purgeOwnerData({ userId: ALICE });
  assert.deepEqual(second.errors, []);
  assert.equal(second.conversations, 0);
  assert.equal(second.artifacts, 0);
  assert.equal(second.workspaces, 0);
  assert.equal(second.ukos, 0);
});

test('purging an unknown user is a no-op, not an error', async () => {
  const none = await purge.purgeOwnerData({ userId: 'nobody-at-all' });
  assert.deepEqual(none.errors, []);
  assert.equal(none.conversations, 0);
  assert.equal(convStore.conversationExists(bob.conversationId), true);
});
