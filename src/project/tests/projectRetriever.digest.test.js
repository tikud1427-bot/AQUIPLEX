/**
 * Digest → chat surfacing tests.
 * Overview/whole-repo questions attach a token-bounded repo digest to the
 * retrieved context; specific questions and small repos do not. Real pipeline.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import { createWorkspace }       from '../workspaceManager.js';
import { runWorkspaceIngestion } from '../ingestionPipeline.js';
import { retrieveProjectContext, formatProjectContext } from '../projectRetriever.js';

const jsf = (path, content) => ({ path, content, lang: 'javascript' });

// A repo large enough (≥8 files) to be worth compressing.
const BIG = [
  jsf('src/core/engine.js', ['export function init(){}','export function start(){}','export function stop(){}'].join('\n')),
  jsf('src/a.js', "import { init } from './core/engine.js';\nexport function aRun(){ init(); }"),
  jsf('src/b.js', "export function bRun(){}"),
  jsf('src/c.js', "export function cRun(){}"),
  jsf('src/d.js', "export function dRun(){}"),
  jsf('src/utils/helper.js', "export function fmt(x){ return x; }"),
  jsf('src/utils/tiny.js', "export const K = 1;"),
  jsf('src/routes/api.js', "router.get('/ping', (req,res)=>res.end());"),
  jsf('src/models/user.js', "const User = sequelize.define('User', {});"),
];

const SMALL = [
  jsf('src/only.js', "export function f(){}"),
  jsf('src/two.js', "export function g(){}"),
];

let big, small;
before(async () => {
  big = createWorkspace({ ownerId: 'digest-big' });
  await runWorkspaceIngestion(big.id, BIG);
  small = createWorkspace({ ownerId: 'digest-small' });
  await runWorkspaceIngestion(small.id, SMALL);
});

function ctxFor(ws, query) {
  const raw = retrieveProjectContext(ws, query);
  return { raw, text: formatProjectContext(raw) };
}

test('overview query attaches a token-bounded repo digest', () => {
  const { raw, text } = ctxFor(big.id, 'explain the whole codebase to me');
  assert.ok(raw.repoDigest, 'digest attached');
  assert.match(raw.repoDigest, /REPOSITORY DIGEST/);
  assert.match(text, /REPOSITORY DIGEST/);
  assert.match(text, /## Key modules \(skeletons\)/);
  // bounded (~1500-token budget, allow slack + the surrounding file context)
  assert.ok(raw.repoDigest.length / 4 <= 1500 * 1.3, 'digest respects its budget');
});

test('other overview phrasings also trigger it', () => {
  for (const q of [
    'give me an overview of the project',
    'how is this project structured',
    'walk me through the architecture of this repo',
  ]) {
    assert.ok(ctxFor(big.id, q).raw.repoDigest, `should attach for: ${q}`);
  }
});

test('specific question does NOT attach a digest', () => {
  const { raw, text } = ctxFor(big.id, 'who calls init');
  assert.equal(raw.repoDigest, null, 'no digest for a targeted question');
  assert.doesNotMatch(text.replace(/REPOSITORY DIGEST/g, ''), /REPOSITORY DIGEST/);
});

test('small repo does not attach a digest even for overview queries', () => {
  const { raw } = ctxFor(small.id, 'explain the whole codebase');
  assert.equal(raw.repoDigest, null, 'top-k already covers a tiny repo');
});

test('unrelated file question leaves retrieval undisturbed', () => {
  const { raw } = ctxFor(big.id, 'summarize src/utils/helper.js');
  assert.equal(raw.repoDigest, null);
});
