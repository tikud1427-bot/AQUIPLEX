/**
 * The working tree carries no snapshot copies — E1/PR-7
 * Blueprint E1 · REPO_HYGIENE.md
 *
 * 🔴 EIGHT SNAPSHOT COPIES, 118 FILES, 1.3 MB, ZERO IMPORTERS.
 *
 *   brain-tests-backup-before-pr15/      understanding-backup-before-pr13/
 *   eval-backup-before-pr15/             understanding-backup-before-pr14/
 *   scripts-backup-before-pr15/          understanding-backup-before-pr16/
 *   e6Extractor-before-pr16.mjs          src/brain/understanding/pipeline.before-pr17.js
 *
 * They were inventoried in the Phase 0 audit and then survived twenty-one
 * increments, because nothing ever failed on account of them. That is exactly
 * what makes them expensive: a `grep` for a symbol returns the live definition
 * and three stale ones, and the reader has no way to tell which is which
 * without checking the path. Version control is the place for previous
 * versions of a file.
 *
 * WHY A TEST AND NOT JUST A DELETION. Deleting them once is a commit; keeping
 * them gone is a rule. The pattern that produced them — copy the directory
 * before a risky PR — is a reasonable instinct that will recur, and the person
 * who has it next will not read REPO_HYGIENE.md first.
 *
 * BITE, MEASURED (recreate one snapshot directory → 1 fail).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');

/** Every path under the repo, skipping the places copies legitimately live. */
function walk(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === 'node_modules' || e === '.git' || e === 'dist' || e === 'coverage') continue;
    const p = path.join(dir, e);
    out.push(p);
    let s;
    try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) walk(p, out, depth + 1);
  }
  return out;
}

describe('no snapshot copies in the working tree (E1/PR-7)', () => {
  const paths = walk(REPO);

  test('the walk actually reaches the repo — this is the denominator', () => {
    // A rule over an empty listing passes trivially and would hide a
    // regression forever. If the layout moves, this fails first and says so.
    assert.ok(paths.length > 200, `only ${paths.length} paths walked — the scan is not reaching the repo`);
    assert.ok(paths.some(p => p.endsWith(path.join('aqua', 'router.js'))), 'the walk missed aqua/router.js');
  });

  test('nothing is named *backup* or *before-pr*', () => {
    const offenders = paths
      .filter(p => /(^|[\\/\\\\])[^\\/\\\\]*(backup|before-pr)[^\\/\\\\]*$/i.test(p))
      .map(p => path.relative(REPO, p))
      .sort();
    assert.deepEqual(offenders, [],
      `snapshot copies are back — version control keeps previous versions: ${offenders.join(', ')}`);
  });

  test('no `.orig`, `.bak` or `.old` files either', () => {
    // The same instinct, different spelling.
    const offenders = paths
      .filter(p => /\.(orig|bak|old|save|copy)$/i.test(p))
      .map(p => path.relative(REPO, p))
      .sort();
    assert.deepEqual(offenders, [], `stale copies: ${offenders.join(', ')}`);
  });

  test('the live pipeline is still there — deletion did not overreach', () => {
    // `pipeline.before-pr17.js` sat beside `pipeline.js`. A pattern match that
    // took the wrong one would be silent until the next boot.
    assert.ok(paths.some(p => p.endsWith(path.join('understanding', 'pipeline.js'))),
      'pipeline.js is gone — the deletion took the live file');
  });
});
