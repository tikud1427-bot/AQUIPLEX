/**
 * Unified Memory Architecture — Acceptance Tests
 * Run: node --test src/memory/tests/unified.test.js
 *
 * Runs against a TEMP working directory so persistence tests never touch the
 * repo's real .aqua-mind.json. Modules are dynamically imported AFTER chdir
 * because store paths resolve from process.cwd() at module load.
 *
 * Covers spec acceptance tests:
 *   T1/T2  cross-conversation identity & projects (one owner, many convs)
 *   T3–T6  preferences / goals / relationships / projects survive (owner-scoped)
 *   T7     restart persistence (single .aqua-mind.json)
 *   T8     no permanent memory keyed by bare conversationId
 *   T11    exactly ONE persistent memory store
 *   T14    repeated evidence strengthens confidence
 *   T15    contradictions adjust confidence + keep history (no blind overwrite)
 *   +      conv→user adoption, legacy migration, file memory
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-unified-'));
process.env.AQUA_DATA_DIR = tmp; // stores persist to the data dir now (P0)
const repoRoot = process.cwd();
process.chdir(tmp);

// Seed a legacy store + conversation meta BEFORE imports, so migration and
// conversationStore pick them up at module load.
const legacyFacts = {
  'conv-legacy-1': {
    name: { key: 'name', value: 'Chhanda', confidence: 0.9, importance: 9, ts: Date.now() - 1000 },
  },
  'conv-legacy-2': {
    favorite_language: { key: 'favorite_language', value: 'typescript', confidence: 0.85, importance: 7, ts: Date.now() - 900 },
  },
};
fs.writeFileSync(path.join(tmp, '.aqua-memory.json'), JSON.stringify(legacyFacts));
fs.writeFileSync(path.join(tmp, '.aqua-history.json'), JSON.stringify({
  'conv-legacy-1': { messages: [], meta: { userId: '42', createdAt: Date.now() } },
  'conv-legacy-2': { messages: [], meta: { createdAt: Date.now() } }, // no user → conv owner
}));

let engine, ltm, mindStore, migrate;

before(async () => {
  engine    = await import(path.join(repoRoot, 'src/memory/engine.js'));
  ltm       = await import(path.join(repoRoot, 'src/memory/longTermMemory.js'));
  mindStore = await import(path.join(repoRoot, 'src/mind/mindStore.js'));
  migrate   = await import(path.join(repoRoot, 'src/memory/migrate.js'));
});

const flush = () => new Promise(r => setTimeout(r, 700)); // > debounce 500ms

// ── T8 / Req 1: single owner model ────────────────────────────────────────────
test('T8 — owner resolution: user first, conv fallback, never bare convId', () => {
  assert.equal(engine.resolveOwner({ userId: 'u1', conversationId: 'c1' }), 'user:u1');
  assert.equal(engine.resolveOwner({ conversationId: 'c1' }), 'conv:c1');
  assert.equal(engine.resolveOwner({}), null);
  assert.ok(engine.isUserOwner('user:u1'));
  assert.ok(!engine.isUserOwner('conv:c1'));
});

// ── T1/T2/T3–T6: one owner across many conversations ─────────────────────────
test('T1/T2 — facts stored in chat A are visible from chat B (same user)', () => {
  const owner = engine.resolveOwner({ userId: 'u-cross', conversationId: 'chat-A' });
  engine.memoryObserve(owner, { userMessage: 'My name is Chhanda. I founded Aquiplex.', conversationId: 'chat-A' });

  const ownerAgain = engine.resolveOwner({ userId: 'u-cross', conversationId: 'chat-B' });
  assert.equal(owner, ownerAgain, 'ten conversations, one owner');

  const name = ltm.getFact(ownerAgain, 'name');
  assert.ok(name, 'name known in chat B');
  assert.match(String(name.value), /chhanda/i);
  assert.equal(name.sourceConversation, 'chat-A', 'conversation is provenance, not scope');

  const retrieved = engine.memoryRetrieve(ownerAgain, { query: 'what is my name?' });
  assert.match(retrieved.block, /chhanda/i, 'retrieval pipeline surfaces it');
});

// ── T14: support strengthens confidence ───────────────────────────────────────
test('T14 — repeated identical evidence raises confidence + supportCount', () => {
  const owner = 'user:u-support';
  engine.memoryObserve(owner, { userMessage: 'My favorite language is Rust.' });
  const first = ltm.getFact(owner, 'favorite_language');
  engine.memoryObserve(owner, { userMessage: 'My favorite language is Rust.' });
  const second = ltm.getFact(owner, 'favorite_language');
  assert.ok(second.confidence >= first.confidence, 'confidence non-decreasing');
  assert.ok((second.supportCount || 1) >= 2, 'support counted');
});

// ── T15: contradiction ≠ blind overwrite ──────────────────────────────────────
test('T15 — contradictory value: damped confidence, history, contradiction count', () => {
  const owner = 'user:u-contra';
  ltm.storeFact(owner, { key: 'favorite_language', value: 'rust', normalizedValue: 'rust', confidence: 0.9, importance: 7, ts: Date.now() - 5000 });
  ltm.storeFact(owner, { key: 'favorite_language', value: 'rust', normalizedValue: 'rust', confidence: 0.9, importance: 7, ts: Date.now() - 4000 }); // support x2
  const before = ltm.getFact(owner, 'favorite_language');

  // Distinct later turn (reinforcement stamps ts=now; real turns are always
  // strictly later — the resolver's newer-timestamp rule requires >).
  ltm.storeFact(owner, { key: 'favorite_language', value: 'go', normalizedValue: 'go', confidence: 0.9, importance: 7, ts: Date.now() + 50 });
  const after = ltm.getFact(owner, 'favorite_language');

  assert.equal(String(after.value), 'go', 'newer value wins (recency)');
  assert.ok(after.confidence < 0.9, `confidence damped by contradiction (got ${after.confidence})`);
  assert.ok(after.contradictions >= 1, 'contradiction counted');
  assert.ok(after.history.length >= 1, 'revision history preserved');
  assert.equal(String(after.history.at(-1).value), 'rust', 'old value in history');
  assert.ok(after.revision > before.revision, 'revision incremented');
});

test('T15b — explicit correction is exempt from damping', () => {
  const owner = 'user:u-correct';
  ltm.storeFact(owner, { key: 'favorite_editor', value: 'vim', normalizedValue: 'vim', confidence: 0.8, ts: Date.now() - 1000 });
  ltm.storeFact(owner, { key: 'favorite_editor', value: 'neovim', normalizedValue: 'neovim', confidence: 0.95, ts: Date.now(), isCorrection: true });
  const fact = ltm.getFact(owner, 'favorite_editor');
  assert.equal(String(fact.value), 'neovim');
  assert.equal(fact.confidence, 0.95, 'correction keeps stated confidence');
});

// ── Adoption: pre-login conv memory merges into user ──────────────────────────
test('adoption — conv: mind merges into user: on first login, once', () => {
  engine.memoryObserve('conv:anon-1', { userMessage: 'My name is Ananya.', conversationId: 'anon-1' });
  assert.ok(ltm.getFact('conv:anon-1', 'name'));

  const owner = engine.resolveOwner({ userId: 'u-login', conversationId: 'anon-1' }); // triggers adoption
  assert.equal(owner, 'user:u-login');
  const name = ltm.getFact('user:u-login', 'name');
  assert.ok(name, 'fact adopted into user memory');
  assert.match(String(name.value), /ananya/i);

  const orphan = mindStore.peekMind('conv:anon-1');
  assert.equal(orphan.adoptedInto, 'user:u-login', 'source tombstoned');
});

// ── Migration: legacy conversation store → unified owners ─────────────────────
test('migration — legacy .aqua-memory.json lands under correct owners, file archived', () => {
  const result = migrate.migrateLegacyMemory();
  assert.ok(result.migrated);
  assert.equal(result.facts, 2);

  const viaUser = ltm.getFact('user:42', 'name');                    // conv had meta.userId
  assert.match(String(viaUser.value), /chhanda/i);
  assert.equal(viaUser.sourceConversation, 'conv-legacy-1');

  const viaConv = ltm.getFact('conv:conv-legacy-2', 'favorite_language'); // no user → conv owner
  assert.match(String(viaConv.value), /typescript/i);

  assert.ok(!fs.existsSync(path.join(tmp, '.aqua-memory.json')), 'legacy file archived');
  assert.ok(fs.readdirSync(tmp).some(f => f.startsWith('.aqua-memory.json.migrated-')));
  assert.deepEqual(migrate.migrateLegacyMemory(), { migrated: false }, 'idempotent');
});

// ── Req 10: file memory ────────────────────────────────────────────────────────
test('file memory — uploads become durable owner memory + graph artifact', () => {
  const owner = 'user:u-files';
  engine.rememberFile(owner, { name: 'roadmap.pdf', kind: 'document', summary: 'Q3 roadmap: memory unification, YC application.', chars: 5120, conversationId: 'c-up' });
  const mind = mindStore.peekMind(owner);
  assert.ok(mind.files['file:roadmap.pdf'], 'file entry persisted');
  assert.ok(mind.graph.nodes['artifact:roadmap.pdf'], 'graph artifact node');

  const r = engine.memoryRetrieve(owner, { query: 'what did the roadmap.pdf say?' });
  assert.match(r.block, /roadmap\.pdf/i, 'file memory retrievable');
  assert.match(r.block, /Q3 roadmap/i, 'summary surfaces');
});

// ── T7 + T11: single store, restart persistence ────────────────────────────────
test('T7/T11 — one persistent store; facts survive process restart', async () => {
  await flush();
  const files = fs.readdirSync(tmp).filter(f => f.startsWith('.aqua-') && f.endsWith('.json'));
  assert.ok(files.includes('.aqua-mind.json'), 'unified store written');
  assert.ok(!files.includes('.aqua-memory.json'), 'no second memory store');

  // "Restart": fresh process reads the same file and answers T1.
  const { execFileSync } = await import('node:child_process');
  const script = `
    process.env.AQUA_DATA_DIR = ${JSON.stringify(tmp)};
    process.chdir(${JSON.stringify(tmp)});
    const ltm = await import(${JSON.stringify(path.join(repoRoot, 'src/memory/longTermMemory.js'))});
    const f = ltm.getFact('user:u-cross', 'name');
    if (!f || !/chhanda/i.test(String(f.value))) { console.error('LOST'); process.exit(1); }
    console.log('SURVIVED');
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.match(out, /SURVIVED/);
});

// ── T9/T10/T12/T13: structural — one pipeline each, no duplicate persistence ──
test('T9–T13 — structural: single entrypoints, single writer', () => {
  const chat = fs.readFileSync(path.join(repoRoot, 'src/routes/chat.js'), 'utf8');
  assert.ok(chat.includes("from '../memory/engine.js'"), 'chat imports the ONE facade');
  assert.ok(!chat.includes("from '../mind/index.js'"), 'no direct mind pipeline in routes');
  assert.ok(!/retrieveRelevantFacts|formatFactsForPrompt|storeFacts\(/.test(chat), 'no direct stage calls');
  assert.equal((chat.match(/memoryObserve\(/g) || []).length, 1, 'ONE observation call site');
  assert.equal((chat.match(/memoryRetrieve\(/g) || []).length, 1, 'ONE retrieval call site');

  const ltmSrc = fs.readFileSync(path.join(repoRoot, 'src/memory/longTermMemory.js'), 'utf8');
  assert.ok(!ltmSrc.includes('writeFileSync'), 'fact layer has NO own persistence (mindStore is the single writer)');
});
