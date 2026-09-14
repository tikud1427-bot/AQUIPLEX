#!/usr/bin/env node
/**
 * AQUA dependency integrity doctor.
 *
 * npm can report a successful/usable lockfile while node_modules is only a
 * partially populated tree (for example after an interrupted npm ci). That
 * state makes test failures look like application regressions. This doctor
 * checks the installed top-level dependency surface against package.json and
 * reports exactly what is missing before any suite is treated as a signal.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const groups = [pkg.dependencies ?? {}, pkg.devDependencies ?? {}];
const deps = [...new Set(groups.flatMap(g => Object.keys(g)))].sort();

function packageRoot(name) {
  // npm package names are either `foo` or `@scope/foo`.
  return path.join(ROOT, 'node_modules', name, 'package.json');
}

const missing = deps.filter(name => !existsSync(packageRoot(name)));

console.log(`\nAQUA DEPENDENCY DOCTOR`);
console.log(`  declared: ${deps.length}`);
console.log(`  installed: ${deps.length - missing.length}`);
console.log(`  missing: ${missing.length}`);

if (missing.length) {
  console.log('\n  Missing top-level packages:');
  for (const name of missing) console.log(`    - ${name}`);
  console.log('\n  The dependency tree is incomplete. Do not use test failures as an application-quality baseline.');
  console.log('  Restore dependencies with: npm ci --ignore-scripts');
  console.log('  If installation is interrupted, rerun it; do not hand-create package folders.');
  process.exit(1);
}

console.log('\n  ✓ package.json top-level dependency surface is installed.');
process.exit(0);
