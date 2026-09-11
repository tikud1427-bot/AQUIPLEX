/**
 * Account purge is COMPLETE, and completeness is derived — not listed
 * Blueprint G4 (purgeable) · L5 (deletion is the one exception) · L19
 *
 * `accountPurge.test.js` proves that the stores it names are emptied. It cannot
 * prove that it names all of them, because it is itself the list. Add a
 * nineteenth owner-scoped store tomorrow, forget one import in
 * `accountPurge.js`, and every purge test still passes while a deleted user's
 * data survives in it. Under Google Play's deletion policy that is not a bug
 * report, it is a compliance failure that reports success.
 *
 * A completeness test with a hand-maintained list is not a completeness test.
 *
 * So this walks the import graph. Any module that exports `purgeOwner` must be
 * REACHABLE from `accountPurge.js` — directly or through another module that
 * is. Transitive reachability matters: `idStore.purgeOwner` is never imported
 * by the aggregator, it is called by `brain/index.js` which is, and that is a
 * correct composition rather than a gap.
 *
 * BITE, MEASURED (revert the named property → count failures):
 *   drop the reasoningGraph import from accountPurge.js  → 1 fail
 *   drop the brain import (orphans idStore + annotations) → 1 fail
 *   add a new store exporting purgeOwner, unwired         → 1 fail
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../..');
const ENTRY = path.resolve(SRC, 'account/accountPurge.js');

function allSources(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry !== 'tests' && entry !== 'node_modules') allSources(p, out);
    } else if (entry.endsWith('.js') && !entry.endsWith('.test.js')) out.push(p);
  }
  return out;
}

/** Modules that know how to drop one owner's data. */
function purgeCapableModules() {
  return allSources(SRC).filter(f =>
    /export\s+(async\s+)?function\s+purgeOwner\b/.test(readFileSync(f, 'utf8')));
}

/** Resolve a relative specifier to an absolute file path, or null if external. */
function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const p = path.resolve(path.dirname(fromFile), spec);
  try { return statSync(p).isFile() ? p : null; } catch { return null; }
}

/**
 * Which modules does THIS file actually purge?
 *
 * 🔴 IMPORT REACHABILITY IS NOT THE GUARANTEE, AND THE FIRST VERSION OF THIS
 * FILE USED IT. Deleting the `reasoningGraph` purge call from the aggregator
 * left the test green, because `reasoningGraph` is still imported elsewhere in
 * the graph for entirely unrelated reasons. "Reachable" answers "could this
 * code be loaded", and the question is "is this owner's data dropped".
 *
 * So this looks for the call, not the edge. Three import shapes, each requiring
 * the bound name to actually be invoked somewhere in the file:
 *
 *   import { purgeOwner as purgeX } from './x.js'   →  purgeX(...)
 *   import { purgeOwner }          from './x.js'    →  purgeOwner(...)
 *   import * as x                  from './x.js'    →  x.purgeOwner(...)
 *
 * The third shape is why the match is a substring rather than anchored:
 * `brain/index.js` reaches the annotation store as `deps.annotations.purgeOwner`
 * through its injected dependency set, and an anchored pattern would read that
 * as unpurged.
 */
function purgesPerformedBy(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];

  const consider = (spec, boundName, callPattern) => {
    const target = resolveSpec(file, spec);
    if (target && callPattern.test(text)) out.push(target);
    return boundName;
  };

  for (const m of text.matchAll(/import\s*\{[^}]*\bpurgeOwner\s+as\s+(\w+)[^}]*\}\s*from\s*['"]([^'"]+)['"]/g)) {
    consider(m[2], m[1], new RegExp(`\\b${m[1]}\\s*\\(`));
  }
  for (const m of text.matchAll(/import\s*\{[^}]*\bpurgeOwner\b(?![^}]*\bas\b)[^}]*\}\s*from\s*['"]([^'"]+)['"]/g)) {
    consider(m[1], 'purgeOwner', /\bpurgeOwner\s*\(/);
  }
  for (const m of text.matchAll(/import\s*\*\s*as\s+(\w+)\s*from\s*['"]([^'"]+)['"]/g)) {
    consider(m[2], m[1], new RegExp(`\\b${m[1]}\\.purgeOwner\\s*\\(`));
  }
  return out;
}

/**
 * Closure of "stores whose owner data account deletion actually drops".
 *
 * A module joins the frontier once something on a purge chain calls its
 * purgeOwner — and then its OWN purge calls count, which is how the aggregator
 * covers idStore by way of brain/index.js.
 */
function purgedFrom(entry) {
  const covered = new Set();
  const frontier = [entry];
  while (frontier.length) {
    for (const target of purgesPerformedBy(frontier.pop())) {
      if (!covered.has(target)) { covered.add(target); frontier.push(target); }
    }
  }
  return covered;
}

const rel = f => path.relative(SRC, f);

describe('every owner-purgeable store is reachable from account deletion (G4)', () => {
  test('the scan finds the stores it is supposed to find', () => {
    // A reachability test over an empty set passes trivially. This is the
    // denominator, and it is the first thing that breaks if the detection
    // pattern stops matching how the codebase writes these functions.
    const found = purgeCapableModules().map(rel).sort();
    assert.ok(found.length >= 8, `only ${found.length} purge-capable modules found — the scan is broken`);
    for (const expected of [
      'brain/index.js', 'brain/identity/idStore.js', 'brain/worldModel/annotationStore.js',
      'files/evidenceStore.js', 'files/fileSearchIndex.js', 'files/ukoStore.js',
      'pic/picStore.js', 'reasoning/reasoningGraph.js',
    ]) assert.ok(found.includes(expected), `scan missed a known purge module: ${expected}`);
  });

  test('NO purge-capable store is orphaned from the aggregator', () => {
    const covered = purgedFrom(ENTRY);
    const orphans = purgeCapableModules().filter(m => !covered.has(m)).map(rel).sort();
    assert.deepEqual(orphans, [],
      `these stores can drop an owner but account deletion never calls them: ${orphans.join(', ')}`);
  });

  test('coverage is TRANSITIVE, and that is deliberate', () => {
    // idStore is not imported by the aggregator. brain/index.js is, and its own
    // purgeOwner calls idStore's. Requiring a direct import would push every
    // store into one file and break the composition the aggregator describes.
    const direct = readFileSync(ENTRY, 'utf8');
    assert.ok(!direct.includes('identity/idStore'), 'idStore is now imported directly — update this test');
    assert.ok(purgedFrom(ENTRY).has(path.resolve(SRC, 'brain/identity/idStore.js')),
      'idStore is not purged — the transitive walk is broken');
  });

  test('an IMPORT without a CALL does not count as coverage', () => {
    // The property the first version of this file got wrong. Coverage is the
    // invocation; a module imported for unrelated reasons is not purged by
    // being imported.
    const fake = '/tmp/__purge_probe__.js';
    writeFileSync(fake, "import { purgeOwner as p } from '../home/claude/nonexistent.js';\n");
    try {
      assert.deepEqual(purgesPerformedBy(fake), [], 'an unresolvable import was counted as a purge');
    } finally { rmSync(fake, { force: true }); }
  });
});
