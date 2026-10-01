/**
 * READ-ONLY CONSUMERS — the allow-lists in claimSchema / worldModelSchema /
 * dbPool are "who may TOUCH the tables". That is weaker than the invariant L2
 * actually states, which is "who may WRITE them". Declaring a module as a
 * reader in those lists is only honest if something proves it reads.
 *
 * This is that proof. Every module here is allowed to see the claim tables and
 * the pool; none may contain a statement that changes data. A reader that
 * grows an INSERT is a second writer — the single-writer regression the
 * Sep 21 audit found once already — and it must fail HERE, by name, rather
 * than being absorbed because its file was already on an allow-list.
 *
 * Comments are stripped first (the repo's own recurring self-match lesson),
 * and the scan is verified to see CODE: a test that stripped everything would
 * pass vacuously, so each file must still contain a SELECT.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const READ_ONLY = [
  'src/core/worldModel/canonicalReadModel.js',
  'src/core/worldModel/graphLane.js',
  'src/brain/reflectionV3/revisionFeed.js',
  'src/brain/contextEngine/index.js',
  'src/brain/contextEngine/canonicalSemantic.js',
  'src/brain/index.js',
  'src/routes/brain.js',
];

const WRITE = /\b(INSERT\s+INTO|UPDATE\s+aqua_\w+|DELETE\s+FROM|TRUNCATE\s|ALTER\s+TABLE|DROP\s+(TABLE|INDEX)|CREATE\s+TABLE)\b/i;
const strip = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('declared read-only consumers stay read-only', () => {
  for (const rel of READ_ONLY) {
    test(`${rel} contains no write statement`, () => {
      const code = strip(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
      const hit = code.match(WRITE);
      assert.equal(hit, null, `${rel} now contains "${hit?.[0]}" — a reader became a writer. Route the write through worldModelRepository (L2) or drop the module from READ_ONLY on purpose.`);
    });
  }

  test('the scan is not vacuous — the detector fires on a write, and the files still hold SQL', () => {
    assert.ok(WRITE.test(strip("pool.query(`INSERT INTO aqua_claims (a) VALUES ($1)`)")), 'detector missed an INSERT');
    assert.ok(WRITE.test(strip("q(`UPDATE aqua_claims SET state='x'`)")), 'detector missed an UPDATE');
    assert.ok(!WRITE.test(strip('// INSERT INTO aqua_claims is how the writer does it')), 'a comment matched');
    const withSql = READ_ONLY.filter(rel => /SELECT\s/i.test(strip(fs.readFileSync(path.join(ROOT, rel), 'utf8'))));
    assert.ok(withSql.length >= 3, `only ${withSql.length} declared readers contain a SELECT — the strip may be eating code`);
  });
});
