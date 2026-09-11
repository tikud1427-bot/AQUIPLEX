/**
 * Artifact security primitives — hostile-input regression tests.
 * Every write/read path in the engine depends on these holding.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import {
  sanitizeRelativePath, resolveInsideRoot, checkExecutable, slugify,
  ArtifactSecurityError, QUOTAS,
} from '../security.js';

// ── sanitizeRelativePath ──────────────────────────────────────────────────────

test('accepts and normalizes safe paths', () => {
  assert.equal(sanitizeRelativePath('README.md'), 'README.md');
  assert.equal(sanitizeRelativePath('src/index.js'), 'src/index.js');
  assert.equal(sanitizeRelativePath('docs\\guide\\intro.md'), 'docs/guide/intro.md');
  assert.equal(sanitizeRelativePath('  notes.txt  '), 'notes.txt');
  assert.equal(sanitizeRelativePath('Dockerfile'), 'Dockerfile');
  assert.equal(sanitizeRelativePath('a/b/c/d/e.json'), 'a/b/c/d/e.json');
});

test('rejects traversal in every disguise', () => {
  const hostile = [
    '../etc/passwd',
    'a/../../b',
    '..',
    'src/..',
    '..\\windows\\system32',
    'a/./b',           // '.' segment
  ];
  for (const p of hostile) {
    assert.throws(() => sanitizeRelativePath(p), ArtifactSecurityError, p);
  }
});

test('rejects absolute, drive-letter, and empty paths', () => {
  for (const p of ['/etc/passwd', '\\\\share\\x', 'C:/win.ini', 'c:\\boot.ini', '', '   ', 'a//b', 'a/b/']) {
    assert.throws(() => sanitizeRelativePath(p), ArtifactSecurityError, JSON.stringify(p));
  }
});

test('rejects control chars, null bytes, reserved names, oversized segments', () => {
  assert.throws(() => sanitizeRelativePath('bad\u0000name.txt'), ArtifactSecurityError);
  assert.throws(() => sanitizeRelativePath('line\nbreak.md'), ArtifactSecurityError);
  for (const p of ['CON', 'con.md', 'docs/NUL.txt', 'COM1.json', 'lpt9']) {
    assert.throws(() => sanitizeRelativePath(p), ArtifactSecurityError, p);
  }
  assert.throws(() => sanitizeRelativePath('x'.repeat(QUOTAS.MAX_SEGMENT_LENGTH + 1)), ArtifactSecurityError);
  assert.throws(() => sanitizeRelativePath('a/'.repeat(600) + 'f'), ArtifactSecurityError); // total length
  assert.throws(() => sanitizeRelativePath(42), ArtifactSecurityError);
});

// ── resolveInsideRoot ─────────────────────────────────────────────────────────

test('resolveInsideRoot contains resolved paths', () => {
  const root = path.resolve('/tmp/aqua-test-root');
  assert.equal(resolveInsideRoot(root, 'a/b.txt'), path.join(root, 'a/b.txt'));
  // Even if a hostile path slipped past sanitize, resolution still refuses:
  assert.throws(() => resolveInsideRoot(root, '../outside.txt'), ArtifactSecurityError);
  assert.throws(() => resolveInsideRoot(root, 'a/../../x'), ArtifactSecurityError);
  // Prefix-sibling attack: /tmp/aqua-test-root-evil must NOT pass a
  // startsWith(root) check without the separator guard.
  assert.throws(() => resolveInsideRoot(root, '../aqua-test-root-evil/x'), ArtifactSecurityError);
});

// ── checkExecutable ───────────────────────────────────────────────────────────

test('blocks native executables by extension and magic bytes', () => {
  assert.equal(checkExecutable('setup.exe').forbidden, true);
  assert.equal(checkExecutable('lib.dll').forbidden, true);
  assert.equal(checkExecutable('mod.so').forbidden, true);
  assert.equal(checkExecutable('x.bin', Buffer.from([0x4d, 0x5a, 0x90, 0x00])).forbidden, true); // MZ
  assert.equal(checkExecutable('x.bin', Buffer.from([0x7f, 0x45, 0x4c, 0x46])).forbidden, true); // ELF
  assert.equal(checkExecutable('x.bin', Buffer.from([0xfe, 0xed, 0xfa, 0xce])).forbidden, true); // Mach-O
});

test('allows text scripts — .sh/.bat are legitimate artifacts', () => {
  assert.equal(checkExecutable('deploy.sh', Buffer.from('#!/usr/bin/env bash\n')).forbidden, false);
  assert.equal(checkExecutable('run.bat', Buffer.from('@echo off\n')).forbidden, false);
  assert.equal(checkExecutable('README.md', Buffer.from('# hi')).forbidden, false);
});

// ── slugify ───────────────────────────────────────────────────────────────────

test('slugify produces filesystem-safe non-empty names', () => {
  assert.equal(slugify('Investor Pitch Deck'), 'Investor-Pitch-Deck');
  assert.equal(slugify('Q3 / Revenue: Report!'), 'Q3-Revenue-Report');
  assert.equal(slugify('   '), 'artifact');
  assert.equal(slugify('../../etc'), 'etc');
  assert.ok(slugify('x'.repeat(300)).length <= 80);
});
