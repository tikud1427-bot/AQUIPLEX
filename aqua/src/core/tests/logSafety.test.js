/**
 * core/logSafety.js — unit tests (Sprint 6, 2026-11-11).
 *
 * Until now this module was covered only through routes/tests/logPrivacy.test.js,
 * which exercises many Sprint 1 call sites. The Capture Integrity release package
 * ships this module with the two extractor files only, so it needs tests of its
 * own: metadata instead of content, and content logging refused in production.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../logSafety.js';

const SECRET = 'My sister Ana earns 58,000 at Stripe';

test('textMeta / valueMeta carry no content by default', () => {
  const t = L.textMeta(SECRET);
  assert.match(t, /^len=\d+ h=[0-9a-f]{8}$/);
  for (const w of ['Ana', '58,000', 'Stripe']) assert.ok(!t.includes(w));
  assert.equal(L.valueMeta('Stripe'), 'string(len=6)');
  assert.equal(L.valueMeta(['a', 'b']), 'list(2)');
  assert.equal(L.valueMeta({ name: 'Ana' }), 'object(1)');
  assert.equal(L.valueMeta(null), 'null');
});

test('safeKey: schema keys stay readable; custom and odd keys are hashed', () => {
  assert.equal(L.safeKey('workplace'), 'workplace');
  assert.match(L.safeKey('custom_sister_ana_salary'), /^custom_#[0-9a-f]{8}$/);
  assert.match(L.safeKey('my sister Ana'), /^key#[0-9a-f]{8}$/);
});

test('shortHash is stable within a process and not the input', () => {
  assert.equal(L.shortHash('user:42'), L.shortHash('user:42'));
  assert.notEqual(L.shortHash('user:42'), L.shortHash('user:43'));
  assert.match(L.shortHash('user:42'), /^[0-9a-f]{8}$/);
});

test('stripQuoted removes quoted user text from reasons and messages', () => {
  assert.equal(L.stripQuoted(`rejected "Ana" and 'Stripe' and \`58\``), `rejected "…" and '…' and \`…\``);
});

test('errorMeta keeps name/code/status, strips quoted content', () => {
  const e = Object.assign(new Error('bad value "Ana Stripe"'), { code: 'E1', status: 503 });
  const m = L.errorMeta(e);
  assert.match(m, /name=Error code=E1 status=503/);
  assert.ok(!m.includes('Ana'));
});

test('content logging: only AQUA_LOG_CONTENT=local, and never on Render or in production', () => {
  assert.equal(L.contentLoggingAllowed({}), false);
  assert.equal(L.contentLoggingAllowed({ AQUA_LOG_CONTENT: 'local' }), true);
  assert.equal(L.contentLoggingAllowed({ AQUA_LOG_CONTENT: 'local', RENDER: 'true' }), false);
  assert.equal(L.contentLoggingAllowed({ AQUA_LOG_CONTENT: 'local', NODE_ENV: 'production' }), false);
  assert.equal(L.contentLoggingAllowed({ AQUA_LOG_CONTENT: 'yes' }), false);
});

test('fileMeta: extension and length only', () => {
  const m = L.fileMeta('Ana-salary-2026.pdf');
  assert.match(m, /^file\(ext=pdf len=19 h=[0-9a-f]{8}\)$/);
});
