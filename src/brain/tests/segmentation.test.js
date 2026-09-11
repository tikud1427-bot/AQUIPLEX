/**
 * E6/PR-1 — segmentation with exact char ranges.
 *
 * The invariant that matters: for every located segment,
 * `original.slice(start, end)` must normalise back to exactly the segment
 * text. A span that is merely plausible is the dangerous outcome, because it
 * attributes a claim to text that does not say it and nothing downstream can
 * detect the error.
 *
 * Measured before this module existed: three of seven ordinary message shapes
 * could not be located by `indexOf` at all, because `splitSentences`
 * normalises whitespace before splitting. Those three shapes are pinned below.
 *
 * Run: node --test src/brain/tests/segmentation.test.js
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { segmentMessage, normalizeWithMap, verifySegments } from '../understanding/segmentation.js';
import { splitSentences } from '../../memory/sentenceParser.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');

describe('segmentation — the span invariant', () => {
  test('every located span normalises back to its segment text', () => {
    const samples = [
      'I work at Nummo. My co-founder is Dev.',
      'I work at\nNummo. My co-founder is Dev.',
      'I work at Nummo.\n\nMy co-founder is Dev.',
      '  I work at   Nummo.   My co-founder is Dev.  ',
      'Line one about churn\nLine two about Razorpay',
      'Dr. Mehta signed it. The fee is 500.',
      "i left intercom. now i'm at nummo.",
      'e.g. the billing service is slow. We should fix it.',
      'No punctuation at all',
      'Tabs\tand\tspaces   mixed. Second one here.',
    ];
    for (const s of samples) {
      const segs = segmentMessage(s);
      const v = verifySegments(s, segs);
      assert.ok(v.ok, `${JSON.stringify(s)} → ${JSON.stringify(v.failures)}`);
      assert.ok(segs.every(g => g.located), `${JSON.stringify(s)} had unlocated segments`);
    }
  });

  test('the three shapes that defeated naive indexOf are now located', () => {
    // These are the measured failures that motivated the module. Each one's
    // segment text does NOT occur in the original, so a fix that fell back to
    // indexOf would fail here rather than pass quietly.
    for (const s of [
      'I work at\nNummo. My co-founder is Dev.',
      '  I work at   Nummo.   My co-founder is Dev.  ',
      'Line one about churn\nLine two about Razorpay',
    ]) {
      const segs = segmentMessage(s);
      assert.ok(segs.length > 0, 'produced segments');
      assert.ok(segs.every(g => g.located), 'all located');
      const unfindable = segs.filter(g => s.indexOf(g.text) === -1);
      assert.ok(unfindable.length > 0,
        `${JSON.stringify(s)} no longer exercises the defect — indexOf can find every segment, so this case has stopped testing anything`);
      assert.ok(verifySegments(s, segs).ok, 'and the spans still round-trip');
    }
  });

  test('a span may contain whitespace the segment text does not', () => {
    const s = 'I work at\nNummo. Next.';
    const [first] = segmentMessage(s);
    assert.equal(first.text, 'I work at Nummo.');
    assert.equal(s.slice(first.start, first.end), 'I work at\nNummo.',
      'the ORIGINAL bytes are preserved — this is the point of a range over a copy of the text');
  });

  test('repeated identical sentences get DISTINCT spans', () => {
    // A bare indexOf would return the first occurrence twice, and both spans
    // would look reasonable in isolation.
    const segs = segmentMessage('Yes. Yes.');
    assert.equal(segs.length, 2);
    assert.notDeepEqual([segs[0].start, segs[0].end], [segs[1].start, segs[1].end]);
    assert.equal(segs[0].end, 4);
    assert.equal(segs[1].start, 5);
  });

  test('spans do not swallow the whitespace between sentences', () => {
    const s = 'One here.   Two here.';
    const [a, b] = segmentMessage(s);
    assert.equal(s.slice(a.start, a.end), 'One here.');
    assert.equal(s.slice(b.start, b.end), 'Two here.');
    assert.ok(a.end < b.start, 'a gap exists between them');
  });

  test('the FINAL segment ends at its last character, not at end-of-string', () => {
    // Found by mutation: dropping the end calculation leaves `end` undefined
    // for the last segment, and `slice(start, undefined)` runs to the end of
    // the string — which still round-trips, because the round-trip normalises
    // and trims away exactly the trailing whitespace that would have exposed
    // it. Every other test in this file passed under that mutation.
    const s = 'One here. Last one.   \n  ';
    const segs = segmentMessage(s);
    const last = segs[segs.length - 1];
    assert.equal(typeof last.end, 'number', 'end is a number, not undefined');
    assert.equal(s.slice(last.start, last.end), 'Last one.',
      'the span stops at the sentence, not at the end of the buffer');
    assert.ok(last.end < s.length, 'trailing whitespace is outside the span');
  });

  test('spans are ordered, non-overlapping, and inside the text', () => {
    const s = 'First point about churn. Second about Razorpay. Third: 10,000 merchants by Dec.';
    const segs = segmentMessage(s);
    assert.ok(segs.length >= 3);
    let prevEnd = -1;
    for (const g of segs) {
      assert.ok(g.start >= 0 && g.end <= s.length, 'within bounds');
      assert.ok(g.start < g.end, 'non-empty');
      assert.ok(g.start >= prevEnd, 'non-overlapping and in order');
      prevEnd = g.end;
    }
  });
});

describe('segmentation — boundaries come from the parser, not from here', () => {
  test('segment texts are EXACTLY splitSentences output', () => {
    // The abbreviation list and the removed capital-letter lookahead live in
    // sentenceParser. If this module ever starts deciding boundaries itself it
    // will drift from the parser, and the drift shows up as claims attributed
    // to the wrong span. This asserts the delegation rather than trusting it.
    for (const s of [
      'Dr. Mehta signed it. The fee is 500.',
      'e.g. the billing service is slow. We should fix it.',
      "my brother's name is ananya. he is the co-founder.",
      'Costs 3.14 dollars. Cheap.',
    ]) {
      assert.deepEqual(segmentMessage(s).map(g => g.text), splitSentences(s),
        `boundaries diverged from splitSentences for ${JSON.stringify(s)}`);
    }
  });
});

describe('segmentation — empty and degenerate input', () => {
  for (const [label, input] of [
    ['empty string', ''],
    ['whitespace only', '   \n\t  '],
    ['null', null],
    ['undefined', undefined],
    ['number', 42],
  ]) {
    test(`${label} yields no segments and does not throw`, () => {
      assert.deepEqual(segmentMessage(input), []);
    });
  }
});

describe('normalizeWithMap', () => {
  test('the map has one entry per cleaned character', () => {
    const { cleaned, map } = normalizeWithMap('  a   b\n\nc  ');
    assert.equal(cleaned, 'a b c');
    assert.equal(map.length, cleaned.length);
  });

  test('every mapped offset points at the right original character', () => {
    const src = 'I work at\nNummo.';
    const { cleaned, map } = normalizeWithMap(src);
    for (let i = 0; i < cleaned.length; i++) {
      if (cleaned[i] === ' ') {
        assert.match(src[map[i]], /\s/, `cleaned space at ${i} maps to whitespace`);
      } else {
        assert.equal(src[map[i]], cleaned[i], `cleaned[${i}] maps to the same character`);
      }
    }
  });

  test('a collapsed whitespace run maps to the FIRST character of the run', () => {
    const src = 'a\n\n\nb';
    const { map } = normalizeWithMap(src);
    assert.equal(map[1], 1, 'the single space points inside the run, not past it');
  });
});

describe('segmentation — the real eval corpora', () => {
  const corpus = [];
  for (const rel of ['eval/datasets/capture-core.v1.json', 'eval/datasets/extraction-core.v1.json']) {
    const ds = JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));
    for (const c of ds.cases) {
      if (Array.isArray(c.turns)) corpus.push(...c.turns);
      for (const k of ['text', 'sentence', 'a', 'b']) if (typeof c[k] === 'string') corpus.push(c[k]);
    }
  }

  test('the corpus is real and non-trivial', () => {
    // Guards the two tests below from passing on an empty array if a dataset
    // is renamed or its field names change.
    assert.ok(corpus.length >= 40, `only ${corpus.length} texts — the corpus loader stopped finding content`);
  });

  test('100% of segments are located across both datasets', () => {
    let total = 0, located = 0;
    for (const text of corpus) {
      const segs = segmentMessage(text);
      total += segs.length;
      located += segs.filter(g => g.located).length;
    }
    assert.ok(total >= 40, `only ${total} segments produced`);
    assert.equal(located, total, `${total - located} of ${total} segments could not be located`);
  });

  test('100% of spans round-trip across both datasets', () => {
    const bad = [];
    for (const text of corpus) {
      const v = verifySegments(text, segmentMessage(text));
      if (!v.ok) bad.push({ text: text.slice(0, 60), failures: v.failures });
    }
    assert.deepEqual(bad, [], `${bad.length} texts produced spans that do not normalise back`);
  });
});
