/**
 * Brain routes — the World Model read API (Phase 0).
 *
 * Same harness as artifactRoutes.test.js / authScoping.test.js: the real
 * router in-process, header-driven req.aquaUserId, node:test runner, stores
 * isolated to a temp dir via AQUA_DATA_DIR set before the module graph loads.
 *
 * The guarantees under test:
 *   OWNER-SCOPED  no session and no ?conversationId → 400; one owner never
 *                 sees another owner's world.
 *   READ-ONLY     the API projects; it never mutates the underlying graphs.
 *   REAL DATA     entities seeded the way graphBuilder writes them come back
 *                 through the HTTP surface, federated with the Mind.
 *   BOUNDED       every query param is clamped; junk input never reaches the
 *                 world model.
 *   HONEST EMPTY  an empty result names the flag most likely responsible,
 *                 rather than looking like a broken deployment.
 *   FLAG-AWARE    AQUA_BRAIN=off degrades to empty + the right hint, and the
 *                 flag state is on every response.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-brain-routes-'));
process.env.AQUA_DATA_DIR = TMP;
delete process.env.AQUA_BRAIN;          // default-on master switch
delete process.env.AQUA_BRAIN_INGEST;   // default-off subordinate flags
delete process.env.AQUA_TWIN_V2;

const G = await import('../../reasoning/reasoningGraph.js');
const A = await import('../../brain/worldModel/annotationStore.js');
const R = await import('../../reasoning/typeRegistry.js');
const mindStore = await import('../../mind/mindStore.js');
const Brain = await import('../../brain/index.js');
const { default: brainRoute } = await import('../brain.js');

// Simulate the platform mount: x-test-user header → req.aquaUserId.
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const u = req.headers['x-test-user'];
  if (u) req.aquaUserId = String(u);
  next();
});
app.use('/brain', brainRoute);

let server, base;

const req = async (p, { user } = {}) => {
  const res = await fetch(base + p, {
    headers: { ...(user ? { 'x-test-user': user } : {}) },
  });
  let body = null;
  try { body = await res.json(); } catch { /* no body */ }
  return { status: res.status, body };
};

const ALICE = 'user:alice';
const BOB = 'user:bob';

/** File side: a resolved entity with provenance, exactly as graphBuilder writes it. */
function fileEntity(owner, id, label, { aliases = [], files = ['f1'], entityType = 'name' } = {}) {
  return G.upsertNode(owner, {
    id, type: 'entity', label, kind: 'derived',
    data: { entityType, aliases, resolutionConfidence: 1, fileCount: files.length },
    sourceFiles: files,
  });
}

/** Conversation side: seed the REAL mind store, so the federation is real. */
function mindNode(owner, key, node) {
  const mind = mindStore.getMind(owner);
  mind.graph.nodes[key] = { createdAt: Date.now(), weight: 1, ...node };
  mindStore.touchMind(mind);
}

before(() => {
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

// The stores use a debounced writer, so a pending flush can land after the
// suite ends. Removing TMP here would make it fail noisily on a path that is
// no longer anyone's concern — the other brain suites leave their temp dirs
// to the OS for exactly this reason.
after(() => { server?.close(); });

beforeEach(() => {
  G._resetGraphForTests();
  A._resetAnnotationsForTests();
  R._resetRegistryForTests();
  mindStore._clearAllForTests();
  delete process.env.AQUA_BRAIN;
  delete process.env.AQUA_TWIN_V2;
});

// ── Owner scoping ────────────────────────────────────────────────────────────

test('OWNER: no session and no conversationId → 400 on every owned endpoint', async () => {
  for (const p of ['/brain/stats', '/brain/entities', '/brain/timeline', '/brain/chains', '/brain/twin', '/brain/entity?id=x']) {
    const { status, body } = await req(p);
    assert.equal(status, 400, `${p} should require an owner`);
    assert.equal(body.success, false);
    assert.match(body.error, /No owner/);
  }
});

test('OWNER: ?conversationId is the standalone fallback, same as /memory', async () => {
  fileEntity('conv:c1', 'ent:name:aqua', 'AQUA');
  const { status, body } = await req('/brain/entities?conversationId=c1');
  assert.equal(status, 200);
  assert.equal(body.ownerId, 'conv:c1');
  assert.equal(body.entities.length, 1);
});

test('ISOLATION: one owner never sees another owner\'s world', async () => {
  fileEntity(ALICE, 'ent:name:billing', 'Billing Service');
  fileEntity(BOB, 'ent:name:payroll', 'Payroll Service');

  const alice = await req('/brain/entities', { user: 'alice' });
  const bob = await req('/brain/entities', { user: 'bob' });

  assert.deepEqual(alice.body.entities.map(e => e.title), ['Billing Service']);
  assert.deepEqual(bob.body.entities.map(e => e.title), ['Payroll Service']);

  // And the detail endpoint must not leak across owners either.
  const crossed = await req('/brain/entity?id=ent:name:payroll', { user: 'alice' });
  assert.equal(crossed.status, 404, 'alice must not be able to fetch bob\'s entity by id');
});

// ── Metrics ──────────────────────────────────────────────────────────────────

test('METRICS: needs no owner and reports live flag state', async () => {
  // The environment is CONTROLLED here, not inherited. This test asserts what
  // the defaults are, and it used to do that while reading whatever the
  // operator happened to have exported — so `AQUA_SELF_ENTITY=on npm test`
  // failed against completely unmodified code, which makes a red result
  // uninformative exactly when someone is testing a rollout.
  const FLAG_KEYS = [
    'AQUA_BRAIN', 'AQUA_BRAIN_INGEST', 'AQUA_BRAIN_INGEST_FACTS', 'AQUA_CONTEXT_V2',
    'AQUA_REFLECT_V2', 'AQUA_REVISION_VOICE', 'AQUA_SELF_ENTITY', 'AQUA_TWIN_V2',
  ];
  const saved = Object.fromEntries(FLAG_KEYS.map(k => [k, process.env[k]]));
  const restore = () => {
    for (const k of FLAG_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  };

  try {
    for (const k of FLAG_KEYS) delete process.env[k];

    const { status, body } = await req('/brain/metrics');
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.enabled, true);
    // Pinned deliberately: this assertion is what fails when a new switch is
    // added and NOT reported. AQUA_SELF_ENTITY existed for a while without
    // appearing here, which is precisely how it stayed invisible.
    assert.deepEqual(Object.keys(body.flags).sort(), FLAG_KEYS);
    assert.equal(body.flags.AQUA_BRAIN, true, 'master flag is on by default');
    assert.equal(body.flags.AQUA_BRAIN_INGEST, false, 'subordinate flags are off by default');
    assert.equal(body.flags.AQUA_SELF_ENTITY, false, 'self entity is off by default too');
    assert.equal(body.flags.AQUA_BRAIN_INGEST_FACTS, false, 'and so is conversational fact ingest');
    // The eighth switch. Every other flag here changes what AQUA KNOWS or does
    // silently; this one changes what it SAYS, unprompted — so it is the one
    // most worth being off until deliberately turned on.
    assert.equal(body.flags.AQUA_REVISION_VOICE, false, 'the revision voice is off by default');
    assert.ok('ingest' in body.metrics, 'ingest counters exposed for the rollout');
    assert.ok('contextEngine' in body.metrics);
    assert.ok('twin' in body.metrics);

    // LIVE, not boot-cached. The test has always been named "reports live flag
    // state" and never checked the live half — a value read once at module load
    // would have satisfied every assertion above. This is the check that makes
    // /brain/metrics usable for confirming a rollout actually took effect.
    process.env.AQUA_SELF_ENTITY = 'on';
    const after = await req('/brain/metrics');
    assert.equal(after.body.flags.AQUA_SELF_ENTITY, true, 'flag state is read per request');
  } finally {
    restore();
  }
});

// ── Entities ─────────────────────────────────────────────────────────────────

test('ENTITIES: federated entity surfaces with the Mind\'s semantic type', async () => {
  fileEntity(ALICE, 'ent:name:aquiplex', 'Aquiplex Inc.', { aliases: ['Aquiplex'], files: ['f1', 'f2'] });
  mindNode(ALICE, 'organization:aquiplex', { type: 'organization', label: 'Aquiplex', weight: 6 });

  const { status, body } = await req('/brain/entities', { user: 'alice' });
  assert.equal(status, 200);
  assert.equal(body.count, 1);

  const e = body.entities[0];
  assert.equal(e.id, 'ent:name:aquiplex');
  assert.equal(e.type, 'organization', 'file side alone would say "name"; the join says organization');
  assert.equal(e.ids.mind, 'organization:aquiplex');
  assert.ok(e.aliases.includes('Aquiplex'));
  assert.deepEqual(e.sourceRefs.files, ['f1', 'f2'], 'provenance survives the HTTP boundary');
});

test('ENTITIES: ?q= searches by name and alias', async () => {
  fileEntity(ALICE, 'ent:name:billing_service', 'Billing Service', { aliases: ['Billing'] });
  fileEntity(ALICE, 'ent:name:payroll', 'Payroll');

  const { body } = await req('/brain/entities?q=billing', { user: 'alice' });
  assert.equal(body.query, 'billing');
  assert.deepEqual(body.entities.map(e => e.title), ['Billing Service']);
});

test('ENTITIES: ?type= filters, ?minImportance= filters', async () => {
  fileEntity(ALICE, 'ent:name:aqua', 'AQUA');
  mindNode(ALICE, 'project:aqua', { type: 'project', label: 'AQUA', weight: 9 });
  fileEntity(ALICE, 'ent:name:priya', 'Priya');
  mindNode(ALICE, 'person:priya', { type: 'person', label: 'Priya', weight: 2 });

  const projects = await req('/brain/entities?type=project', { user: 'alice' });
  assert.deepEqual(projects.body.entities.map(e => e.title), ['AQUA']);

  const all = await req('/brain/entities', { user: 'alice' });
  assert.equal(all.body.count, 2);

  const important = await req('/brain/entities?minImportance=1.0', { user: 'alice' });
  assert.equal(important.body.count, 0, 'nothing reaches maximum derived importance here');
});

test('BOUNDED: junk and hostile params are clamped, never passed through', async () => {
  for (let i = 0; i < 5; i++) fileEntity(ALICE, `ent:name:e${i}`, `E${i}`);

  const junk = await req('/brain/entities?limit=abc', { user: 'alice' });
  assert.equal(junk.body.count, 5, 'unparseable limit falls back to the default');

  const huge = await req('/brain/entities?limit=999999', { user: 'alice' });
  assert.equal(huge.status, 200, 'oversized limit is clamped, not rejected');
  assert.equal(huge.body.count, 5);

  const negative = await req('/brain/entities?limit=-4', { user: 'alice' });
  assert.equal(negative.body.count, 1, 'limit clamps up to the floor of 1');
});

// ── Entity detail ────────────────────────────────────────────────────────────

test('DETAIL: entity + relationships + observations + events, both spellings', async () => {
  fileEntity(ALICE, 'ent:name:priya', 'Priya');
  fileEntity(ALICE, 'ent:name:billing', 'Billing Service');
  G.addEdge(ALICE, {
    from: 'ent:name:priya', to: 'ent:name:billing',
    type: 'works_on', confidence: 0.8, sourceFiles: ['f1'], reason: 'works_on: co-mentioned',
  });

  const viaQuery = await req('/brain/entity?id=ent:name:priya', { user: 'alice' });
  assert.equal(viaQuery.status, 200);
  assert.equal(viaQuery.body.entity.title, 'Priya');
  assert.equal(viaQuery.body.relationships.length, 1);
  assert.equal(viaQuery.body.relationships[0].type, 'works_on');
  assert.ok(Array.isArray(viaQuery.body.observations));
  assert.ok(Array.isArray(viaQuery.body.events));

  const viaPath = await req('/brain/entity/ent:name:priya', { user: 'alice' });
  assert.deepEqual(viaPath.body.entity, viaQuery.body.entity, 'path and query forms agree');
});

test('DETAIL: mind-only ids containing a slash work via the query form', async () => {
  mindNode(ALICE, 'technology:ai/ml', { type: 'technology', label: 'AI/ML', weight: 4 });

  const { status, body } = await req(`/brain/entity?id=${encodeURIComponent('mind:technology:ai/ml')}`, { user: 'alice' });
  assert.equal(status, 200, 'the query form is why this id is reachable at all');
  assert.equal(body.entity.title, 'AI/ML');
});

test('DETAIL: unknown id → 404 with flags, missing id → 400', async () => {
  const missing = await req('/brain/entity', { user: 'alice' });
  assert.equal(missing.status, 400);

  const unknown = await req('/brain/entity?id=ent:name:nope', { user: 'alice' });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.success, false);
  assert.ok(unknown.body.flags, 'a 404 still reports flag state — it may BE the explanation');
});

// ── Timeline + chains ────────────────────────────────────────────────────────

test('TIMELINE: returns events, chains and stats', async () => {
  fileEntity(ALICE, 'ent:name:aqua', 'AQUA');
  G.upsertNode(ALICE, {
    id: 'evt:1', type: 'event', label: 'AQUA prototype built', kind: 'derived',
    data: { eventType: 'creation', timestamp: '2026-01-05' }, sourceFiles: ['f1'],
  });

  const { status, body } = await req('/brain/timeline', { user: 'alice' });
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.events));
  assert.ok(Array.isArray(body.chains));
  assert.ok(body.stats && typeof body.stats === 'object');
});

test('CHAINS: exposes the lifecycle stage vocabulary alongside the chains', async () => {
  const { status, body } = await req('/brain/chains', { user: 'alice' });
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.chains));
  assert.ok(Array.isArray(body.stages) && body.stages.length > 0, 'the UI needs the stage order to render a chain');
  assert.equal(body.stages[0].stage, 'idea', 'stages arrive in declared lifecycle order, not object-key order');
  assert.equal(body.stages.at(-1).stage, 'outcome');
  const orders = body.stages.map(s => s.order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b), 'ordering is explicit, never incidental');
});

// ── Digital twin ─────────────────────────────────────────────────────────────

test('TWIN: empty by default, and says why', async () => {
  const { status, body } = await req('/brain/twin', { user: 'alice' });
  assert.equal(status, 200);
  assert.deepEqual(body.twin.inferences, []);
  assert.match(body.hint, /AQUA_TWIN_V2/, 'the hint names the flag actually responsible');
});

test('TWIN: with the flag on, observed turns produce reportable inferences', async () => {
  process.env.AQUA_TWIN_V2 = 'on';
  // Three separate observations — the anti-fabrication bar is minEvidence 3,
  // so one message must never be enough to establish a claim about someone.
  for (let i = 0; i < 6; i++) {
    Brain.observeTwin({
      ownerId: ALICE,
      userMessage: 'Please keep it brief and concise — just the bullet points, no preamble.',
      conversationId: 'c1',
    });
  }

  const { status, body } = await req('/brain/twin?includeTentative=1', { user: 'alice' });
  assert.equal(status, 200);
  assert.equal(body.flags.AQUA_TWIN_V2, true);
  assert.ok(body.twin.patternsCovered >= 0);
  assert.ok(Array.isArray(body.twin.inferences));
});

// ── Honest empties + kill switch ─────────────────────────────────────────────

test('EMPTY: a fresh owner is told ingest is off, not that something broke', async () => {
  const { body } = await req('/brain/entities', { user: 'alice' });
  assert.equal(body.count, 0);
  assert.match(body.hint, /AQUA_BRAIN_INGEST/);
});

test('KILL SWITCH: AQUA_BRAIN=off empties every endpoint and says so', async () => {
  fileEntity(ALICE, 'ent:name:aqua', 'AQUA');
  process.env.AQUA_BRAIN = 'off';

  const entities = await req('/brain/entities', { user: 'alice' });
  assert.equal(entities.status, 200, 'disabled is not an error');
  assert.equal(entities.body.count, 0);
  assert.match(entities.body.hint, /AQUA_BRAIN=off/);
  assert.equal(entities.body.flags.AQUA_BRAIN, false);

  const stats = await req('/brain/stats', { user: 'alice' });
  assert.equal(stats.body.stats.entities, 0);

  const metrics = await req('/brain/metrics');
  assert.equal(metrics.body.enabled, false);
});

test('READ-ONLY: serving the API mutates nothing in the underlying graph', async () => {
  fileEntity(ALICE, 'ent:name:aqua', 'AQUA', { files: ['f1', 'f2'] });
  const before = JSON.stringify(G.graphStats(ALICE));

  for (const p of ['/brain/entities', '/brain/stats', '/brain/timeline', '/brain/chains',
    '/brain/twin', '/brain/entity?id=ent:name:aqua']) {
    await req(p, { user: 'alice' });
  }

  assert.equal(JSON.stringify(G.graphStats(ALICE)), before, 'projection must not write');
});