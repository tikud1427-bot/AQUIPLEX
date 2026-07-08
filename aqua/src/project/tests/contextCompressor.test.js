/**
 * Context Compressor tests — token-bounded repository digest.
 * Real ingestion pipeline; fixture has a controlled importance gradient
 * (engine.js = most symbols/most-imported → detailed; tests/config → demoted).
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import { createWorkspace }       from '../workspaceManager.js';
import { runWorkspaceIngestion } from '../ingestionPipeline.js';
import { buildRepoDigest, rankFiles, estimateTokens } from '../contextCompressor.js';

const jsf = (path, content) => ({ path, content, lang: 'javascript' });

// engine.js: 8 exported functions (highest API surface) + imported by a–d.
const ENGINE = jsf('src/core/engine.js', [
  'export function init() {}',
  'export function start() {}',
  'export function stop() {}',
  'export function tick() {}',
  'export function reset() {}',
  'export function load() {}',
  'export function save() {}',
  'export function status() {}',
].join('\n'));

const importer = (name) => jsf(`src/${name}.js`, [
  "import { init, start } from './core/engine.js';",
  `export function ${name}Run() { init(); start(); }`,
].join('\n'));

const FILES = [
  ENGINE,
  importer('a'), importer('b'), importer('c'), importer('d'),
  jsf('src/utils/helper.js', "export function formatThing(x) { return x; }"),
  jsf('src/utils/tiny.js', "export const K = 1;"),
  jsf('test/engine.test.js', "import { init } from '../src/core/engine.js';\nfunction t() { init(); }"),
  { path: 'config.json', content: '{ "a": 1, "b": 2 }', lang: 'json' },
];

let ws;
before(async () => {
  ws = createWorkspace({ ownerId: 'compressor' });
  await runWorkspaceIngestion(ws.id, FILES);
});

test('produces a hierarchical digest with a header and the engine skeleton', () => {
  const out = buildRepoDigest(ws.id, { tokenBudget: 4000 });
  assert.ok(out, 'digest returned');
  assert.match(out.digest, /REPOSITORY DIGEST/);
  assert.match(out.digest, /## Key modules \(skeletons\)/);
  assert.match(out.digest, /### src\/core\/engine\.js/);
  assert.match(out.digest, /functions: init\(\), start\(\)/);   // signatures, no bodies
  assert.equal(out.stats.totalFiles, FILES.length);
});

test('ranking: engine.js is the most important file', () => {
  const ranked = rankFiles(ws.id);
  assert.equal(ranked[0].path, 'src/core/engine.js');
  // a test file is penalised below a normal source file of similar size
  const testScore = ranked.find(r => r.path === 'test/engine.test.js').score;
  const aScore    = ranked.find(r => r.path === 'src/a.js').score;
  assert.ok(testScore < aScore, `test file should rank below src/a.js (${testScore} < ${aScore})`);
});

test('budget is respected (bounded by construction)', () => {
  for (const budget of [300, 800, 2000]) {
    const { stats } = buildRepoDigest(ws.id, { tokenBudget: budget });
    assert.ok(stats.estTokens <= budget * 1.15, `est ${stats.estTokens} within ${budget} (+15%)`);
  }
});

test('monotonic: a larger budget details at least as many files', () => {
  const small = buildRepoDigest(ws.id, { tokenBudget: 200 }).stats.detailed;
  const large = buildRepoDigest(ws.id, { tokenBudget: 4000 }).stats.detailed;
  assert.ok(large >= small, `large(${large}) >= small(${small})`);
  assert.ok(large > small, 'a much larger budget should detail strictly more files here');
});

test('tiny budget still returns a valid, bounded digest (no throw)', () => {
  const out = buildRepoDigest(ws.id, { tokenBudget: 40 });
  assert.ok(out, 'still returns something');
  assert.ok(out.stats.summarized > 0 || out.stats.listed > 0, 'lower tiers absorb the overflow');
  // A ~150-token floor keeps the digest minimally useful; assert it stays near it.
  assert.ok(out.stats.estTokens <= 250, `stays near the floor (${out.stats.estTokens} ≤ 250)`);
});

test('focus raises a matching file and can surface it in detail', () => {
  // Robust mechanism check: focus lifts helper.js up the ranking.
  const idxNoFocus = rankFiles(ws.id).findIndex(r => r.path === 'src/utils/helper.js');
  const idxFocus   = rankFiles(ws.id, 'formatThing').findIndex(r => r.path === 'src/utils/helper.js');
  assert.ok(idxFocus < idxNoFocus, `focus should raise helper's rank (${idxFocus} < ${idxNoFocus})`);

  // At a budget that details ~2 files, the boost brings helper into detail.
  const budget = 230;
  const withoutFocus = buildRepoDigest(ws.id, { tokenBudget: budget }).digest;
  const withFocus    = buildRepoDigest(ws.id, { tokenBudget: budget, focus: 'formatThing' });
  assert.ok(!/### src\/utils\/helper\.js/.test(withoutFocus), 'helper not detailed without focus');
  assert.match(withFocus.digest, /### src\/utils\/helper\.js/);
  assert.match(withFocus.digest, /focus: "formatThing"/);
});

test('deterministic: identical inputs → identical output', () => {
  const a = buildRepoDigest(ws.id, { tokenBudget: 1000, focus: 'engine' }).digest;
  const b = buildRepoDigest(ws.id, { tokenBudget: 1000, focus: 'engine' }).digest;
  assert.equal(a, b);
});

test('estimateTokens is chars/4', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens(''), 0);
});

test('null when the workspace has no index', () => {
  const empty = createWorkspace({ ownerId: 'empty' });
  assert.equal(buildRepoDigest(empty.id, { tokenBudget: 1000 }), null);
});
