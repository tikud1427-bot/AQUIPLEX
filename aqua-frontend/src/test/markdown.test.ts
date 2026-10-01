import { describe, expect, it } from 'vitest';
import { chooseTableLayout, splitMarkdownBlocks } from '@/lib/markdown';
import { hasCitationMarkers, stripCitationMarkers } from '@/lib/citations';

describe('chooseTableLayout', () => {
  it('leaves a narrow table alone', () => {
    expect(chooseTableLayout(1, 400)).toBe('plain');
    expect(chooseTableLayout(2, 12)).toBe('plain');
    expect(chooseTableLayout(3, 12)).toBe('plain');
  });

  it('keeps a genuinely tabular grid as a grid and lets it pan', () => {
    // The regression this guards: cards are wrong for numbers. A seven-column
    // benchmark table read as one card per run would be unreadable.
    expect(chooseTableLayout(7, 12)).toBe('scroll');
    expect(chooseTableLayout(4, 20)).toBe('scroll');
  });

  it('stacks a prose table with three or more columns', () => {
    // The reported bug: four columns of sentences at 318px of column width.
    expect(chooseTableLayout(4, 62)).toBe('stack');
    expect(chooseTableLayout(3, 21)).toBe('stack');
  });

  it('only stacks a two-column table once its cells are really prose', () => {
    expect(chooseTableLayout(2, 60)).toBe('plain');
    expect(chooseTableLayout(2, 110)).toBe('stack');
  });
});

describe('splitMarkdownBlocks (streaming optimisation must survive)', () => {
  it('splits on blank lines', () => {
    expect(splitMarkdownBlocks('one\n\ntwo\n\nthree')).toEqual(['one', 'two', 'three']);
  });

  it('keeps a fenced block whole, blank lines and all', () => {
    const md = 'before\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nafter';
    const blocks = splitMarkdownBlocks(md);
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toBe('```js\nconst a = 1;\n\nconst b = 2;\n```');
  });

  it('keeps an unterminated fence in a single tail block', () => {
    // Partial code mid-stream must not be split into separately-parsed pieces.
    const blocks = splitMarkdownBlocks('intro\n\n```py\ndef f():\n\n    return 1');
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toContain('def f():');
  });

  it('keeps a table in one block so only the tail reparses while streaming', () => {
    const md = 'lead in\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |';
    const blocks = splitMarkdownBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[1].split('\n')).toHaveLength(4);
  });

  it('appends only to the last block as tokens arrive', () => {
    const head = 'para one\n\npara two';
    const grown = `${head} and more`;
    expect(splitMarkdownBlocks(grown).slice(0, -1)).toEqual(splitMarkdownBlocks(head).slice(0, -1));
  });
});

describe('stripCitationMarkers', () => {
  it('removes ASCII markers', () => {
    expect(stripCitationMarkers('Cool the skin [2] first.')).toBe('Cool the skin first.');
    expect(stripCitationMarkers('Both apply [1, 3].')).toBe('Both apply.');
    expect(stripCitationMarkers('With a range [1†L1-L3] here.')).toBe('With a range here.');
  });

  it('removes fullwidth CJK markers — these were reaching the reader', () => {
    // Straight from the shipped screenshots: an "Evidence" column whose entire
    // contents were 【2】 and 【3】.
    expect(stripCitationMarkers('Lowers temperature 【2】')).toBe('Lowers temperature');
    expect(stripCitationMarkers('General OTC guidance 【2】')).toBe('General OTC guidance');
    expect(stripCitationMarkers('| 【3】 |')).toBe('| |');
    expect(hasCitationMarkers('x 【7】')).toBe(true);
  });

  it('leaves markdown links, task lists and code alone', () => {
    expect(stripCitationMarkers('see [1](https://a.example)')).toBe('see [1](https://a.example)');
    expect(stripCitationMarkers('- [ ] todo')).toBe('- [ ] todo');
    expect(stripCitationMarkers('use `arr[0]` here')).toBe('use `arr[0]` here');
    expect(stripCitationMarkers('```\nrows[2]\n```')).toBe('```\nrows[2]\n```');
  });

  it('hides a half-typed marker of either bracket family while streaming', () => {
    expect(stripCitationMarkers('as of [1†L1-L', { streaming: true })).toBe('as of');
    expect(stripCitationMarkers('as of 【1', { streaming: true })).toBe('as of');
    // …but not once streaming is over, where a trailing bracket may be real.
    expect(stripCitationMarkers('an array like [1')).toBe('an array like [1');
  });
});

import { normalizeMath } from '@/lib/markdown';

describe('normalizeMath (LaTeX delimiters must survive markdown)', () => {
  it('rewrites \\[ \\] to a $$ display block', () => {
    const out = normalizeMath('x\n\n\\[ \\exists x \\in X;\\ f(x)=y \\]\n\ny');
    expect(out).toContain('$$\n\\exists x \\in X;\\ f(x)=y\n$$');
    expect(out).not.toContain('\\[');
  });

  it('rewrites \\( \\) to inline $$ (single-dollar parsing is off)', () => {
    expect(normalizeMath('the element \\(x\\) in \\(X\\)')).toBe('the element $$x$$ in $$X$$');
  });

  it('converts unambiguous $x$ but leaves currency alone', () => {
    expect(normalizeMath('let $f: X \\to Y$ be a map')).toBe('let $$f: X \\to Y$$ be a map');
    expect(normalizeMath('it costs $5 and $10 total')).toBe('it costs $5 and $10 total');
  });

  it('never touches code', () => {
    const md = 'use `\\(x\\)` and\n\n```tex\n\\[ a \\]\n```';
    expect(normalizeMath(md)).toBe(md);
  });

  it('opens an unclosed \\[ while streaming', () => {
    expect(normalizeMath('so\n\\[ \\forall x', { streaming: true })).toContain('$$\n \\forall x');
  });
});

describe('splitMarkdownBlocks with display math', () => {
  it('keeps a $$ block together across blank lines', () => {
    const blocks = splitMarkdownBlocks('a\n\n$$\nx\n\ny\n$$\n\nb');
    expect(blocks).toEqual(['a', '$$\nx\n\ny\n$$', 'b']);
  });
});
