/**
 * chat.js — what a failed generation tells the browser (2026-10-28).
 *
 * The chat bubble renders the `error` field of a failed turn verbatim. It was
 * err.message, which for provider exhaustion is the router's log line:
 * "All providers exhausted | task=simple_qa | chain=groq:failure(auth) → …",
 * and the JSON also carried `providerErrors` (upstream bodies, which can quote
 * part of an API key) and provider names in `fallbackChain`.
 *
 * The failure is produced for real, not stubbed: with every provider key
 * removed from the environment, the router exhausts on the first round. That
 * is the fixture chatEnvelope.test.js said this path was missing.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-chat-errors-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
for (const k of Object.keys(process.env)) {
  if (/(_API_KEY|_KEY_\d+|_KEYS)$|^OPENROUTER|^GROQ|^GEMINI|^NVIDIA|^OPENAI|^ANTHROPIC|^MISTRAL|^CEREBRAS|^TOGETHER/i.test(k)) delete process.env[k];
}

const { default: chatRoute } = await import('../chat.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.aquaUserId = 'err-user'; next(); });
app.use('/chat', chatRoute);
let server, base;
before(() => { server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`; });
after(() => server.close());

const PROVIDERS = /\b(?:groq|gemini|openrouter|nvidia|openai|anthropic|mistral|cerebras|together)\b/i;
const INTERNALS = /exhausted|task=|chain=|simple_qa|stack|Error:|at \w+ \(/i;

function assertNoInternals(text, where) {
  assert.doesNotMatch(text, PROVIDERS, `${where} names a provider: ${text}`);
  assert.doesNotMatch(text, INTERNALS, `${where} carries router/stack internals: ${text}`);
}

test('POST /chat: a failed generation returns a sentence, no router chain, no provider errors', async () => {
  const res = await fetch(`${base}/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'What is 2 + 2?' }),
  });
  const body = await res.json();
  assert.ok(res.status >= 500, `expected a failure status, got ${res.status}`);
  assert.equal(body.success, false);
  assert.match(body.error, /^Aqua (?:is busy|could not finish)/);
  assert.equal(body.providerErrors, undefined);
  assertNoInternals(JSON.stringify(body), 'response body');
  assert.equal(typeof body.retryable, 'boolean', 'positive control: the retry contract is kept');
});

test('POST /chat/stream: the error event is a sentence, no router chain, no provider names', async () => {
  const res = await fetch(`${base}/chat/stream`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'What is 2 + 2?' }),
  });
  const text = await res.text();
  const block = text.split('\n\n').find(b => /^event: error$/m.test(b));
  assert.ok(block, `no error event in stream:\n${text.slice(0, 500)}`);
  const data = JSON.parse(block.split('\n').find(l => l.startsWith('data: ')).slice(6));
  assert.match(data.error, /^Aqua (?:is busy|could not finish)/);
  assertNoInternals(JSON.stringify(data), 'error event');
});
