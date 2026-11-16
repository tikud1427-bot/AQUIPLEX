/**
 * The PIC reasoning session records a `query` label for each verified turn.
 * Found by the Phase 3 journey (2026-11-14): it stored the RAW user message in
 * the user's PIC store, so a health sentence survived outside the conversation
 * although the sensitivity policy removed it everywhere else. The label must be
 * the redacted text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactSensitiveSentences } from '../../memory/sensitivity.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(HERE, '..', 'chat.js'), 'utf8');

test('the PIC reasoning session query is the redacted message, never the raw one', () => {
  const call = src.slice(src.indexOf('recordReasoningOutcome(memoryOwner, {'), src.indexOf('recordReasoningOutcome(memoryOwner, {') + 700);
  assert.ok(call.length > 100, 'recordReasoningOutcome call not found');
  assert.match(call, /query:\s*redactSensitiveSentences\(userMessage\)\.text/);
  assert.doesNotMatch(call, /query:\s*userMessage\s*,/);
});

test('the redaction it relies on removes the health sentence and keeps the rest', () => {
  const t = redactSensitiveSentences('I was diagnosed with severe depression last spring. Anyway, I use Notion for planning.').text;
  assert.doesNotMatch(t, /depression/i);
  assert.match(t, /Notion/);
});
