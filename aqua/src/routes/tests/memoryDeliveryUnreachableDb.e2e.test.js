/**
 * P0 2026-10-12 — known user information must reach the answer context when
 * the canonical store is configured but DOWN.
 *
 * The incident: DATABASE_URL pointed at a Postgres that had been down for five
 * days. `canonicalReadMode()` only checks that a URL is SET, so every turn ran
 * the default 'authoritative' read:
 *   · retrieval ranked the owner's legacy facts (MEMORY_RANKED candidates=13),
 *   · `legacyVetoFor` could not query aqua_claims and failed CLOSED — `() => true`
 *     — vetoing every one of them and the whole identity card → NO_MEMORIES,
 *   · the Context Engine ran canonical-only, its lanes could not connect, and
 *     the PIC floor was excluded by design → facts=0 entities=0 timeline=0.
 * The user's own name, employer and co-founder never reached the model.
 *
 * This drives the real `prepareTurn` (the function /chat and /chat/stream
 * build the model input with) against a database URL that refuses
 * connections, with the SHIPPING read mode (AQUA_CANONICAL_READ unset), and
 * asserts on `prep.systemPrompt` — the string handed to generateText().
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR             = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-dbdown-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI                 = '';
// Configured, unreachable: port 1 refuses on every platform.
process.env.DATABASE_URL              = 'postgresql://aqua:aqua@127.0.0.1:1/aqua_unreachable';
process.env.AQUA_CONTEXT_V2           = 'on';
process.env.AQUA_E6                   = 'on';
process.env.AQUA_BRAIN_INGEST         = 'on';
process.env.AQUA_BRAIN_INGEST_FACTS   = 'on';
delete process.env.AQUA_CANONICAL_READ;   // the shipping default: authoritative

const pool              = await import('../../core/db/pool.js');
pool._resetForTests();
const { prepareTurn }   = await import('../chat.js');
const { createContext } = await import('../../core/observability.js');
const mem               = await import('../../memory/engine.js');
const Brain             = await import('../../brain/index.js');
const { getFacts }      = await import('../../memory/longTermMemory.js');

const USER_ID = 'dbdown';
const OWNER   = `user:${USER_ID}`;
const CONV    = 'c-dbdown-seed';

const SESSION = [
  "I'm Maya. I run product at Nummo, a fintech in Bangalore.",
  'My co-founder Dev runs engineering.',
  'Razorpay is our main competitor',
];

let prep;
let ask;

before(async () => {
  let turn = 0;
  for (const t of SESSION) {
    mem.memoryObserve(OWNER, { userMessage: t, taskType: 'personal_info', conversationId: CONV, userId: USER_ID, requestId: 'seed' });
    await Brain.observeConversationTurn({ ownerId: OWNER, conversationId: CONV, turn: turn++, userMessage: t, assistantMessage: 'Got it.' });
  }
  ask = async (question, conv) => prepareTurn({
    userMessage: question, workspaceId: null, conversationId: conv, userId: USER_ID,
    ctx: createContext({ conversationId: conv, requestId: `dbdown-${conv}` }), requestId: `dbdown-${conv}`,
    skipReasoningPass: true,
  });
  // A NEW conversation: nothing from the seed turns is in chat history.
  prep = await ask('Where do I work and who is my co-founder?', 'c-dbdown-ask');
  stored = getFacts(OWNER);
});
let stored = [];

test('precondition: the database is configured but not reachable, and the configured mode is authoritative', async () => {
  assert.equal(pool.isConfigured(), true);
  assert.equal(await pool.isReachable(), false);
  assert.equal(Brain.canonicalReadMode(), 'authoritative', 'the incident ran with the default read mode');
});

test('the defect, pinned: the fail-closed veto withholds every legacy fact when the canonical store is down', async () => {
  // This is the exact function the authoritative read used. Kept fail-closed
  // (a reachable World Model that errors mid-query must not let a stale fact
  // through) — which is why the turn must not take this path at all when the
  // store is unreachable.
  const veto = await Brain.legacyVetoFor(OWNER);
  assert.equal(veto({ key: 'workplace', value: 'Nummo' }), true);
});

test('the turn serves the legacy read, marked degraded, instead of the empty authoritative one', () => {
  assert.deepEqual(
    { mode: prep.readState.mode, degraded: prep.readState.degraded, configured: prep.readState.configured },
    { mode: 'legacy', degraded: true, configured: 'authoritative' });
});

test('every stored user fact reaches the model input (systemPrompt) — nothing ranked is discarded', () => {
  // Legacy regex memory holds name + co-founder for this session (the employer
  // sentence is E6's to extract, and E6 needs the canonical store). Assert on
  // what is STORED so the check can never pass vacuously.
  assert.ok(stored.length >= 2, `fixture stored ${stored.length} legacy facts — fix the fixture, do not weaken this`);
  const sp = String(prep.systemPrompt);
  for (const f of stored) assert.ok(sp.includes(String(f.value)), `stored fact ${f.key}=${f.value} missing from the prompt`);
  assert.equal(prep.relevantFacts.length, stored.length, 'retrieval delivered the facts (was NO_MEMORIES)');
  assert.match(String(prep.knowledgeContext), /co-founder Dev/, 'the PIC floor answers when canonical lanes cannot (was facts=0 entities=0 timeline=0)');
});

test('the identity card survives (it was vetoed whole before)', async () => {
  const p = await ask('What is my name?', 'c-dbdown-name');
  assert.match(String(p.systemPrompt), /Maya/);
});

test('resolveReadMode: reachable ⇒ configured mode; unreachable ⇒ legacy + degraded; legacy config never probes', async () => {
  assert.deepEqual(await Brain.resolveReadMode({ reachable: async () => true }),
    { mode: 'authoritative', configured: 'authoritative', degraded: false, reason: null });
  assert.deepEqual(await Brain.resolveReadMode({ reachable: async () => { throw new Error('boom'); } }),
    { mode: 'legacy', configured: 'authoritative', degraded: true, reason: 'canonical-store-unreachable' });
  process.env.AQUA_CANONICAL_READ = 'off';
  try {
    let probed = false;
    const r = await Brain.resolveReadMode({ reachable: async () => { probed = true; return false; } });
    assert.equal(r.mode, 'legacy'); assert.equal(r.degraded, false); assert.equal(probed, false);
  } finally { delete process.env.AQUA_CANONICAL_READ; }
});
