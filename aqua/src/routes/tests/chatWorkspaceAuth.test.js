/**
 * Chat may only use a workspace the session owns (audit 2026-10-12).
 *
 * /project/workspace/:id checked ownership; POST /chat and /chat/stream did
 * not — `workspaceId` from the body went straight into project retrieval, so
 * a signed-in user holding someone else's workspace id got that workspace's
 * source injected into their own answer (and the edit branch could propose
 * patches against it).
 *
 * Harness: the real chat router with the platform identity injected the way
 * index.js does it (req.aquaUserId). No provider is configured — every key
 * variable is scrubbed below — so generation fails AFTER the turn's context is
 * assembled. What the test observes is the handler's own line
 * `[PROJECT] Context injected workspace=<id>`, printed by prepareTurn exactly
 * when a workspace's files enter the model input. Alice asking about her own
 * workspace is the positive control: without it, "Bob saw nothing" could pass
 * because retrieval never runs at all.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-chat-ws-auth-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
// No network: no model provider, no web search.
for (const k of Object.keys(process.env)) {
  if (/(_API_KEY|^GEMINI_KEY|^SERPER|^TAVILY|^OPENROUTER|^NVIDIA_API|^GROQ)/.test(k)) delete process.env[k];
}

const { default: chatRoute }   = await import('../chat.js');
const { createWorkspace }      = await import('../../project/workspaceManager.js');
const { buildIndex }           = await import('../../project/projectIndex.js');
const { canAccessWorkspace, authorizedWorkspaceId } = await import('../../project/workspaceAccess.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const u = req.headers['x-test-user'];
  if (u) req.aquaUserId = String(u);
  next();
});
app.use('/chat', chatRoute);

let server, base, aliceWs;

const SECRET = 'ALICE_PRIVATE_SIGNING_SECRET_7f3a';

before(() => {
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  aliceWs = createWorkspace({ name: 'alice-repo', ownerId: 'user:alice' }).id;
  buildIndex(aliceWs, [
    { path: 'src/auth/signing.js', content: `export const SIGNING_KEY = '${SECRET}';\nexport function sign(x) { return x + SIGNING_KEY; }`, lang: 'js', size: 120 },
    { path: 'src/index.js', content: "import { sign } from './auth/signing.js';\nexport default sign;", lang: 'js', size: 70 },
  ]);
});

after(() => server.close());

/** POST to the real handler and return every log line it printed. */
async function postCapturing(route, { user, body }) {
  const lines = [];
  const orig = { log: console.log, warn: console.warn };
  console.log  = (...a) => { lines.push(a.join(' ')); };
  console.warn = (...a) => { lines.push(a.join(' ')); };
  let status;
  try {
    const res = await fetch(base + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': user },
      body: JSON.stringify(body),
    });
    status = res.status;
    await res.text();   // drain (SSE for /stream)
  } finally {
    console.log = orig.log; console.warn = orig.warn;
  }
  return { status, lines };
}

const injected = (lines, ws) => lines.some(l => l.includes(`[PROJECT] Context injected workspace=${ws}`));
const QUESTION = 'Explain the architecture of this codebase and how signing works';

test('rule: the owner may use the workspace; another session may not; no session = dev passthrough', () => {
  assert.equal(canAccessWorkspace('alice', aliceWs), true);
  assert.equal(canAccessWorkspace('bob', aliceWs), false);
  assert.equal(canAccessWorkspace(null, aliceWs), true);
  assert.equal(canAccessWorkspace('alice', 'no-such-workspace'), false);
  assert.equal(authorizedWorkspaceId('bob', aliceWs), null);
  assert.equal(authorizedWorkspaceId('alice', aliceWs), aliceWs);
});

for (const route of ['/chat', '/chat/stream']) {
  test(`${route}: positive control — the owner's turn injects her workspace`, async () => {
    const { lines } = await postCapturing(route, { user: 'alice', body: { message: QUESTION, workspaceId: aliceWs } });
    assert.ok(injected(lines, aliceWs), `expected project context for the owner; log:\n${lines.filter(l => l.includes('[PROJECT]')).join('\n')}`);
  });

  test(`${route}: another user's turn with her workspaceId gets none of it`, async () => {
    const { lines } = await postCapturing(route, { user: 'bob', body: { message: QUESTION, workspaceId: aliceWs } });
    assert.equal(injected(lines, aliceWs), false, 'Alice\'s workspace reached Bob\'s model input');
    assert.ok(lines.some(l => l.includes('[CHAT] workspace ignored')), 'the drop is logged');
    assert.ok(!lines.some(l => l.includes(SECRET)), 'no line carries her source');
  });

  test(`${route}: an edit instruction against her workspace never reaches the edit engine`, async () => {
    const { lines } = await postCapturing(route, { user: 'bob', body: { message: 'Rename sign to signPayload in src/auth/signing.js', workspaceId: aliceWs } });
    assert.ok(!lines.some(l => /\[EDIT\]/.test(l) && l.includes(aliceWs)), 'edit pipeline ran against a foreign workspace');
    assert.equal(injected(lines, aliceWs), false);
  });
}
