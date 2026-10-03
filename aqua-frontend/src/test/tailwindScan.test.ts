/**
 * TAILWIND READS COMMENTS.
 *
 * Tailwind v4 scans source files as plain text for anything shaped like a
 * utility class — including inside comments and strings. A comment in Header.tsx
 * spelled out a top-padding class whose bracketed value ended in an ellipsis; it
 * was extracted as a class, compiled to a padding-top rule with a literal
 * ellipsis, and every `vite build` printed
 *   Found 1 warning while optimizing generated CSS: Unexpected token Delim('.')
 * The class never existed; the comment manufactured it.
 *
 * So a bracketed arbitrary value containing "..." is a defect wherever it
 * appears. Real arbitrary values (`h-[calc(3rem+env(safe-area-inset-top))]`)
 * never contain an ellipsis, so this has no false positives in this tree.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..');
const EXT = /\.(tsx?|css|html)$/;
const BAD = /[A-Za-z][\w-]*-\[[^\]\s]*\.\.\.[^\]\s]*\]/;

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === 'node_modules' ? [] : walk(p);
    return EXT.test(d.name) && !d.name.endsWith('.test.ts') && !d.name.endsWith('.test.tsx') ? [p] : [];
  });
}

describe('no phantom Tailwind classes', () => {
  it('detector matches the original offender and ignores real arbitrary values', () => {
    const dots = '.'.repeat(3);
    const offender = ['pt', '-[', 'env(', dots, ')]'].join('');
    expect(BAD.test(`plus ${offender} under`)).toBe(true);
    expect(BAD.test('h-[calc(3rem+env(safe-area-inset-top))]')).toBe(false);
    expect(BAD.test('pt-[env(safe-area-inset-top)]')).toBe(false);
  });

  it('no source file contains a bracketed arbitrary value with an ellipsis', () => {
    const hits = walk(SRC).flatMap((f) =>
      fs.readFileSync(f, 'utf8').split('\n').flatMap((line, i) =>
        BAD.test(line) ? [`${path.relative(SRC, f)}:${i + 1}: ${line.trim().slice(0, 90)}`] : []));
    expect(hits).toEqual([]);
  });
});
