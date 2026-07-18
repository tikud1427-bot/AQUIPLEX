/**
 * Memory 5.0 — retrieval micro-benchmark (PERFORMANCE_REPORT.md source)
 * Synthetic heavy owner: 300 facts, 60-node/80-edge graph, 20 episodes,
 * working memory populated. Measures memoryRetrieve() wall time across
 * mixed query classes. Run: node src/memory/tests/bench.retrieve.js
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-bench-'));
process.env.AQUA_DATA_DIR = tmp;
process.chdir(tmp);

const ltm       = await import('../longTermMemory.js');
const engine    = await import('../engine.js');
const mindStore = await import('../../mind/mindStore.js');
const schema    = await import('../../mind/mindSchema.js');
const graph     = await import('../../mind/relationshipGraph.js');
const reflection = await import('../../mind/reflectionEngine.js');

const OWNER = 'user:bench';
const CATS = ['work', 'preferences', 'technology', 'lifestyle', 'food', 'goals'];

// ── Seed: 300 facts ───────────────────────────────────────────────────────────
for (let i = 0; i < 300; i++) {
  ltm.storeFact(OWNER, {
    key: `custom_fact_${i}`, value: `value-token-${i} alpha beta`,
    category: CATS[i % CATS.length], confidence: 0.7 + (i % 3) * 0.1,
    importance: 1 + (i % 10), ts: Date.now() - i * 3600_000,
  });
}
ltm.storeFact(OWNER, { key: 'workplace', value: 'Aquiplex', category: 'work', confidence: 0.95, importance: 9, ts: Date.now() });
ltm.storeFact(OWNER, { key: 'favorite_language', value: 'typescript', category: 'programming', confidence: 0.9, importance: 8, ts: Date.now() });

// ── Graph: 60 nodes, ~80 edges ────────────────────────────────────────────────
const mind = mindStore.getMind(OWNER);
const hub = graph.upsertNode(mind, 'org', 'Aquiplex');
let prev = hub;
for (let i = 0; i < 59; i++) {
  const n = graph.upsertNode(mind, i % 2 ? 'technology' : 'project', `entity-${i}`);
  graph.upsertEdge(mind, hub.key, n.key, 'owns');
  if (i % 3 === 0) graph.upsertEdge(mind, prev.key, n.key, 'uses');
  prev = n;
}

// ── Episodes: 20 arcs ─────────────────────────────────────────────────────────
for (let i = 0; i < 20; i++) {
  const ep = schema.createEpisode({ title: `sprint arc ${i} entity-${i} work`, conversationId: `c${i}` });
  ep.status = i < 2 ? 'active' : 'archived';
  ep.endedAt = Date.now() - i * 86400_000;
  ep.lastActivityAt = ep.endedAt;
  ep.outcome = i % 2 ? 'shipped' : null;
  mind.episodes[ep.id] = ep;
}
mind.working.blockers.push({ text: 'flaky ci', addedAt: Date.now(), lastSeenAt: Date.now(), count: 4 });

// ── Queries: mixed classes ────────────────────────────────────────────────────
const QUERIES = [
  'what do you know about me',                    // recall (widest scan)
  'what programming language do I prefer',        // directed category
  'tell me about Aquiplex and entity-4',          // graph multi-hop
  'what did we do in sprint arc 3',               // episodic
  "let's continue",                               // continuation fast-path
  'random unrelated cooking question',            // near-miss (gates drop all)
];

function bench(label, fn, iters) {
  const times = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    fn(i);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const pct = p => times[Math.min(times.length - 1, Math.floor(times.length * p))];
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(`${label.padEnd(38)} n=${iters}  avg=${avg.toFixed(3)}ms  p50=${pct(0.5).toFixed(3)}ms  p95=${pct(0.95).toFixed(3)}ms  max=${times[times.length - 1].toFixed(3)}ms`);
  return { avg, p50: pct(0.5), p95: pct(0.95) };
}

console.log(`facts=${ltm.getFacts(OWNER, { includeArchived: true }).length} nodes=${Object.keys(mind.graph.nodes).length} edges=${Object.keys(mind.graph.edges).length} episodes=${Object.keys(mind.episodes).length}\n`);

// warmup
for (let i = 0; i < 50; i++) engine.memoryRetrieve(OWNER, { query: QUERIES[i % QUERIES.length] });

bench('memoryRetrieve — mixed queries', i => {
  engine.memoryRetrieve(OWNER, { query: QUERIES[i % QUERIES.length] });
}, 600);
for (const q of QUERIES) {
  bench(`  "${q.slice(0, 34)}"`, () => engine.memoryRetrieve(OWNER, { query: q }), 200);
}

// observe path (write side)
bench('memoryObserve — typical message', i => {
  engine.memoryObserve(OWNER, { userMessage: `my favorite editor is neovim variant ${i % 5}`, conversationId: 'cB' });
}, 300);

// reflection (async path — measured synchronously here for worst case)
bench('reflect() — full consolidation pass', () => {
  mind.turnCount += 8;
  reflection.reflect(mind);
}, 50);
