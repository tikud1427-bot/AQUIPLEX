/**
 * upload.js envelope migration — the one behavior not already covered by
 * uploadAuth.test.js: the all-files-failed (422/unprocessable) path, and
 * /upload/formats. Same harness as uploadAuth.test.js.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-upload-envelope-'));
process.env.AQUA_DATA_DIR = TMP;

const { default: uploadRoute } = await import('../upload.js');
const { ErrorCodes }           = await import('../envelope.js');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/upload', uploadRoute);

let server, base;
before(() => { server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`; });
after(() => server.close());

const req = async (method, p, body) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
};

test('a file with no content → 422/unprocessable, not a generic 400/500', async () => {
  const { status, body } = await req('POST', '/upload', {
    files: [{ name: 'bad.txt', content: '' }],
  });
  assert.equal(status, 422);
  assert.equal(body.success, false);
  assert.equal(body.code, ErrorCodes.UNPROCESSABLE);
  // Per-file diagnostics still ride along on the error envelope, same as before.
  assert.equal(body.results[0].status, 'failed');
  assert.ok(body.conversationId, 'a conversation is still created even on total failure');
});

test('empty files array → bad_request/400 (unchanged validation path)', async () => {
  const { status, body } = await req('POST', '/upload', { files: [] });
  assert.equal(status, 400);
  assert.equal(body.code, ErrorCodes.BAD_REQUEST);
});

test('/upload/formats stays a plain ok() envelope', async () => {
  const { status, body } = await req('GET', '/upload/formats');
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.ok(Array.isArray(body.formats) || typeof body.formats === 'object');
  assert.ok(body.parsers);
});
