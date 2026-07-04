/**
 * Day 4 — HTTP integration test for the edit routes.
 * Boots the real express routers in-process; LLM step bypassed by
 * registering a handcrafted proposal through the editEngine test hook.
 * Run: node src/project/tests/editRoutes.test.js
 */
import assert from 'node:assert';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import projectRoute from '../../routes/project.js';
import { __registerProposalForTests, contentHash } from '../editEngine.js';
import { diffFile } from '../diffEngine.js';
import { getIndex } from '../projectIndex.js';

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use('/project', projectRoute);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const req = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
};

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

let wsId;

await test('create + index workspace', async () => {
  const create = await req('POST', '/project/workspace', { name: 'day4-int-test' });
  wsId = create.body.workspace.id;
  const upload = await req('POST', `/project/workspace/${wsId}/files`, {
    files: [
      { path: 'src/util.js', content: 'export function helper() {\n  return 42;\n}\n' },
      { path: 'src/main.js', content: "import { helper } from './util.js';\nconsole.log(helper());\n" },
    ],
  });
  assert.equal(upload.status, 200);
  assert.equal(upload.body.filesIngested, 2);
});

await test('file-content now serves live index content + graph links', async () => {
  const r = await req('GET', `/project/workspace/${wsId}/file-content?path=src/util.js`);
  assert.equal(r.status, 200);
  assert.ok(r.body.file.content.includes('return 42'));
  assert.deepEqual(r.body.file.importedBy, ['src/main.js']);
});

function craftProposal(baseHashOverride) {
  const original = getIndex(wsId).byPath.get('src/util.js').content;
  const modified = original.replace('return 42', 'return 43');
  const p = {
    id: uuidv4(), workspaceId: wsId, createdAt: Date.now(), status: 'proposed',
    instruction: 'bump helper', summary: 'Bump helper return value', reasoning: '', impact: '',
    risks: [], breakingChanges: [], relatedFiles: [], failedOperations: [],
    files: [{
      path: 'src/util.js', changeType: 'modify', explanation: 'bump', lang: 'javascript',
      original, modified, baseHash: baseHashOverride ?? contentHash(original),
      appliedOps: 1, diff: diffFile('src/util.js', original, modified),
    }],
    stats: { filesChanged: 1, added: 1, removed: 1 },
    verification: { ran: true, passed: true, checks: [], warnings: [] },
  };
  __registerProposalForTests(p);
  return p;
}

await test('edit endpoint validates missing instruction', async () => {
  const r = await req('POST', `/project/workspace/${wsId}/edit`, {});
  assert.equal(r.status, 400);
});

await test('list + fetch proposal (serialized: hunks, no raw content)', async () => {
  const p = craftProposal();
  const list = await req('GET', `/project/workspace/${wsId}/edits`);
  assert.ok(list.body.proposals.some((x) => x.id === p.id));
  const one = await req('GET', `/project/workspace/${wsId}/edit/${p.id}`);
  assert.equal(one.status, 200);
  assert.ok(one.body.proposal.files[0].hunks.length >= 1);
  assert.equal(one.body.proposal.files[0].original, undefined); // wire format strips contents
});

await test('apply conflict → 409 with per-file reasons', async () => {
  const p = craftProposal('deadbeef:0');
  const r = await req('POST', `/project/workspace/${wsId}/edit/${p.id}/apply`);
  assert.equal(r.status, 409);
  assert.equal(r.body.conflicts.length, 1);
  assert.ok(r.body.suggestion);
});

await test('apply → index updated; re-apply blocked; revert restores', async () => {
  const p = craftProposal();
  const r = await req('POST', `/project/workspace/${wsId}/edit/${p.id}/apply`);
  assert.equal(r.status, 200);
  assert.ok(getIndex(wsId).byPath.get('src/util.js').content.includes('return 43'));

  const again = await req('POST', `/project/workspace/${wsId}/edit/${p.id}/apply`);
  assert.equal(again.status, 400);

  const rev = await req('POST', `/project/workspace/${wsId}/edit/${p.id}/revert`);
  assert.equal(rev.status, 200);
  assert.ok(getIndex(wsId).byPath.get('src/util.js').content.includes('return 42'));
});

await test('reject → cannot apply after', async () => {
  const p = craftProposal();
  const rej = await req('POST', `/project/workspace/${wsId}/edit/${p.id}/reject`);
  assert.equal(rej.status, 200);
  const r = await req('POST', `/project/workspace/${wsId}/edit/${p.id}/apply`);
  assert.equal(r.status, 400);
});

await test('unknown proposal → 404', async () => {
  const r = await req('GET', `/project/workspace/${wsId}/edit/nope`);
  assert.equal(r.status, 404);
});

// cleanup
await req('DELETE', `/project/workspace/${wsId}`);
server.close();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
