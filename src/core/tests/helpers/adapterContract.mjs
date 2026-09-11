/**
 * AQUA Storage — the adapter CONTRACT, as a helper rather than a test file
 * Blueprint E3/PR-3, E3/PR-4 · L16
 *
 * 🔴 WHY THIS MOVED, AND WHAT IT WAS HIDING.
 *
 * The contract used to live in `storageAdapter.test.js`, which also CALLS it at
 * module scope for the JSON adapter. `pgBlobAdapter.test.js` reached it with
 * `await import('./storageAdapter.test.js')` from inside a running `test()` —
 * and importing a test file at runtime registers that file's describe/test
 * blocks as children of whatever test is executing. Node cancels those when the
 * parent finishes, so the json-file contract re-ran as an orphan and reported
 * "test did not finish before its parent and was cancelled".
 *
 * That suite had therefore NEVER passed. It only runs when DATABASE_URL is set,
 * and nothing in this project had a live Postgres until now — so the one test
 * written to be the live-database integration test failed the first time
 * anybody was in a position to run it. Its own header warns against "a green
 * suite that silently skipped its only integration test"; the guard was broken
 * in exactly the way it was guarding against.
 *
 * ⚠️ AND THE CRASH WAS THE SMALLER HALF. The pg test did not run the contract.
 * It asserted `typeof runAdapterContract === 'function'` — that the function
 * EXISTS. The comment above it promised "the same nine assertions the JSON
 * adapter satisfies, unchanged", and nine assertions were never executed
 * against Postgres. Fixing the import without noticing that would have turned
 * a loud failure into a quiet green that still proved nothing.
 *
 * A helper module registers nothing on import, so both suites can call it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { assertAdapter } from '../../storage/index.js';

/**
 * Exported shape, reused by E3/PR-4. Anything claiming to be a storage adapter
 * must satisfy every assertion below.
 */
export function runAdapterContract(name, makeAdapter, makeKey, opts = {}) {
  /**
   * A KNOWN DIVERGENCE is declared here, never silenced.
   *
   * `opts.todo` maps an assertion name to the reason that adapter does not
   * satisfy it. The assertion is NOT weakened and NOT removed — it still runs,
   * still fails, and TAP reports it under `# todo` with the reason attached.
   * The alternative that was tempting — loosening the concurrency assertion so
   * both adapters pass — would make "it works" mean two different things again,
   * which is the exact reason a shared contract exists.
   */
  const t = (title, fn) => test(title, { todo: opts.todo?.[title] ?? false }, fn);

  // `skip` is forwarded so a caller with no live database declines the whole
  // block WITH A REASON, rather than the suite quietly reporting zero.
  describe(`storage contract — ${name}`, { skip: opts.skip ?? false }, () => {
    t('implements the whole interface', () => {
      assert.equal(assertAdapter(makeAdapter()), true);
    });

    t('write then read returns exactly what was written', async () => {
      const a = makeAdapter(); const key = makeKey();
      await a.write(key, '{"hello":"world"}');
      assert.equal(a.readSync(key), '{"hello":"world"}');
    });

    t('writeSync then read returns exactly what was written', () => {
      const a = makeAdapter(); const key = makeKey();
      a.writeSync(key, '{"n":1}');
      assert.equal(a.readSync(key), '{"n":1}');
    });

    t('reading a key that was never written returns null, not a throw', () => {
      // Every store treats "no file yet" as an empty store. Throwing here would
      // turn a first boot into a crash.
      assert.equal(makeAdapter().readSync(makeKey()), null);
    });

    t('existsSync is false before a write and true after', async () => {
      const a = makeAdapter(); const key = makeKey();
      assert.equal(a.existsSync(key), false);
      await a.write(key, '{}');
      assert.equal(a.existsSync(key), true);
    });

    t('a write REPLACES rather than appends', async () => {
      const a = makeAdapter(); const key = makeKey();
      await a.write(key, '{"v":1}');
      await a.write(key, '{"v":2}');
      assert.equal(a.readSync(key), '{"v":2}');
    });

    t('unicode survives a round trip', async () => {
      const a = makeAdapter(); const key = makeKey();
      const payload = JSON.stringify({ s: 'café ☕ 日本語 עברית' });
      await a.write(key, payload);
      assert.equal(a.readSync(key), payload);
    });

    t('copySync duplicates content without disturbing the source', async () => {
      const a = makeAdapter(); const from = makeKey(); const to = `${from}.bak`;
      await a.write(from, '{"x":1}');
      a.copySync(from, to);
      assert.equal(a.readSync(to), '{"x":1}');
      assert.equal(a.readSync(from), '{"x":1}');
    });

    t('concurrent writes to one key all settle, last value wins', async () => {
      const a = makeAdapter(); const key = makeKey();
      await Promise.all([1, 2, 3, 4, 5].map(n => a.write(key, `{"n":${n}}`)));
      assert.match(a.readSync(key), /^\{"n":[1-5]\}$/, 'a concurrent write produced garbage');
    });
  });
}
