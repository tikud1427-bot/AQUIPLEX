/**
 * A log line must never be blank.
 *
 * Boot log, Windows: `[DRIFT] check unavailable: ` — empty. `localhost` resolves
 * to ::1 and 127.0.0.1; with Postgres down both are refused and Node throws an
 * AggregateError whose `.message` is "". Every `${err.message}` printed nothing
 * on the one failure a developer most needs explained.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorText } from '../errorText.js';

const e = (message, code) => Object.assign(new Error(message), code ? { code } : {});

describe('errorText', () => {
  test('the real failure: an AggregateError with an empty message', () => {
    const agg = new AggregateError([e('connect ECONNREFUSED ::1:5432', 'ECONNREFUSED'), e('connect ECONNREFUSED 127.0.0.1:5432', 'ECONNREFUSED')]);
    agg.code = 'ECONNREFUSED';
    assert.equal(agg.message, '', 'precondition: this is the shape that printed blank');
    const t = errorText(agg);
    assert.match(t, /ECONNREFUSED/);
    assert.match(t, /::1:5432/);
    assert.match(t, /127\.0\.0\.1:5432/);
  });

  test('an ordinary error keeps its message and gains its code', () => {
    assert.equal(errorText(e('boom')), 'boom');
    assert.equal(errorText(e('connect failed', 'EPIPE')), 'connect failed (EPIPE)');
    assert.equal(errorText(e('connect ECONNREFUSED 1.2.3.4:5', 'ECONNREFUSED')), 'connect ECONNREFUSED 1.2.3.4:5', 'code already in the message is not repeated');
  });

  test('NEVER returns an empty string, whatever it is handed', () => {
    for (const v of [null, undefined, '', new Error(''), new Error('   '), {}, { message: '' }, new AggregateError([]), 42, { get message() { throw new Error('x'); } }]) {
      const t = errorText(v);
      assert.equal(typeof t, 'string');
      assert.ok(t.length > 0, `blank for ${String(v)}`);
    }
  });

  test('a message-less error falls back to code, then name', () => {
    assert.equal(errorText(Object.assign(new Error(''), { code: 'ETIMEDOUT' })), 'ETIMEDOUT');
    assert.equal(errorText(new TypeError('')), 'TypeError');
  });

  test('inner messages are de-duplicated and capped at three', () => {
    const agg = new AggregateError(Array.from({ length: 8 }, (_, i) => e(`fail ${i}`)));
    const t = errorText(agg);
    assert.equal((t.match(/fail \d/g) ?? []).length, 3);
    const dup = new AggregateError([e('same'), e('same'), e('same')]);
    assert.equal((errorText(dup).match(/same/g) ?? []).length, 1);
  });

  test('no stack trace ever reaches a log line', () => {
    assert.doesNotMatch(errorText(e('x')), /\n\s+at /);
  });
});

describe('the log sites that printed blank now use it', () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const SITES = [
    ['router.js', /\[DRIFT\] check unavailable: \$\{errorText\(err\)\}/],
    ['router.js', /\[DB\] boot line unavailable: \$\{errorText\(err\)\}/],
    ['src/core/db/pool.js', /idle client error: \$\{errorText\(err\)\}/],
    ['src/core/db/drift.js', /could not record run: \$\{errorText\(err\)\}/],
    ['src/core/storage/index.js', /shadow mode unavailable: \$\{errorText\(err\)\}/],
    ['src/core/storage/pgBlobAdapter.js', /store write failed: \$\{errorText\(err\)\}/],
    ['src/core/storage/dualWriteAdapter.js', /shadow write failed \(\$\{label\}\): \$\{errorText\(err\)\}/],
  ];
  for (const [file, re] of SITES) {
    test(`${file}: ${re.source.slice(0, 40)}…`, () => {
      assert.match(fs.readFileSync(path.join(ROOT, file), 'utf8'), re);
    });
  }
});
