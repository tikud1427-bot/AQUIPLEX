/**
 * PWI Phase 1, fix 1 (2026-11-15) — the user's working-memory context must not
 * be silently lost when DATABASE_URL is configured.
 *
 * The audit (AQUIPLEX_PWI_ARCHITECTURE_AUDIT.md, C-1): the Cloud Run templates
 * set DATABASE_URL and nothing else about reads, so `canonicalReadMode()` became
 * 'authoritative'. That read keeps only the identity card and gap-fill facts
 * from the legacy side (memory/engine.js `mindLanes`) and expects the canonical
 * World Model to answer — but nothing writes it (AQUA_E6 off) and nothing puts
 * it in the prompt (AQUA_CONTEXT_V2 off). Goals, blockers, deadlines,
 * relationships and episodes vanished from every answer.
 *
 * This drives the REAL `prepareTurn` (what /chat and /chat/stream hand the
 * model) with DATABASE_URL configured and a REACHABLE database (a fake pool
 * with an empty canonical store, so the read is not degraded), using the
 * AQUA_CANONICAL_READ value read from each deployment template — and asserts on
 * `prep.systemPrompt` for each of the five lanes. A sentinel test shows the same
 * turn without the pin, so the reason for the pin stays visible: when the
 * canonical read is made to carry these lanes, that test is what to revisit.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-cloudrun-lanes-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
process.env.AQUA_EMBEDDINGS = 'off';
process.env.DATABASE_URL = 'postgresql://aqua:aqua@127.0.0.1:1/aqua_lanes';   // configured, as in the templates
delete process.env.AQUA_CANONICAL_READ;
delete process.env.AQUA_CONTEXT_V2;
delete process.env.AQUA_E6;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const templateValue = (file, name) => fs.readFileSync(path.join(ROOT, 'deploy', 'cloudrun', file), 'utf8')
  .match(new RegExp(`name:\\s*${name}\\s*,\\s*value:\\s*"?([^"}]*)"?\\s*}`))?.[1]?.trim() ?? null;

const pool = await import('../../core/db/pool.js');
pool._resetForTests();
// Reachable, with an empty canonical store: the read mode is what the template
// configures, never the degraded fallback that would hide the defect.
pool._setPoolForTests({ query: async () => ({ rows: [] }) });
const Brain = await import('../../brain/index.js');
const { prepareTurn } = await import('../chat.js');
const { createContext } = await import('../../core/observability.js');
const mem = await import('../../memory/engine.js');

const USER = 'cloudrun-lanes';
const OWNER = `user:${USER}`;
const QUESTION = 'Should Maya and I delay the mobile app launch because of the payments integration?';

const LANES = {
  goals:         { re: /Active goals:[^\n]*launch the mobile app/i,   what: 'active goal' },
  blockers:      { re: /blocked on:[^|\n]*payments integration/i,      what: 'blocker' },
  deadlines:     { re: /deadline:[^|\n]*January 15/i,                  what: 'deadline' },
  relationships: { re: /RELATED KNOWLEDGE \(relationship graph\)[^]*Maya|Related:[^\n]*Maya/, what: 'relationship (graph)' },
  episodes:      { re: /PAST EPISODES \(episodic memory\)/,             what: 'conversation episode' },
};

before(() => {
  for (const t of [
    'My cofounder Maya runs engineering at Northbeam.',
    'My goal is to launch the mobile app by January 15.',
    'We are blocked on the payments integration.',
    'Maya is handling the payments integration.',
  ]) mem.memoryObserve(OWNER, { userMessage: t, taskType: 'planning', conversationId: 'c-seed', userId: USER, requestId: 'seed' });
});

let n = 0;
async function turnWith(canonicalRead) {
  if (canonicalRead == null) delete process.env.AQUA_CANONICAL_READ;
  else process.env.AQUA_CANONICAL_READ = canonicalRead;
  try {
    const conv = `c-ask-${++n}`;   // a NEW conversation: nothing from the seed is in chat history
    return await prepareTurn({ userMessage: QUESTION, workspaceId: null, conversationId: conv, userId: USER,
      ctx: createContext({ conversationId: conv, requestId: `lanes-${n}` }), requestId: `lanes-${n}`, skipReasoningPass: true });
  } finally { delete process.env.AQUA_CANONICAL_READ; }
}

for (const file of ['api.service.yaml', 'worker.workerpool.yaml']) {
  test(`${file}: with DATABASE_URL configured, goals, blockers, deadlines, relationships and episodes reach the model input`, async () => {
    const pinned = templateValue(file, 'AQUA_CANONICAL_READ');
    assert.equal(pinned, 'off', `${file} must pin AQUA_CANONICAL_READ=off`);
    assert.equal(pool.isConfigured(), true);
    const prep = await turnWith(pinned);
    assert.deepEqual({ mode: prep.readState.mode, degraded: prep.readState.degraded }, { mode: 'legacy', degraded: false });
    const sp = String(prep.systemPrompt);
    const missing = Object.entries(LANES).filter(([, l]) => !l.re.test(sp)).map(([k, l]) => `${k} (${l.what})`);
    assert.deepEqual(missing, [], `lost from the prompt: ${missing.join(', ')}`);
    assert.ok(prep.mind.contextUsed.goals >= 1 && prep.mind.contextUsed.working >= 2 && prep.mind.contextUsed.graph >= 1, JSON.stringify(prep.mind.contextUsed));
  });
}

test('sentinel — WITHOUT the pin, the same turn loses every one of these lanes (why the templates pin it)', async () => {
  assert.equal(Brain.canonicalReadMode(), 'authoritative', 'DATABASE_URL alone selects the authoritative read');
  const prep = await turnWith(null);
  assert.deepEqual({ mode: prep.readState.mode, degraded: prep.readState.degraded }, { mode: 'authoritative', degraded: false });
  const sp = String(prep.systemPrompt);
  const present = Object.entries(LANES).filter(([, l]) => l.re.test(sp)).map(([k]) => k);
  // If this starts failing because lanes are PRESENT, the authoritative read now carries
  // the Mind: re-evaluate the template pin deliberately, do not just update this line.
  assert.deepEqual(present, []);
});
