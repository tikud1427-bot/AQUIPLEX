/**
 * Call-graph → chat wiring tests.
 *
 * Verifies retrieveProjectContext / formatProjectContext surface EXACT
 * function-level call facts (who-calls / impact / trace) for flagship
 * questions, resolve only real symbols, and never disturb ordinary
 * retrieval. Runs the real ingestion pipeline end-to-end.
 *
 *   Fixture edges:  handler → login → { hashPassword, verify }
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import { createWorkspace }       from '../workspaceManager.js';
import { runWorkspaceIngestion } from '../ingestionPipeline.js';
import { retrieveProjectContext, formatProjectContext } from '../projectRetriever.js';

const FILES = [
  {
    path: 'src/auth.js',
    content: `
export function hashPassword(pw) {
  return sha(pw);                 // sha is undefined in-repo → excluded from graph
}
export function login(user, pw) {
  const h = hashPassword(pw);
  return verify(user, h);
}
function verify(u, h) { return Boolean(u && h); }
`,
  },
  {
    path: 'src/routes.js',
    content: `
import { login } from './auth.js';
export function handler(req) {
  return login(req.user, req.pw);
}
`,
  },
];

let ws;

before(async () => {
  ws = createWorkspace({ ownerId: 'callgraph-test' });
  await runWorkspaceIngestion(ws.id, FILES);
});

function ctxFor(query) {
  const raw = retrieveProjectContext(ws.id, query);
  return { raw, text: formatProjectContext(raw) };
}

test('who-calls: direct callers reported with file:line', () => {
  const { raw, text } = ctxFor('who calls login');
  assert.ok(raw.callGraph, 'call-graph answer attached to context');
  assert.equal(raw.callGraph.symbol, 'login');

  const callers = raw.callGraph.directCallers.map(c => c.caller);
  assert.ok(callers.includes('handler'), `handler should call login — got ${JSON.stringify(callers)}`);

  assert.match(text, /Direct callers of login/);
  assert.match(text, /handler\(\)/);
  assert.match(text, /src\/routes\.js/);
});

test('impact: transitive callers of a leaf helper', () => {
  const { raw, text } = ctxFor('what breaks if I change hashPassword');
  assert.ok(raw.callGraph?.impact, 'impact block computed');
  assert.equal(raw.callGraph.symbol, 'hashPassword');

  const trans = raw.callGraph.impact.transitive;
  assert.ok(trans.includes('login'),   `login directly depends on hashPassword — got ${JSON.stringify(trans)}`);
  assert.ok(trans.includes('handler'), `handler transitively depends — got ${JSON.stringify(trans)}`);

  assert.match(text, /Impact if hashPassword changes/);
});

test('trace: forward call chain reaches downstream leaves', () => {
  const { raw, text } = ctxFor('trace handler');
  assert.ok(raw.callGraph?.trace, 'trace block computed');
  assert.equal(raw.callGraph.symbol, 'handler');

  assert.ok(raw.callGraph.callees.includes('login'), 'immediate callee of handler is login');

  const reaches = raw.callGraph.trace.transitive;
  assert.ok(reaches.includes('login'),        `chain reaches login — got ${JSON.stringify(reaches)}`);
  assert.ok(reaches.includes('hashPassword'), `chain reaches hashPassword — got ${JSON.stringify(reaches)}`);

  assert.match(text, /Call chain from handler/);
});

test('longest known identifier wins (hashPassword beats hash)', () => {
  const { raw } = ctxFor('who calls hashPassword');
  assert.equal(raw.callGraph.symbol, 'hashPassword');
});

test('no call-graph intent → no call-graph section, retrieval undisturbed', () => {
  const { raw, text } = ctxFor('summarize auth.js');
  assert.equal(raw.callGraph, null, 'no call-graph answer without who-calls/impact/trace intent');
  assert.doesNotMatch(text, /CALL GRAPH/);
  assert.ok(text.length > 0, 'ordinary project context still rendered');
});

test('unknown symbol → null (no hallucinated caller facts)', () => {
  const { raw } = ctxFor('who calls doesNotExistFn');
  assert.equal(raw.callGraph, null, 'unresolved symbol yields no call-graph answer');
});

test('leaf with no callers → honest "no callers" note, not empty', () => {
  const { raw, text } = ctxFor('who calls handler');
  assert.ok(raw.callGraph, 'answer present for a real but uncalled symbol');
  assert.equal(raw.callGraph.symbol, 'handler');
  assert.equal(raw.callGraph.directCallers.length, 0, 'handler is an entry point — no in-repo callers');
  assert.match(text, /No direct callers of handler/);
});
