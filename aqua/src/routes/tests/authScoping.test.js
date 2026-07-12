/**
 * Phase 1 security — cross-user access scoping (IDOR + adoption abuse).
 * Boots the real conversations + memory routers in-process; a header-driven
 * middleware sets req.aquaUserId to simulate different authenticated users.
 * Run: node src/routes/tests/authScoping.test.js
 */
import assert from 'node:assert';
import express from 'express';
import conversationsRoute from '../conversations.js';
import memoryRoute from '../memory.js';
import { getOrCreateConversation, conversationExists } from '../../memory/conversationStore.js';
import { storeFact, getFacts } from '../../memory/longTermMemory.js';

// Simulate the platform mount: x-test-user header → req.aquaUserId. Absent
// header = dev/standalone (no session), exactly like the bare engine.
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const u = req.headers['x-test-user'];
  if (u) req.aquaUserId = String(u);
  next();
});
app.use('/conversations', conversationsRoute);
app.use('/memory', memoryRoute);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const req = async (method, path, { user, body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: json };
};

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  \u2713 ${name}`); }
  catch (e) { failed++; console.error(`  \u2717 ${name}\n    ${e.message}`); }
}

// ── Seed: Alice owns convA (+ a fact); Bob owns convB ────────────────────────
// Conversation meta stores the RAW aquaUserId (the contract the list endpoint
// and the mount use). The memory owner is the `user:<id>` form resolveOwner
// produces — that's the key facts live under.
const USER_A = 'aliceid';
const USER_B = 'bobid';
const { id: convA } = getOrCreateConversation(null, { userId: USER_A });
const { id: convB } = getOrCreateConversation(null, { userId: USER_B });
storeFact(`user:${USER_A}`, { key: 'favorite_language', value: 'Rust', confidence: 0.99, importance: 8 });

console.log('conversations — object-level authorization');

await test('owner CAN read own conversation', async () => {
  const r = await req('GET', `/conversations/${convA}`, { user: USER_A });
  assert.equal(r.status, 200);
});
await test('attacker CANNOT read another user\'s conversation (404, not 200)', async () => {
  const r = await req('GET', `/conversations/${convA}`, { user: USER_B });
  assert.equal(r.status, 404);
});
await test('attacker CANNOT delete another user\'s conversation', async () => {
  const r = await req('DELETE', `/conversations/${convA}`, { user: USER_B });
  assert.equal(r.status, 404);
  assert.ok(conversationExists(convA), 'convA must still exist after blocked delete');
});
await test('dev mode (no session) still reads any conversation', async () => {
  const r = await req('GET', `/conversations/${convA}`);
  assert.equal(r.status, 200);
});
await test('owner CAN delete own conversation', async () => {
  const r = await req('DELETE', `/conversations/${convB}`, { user: USER_B });
  assert.equal(r.status, 200);
});

console.log('memory — legacy conversation-keyed routes cannot cross users');

await test('attacker reading /memory/{victimConv} does NOT get victim facts', async () => {
  const r = await req('GET', `/conversations/${convA}`, { user: USER_A }); // ensure convA still owned by A
  assert.equal(r.status, 200);
  const m = await req('GET', `/memory/${convA}`, { user: USER_B });
  assert.equal(m.status, 404, 'must be blocked before resolveOwner adoption runs');
});
await test('victim facts intact after blocked cross-user memory access', async () => {
  const facts = getFacts(`user:${USER_A}`);
  assert.ok(facts.some(f => f.key === 'favorite_language' && f.value === 'Rust'),
    'Alice\'s fact must not have been siphoned/tombstoned');
});
await test('owner CAN read own memory via owner-scoped route', async () => {
  const r = await req('GET', '/memory', { user: USER_A });
  assert.equal(r.status, 200);
  assert.ok(r.body.facts.some(f => f.key === 'favorite_language'));
});
await test('attacker\'s own memory is empty (self-scoped, unaffected)', async () => {
  const r = await req('GET', '/memory', { user: USER_B });
  assert.equal(r.status, 200);
  assert.ok(!r.body.facts.some(f => f.key === 'favorite_language'));
});

server.close();
console.log(`\nauthScoping: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
