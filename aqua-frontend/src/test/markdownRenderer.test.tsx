import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer';
import { MARKDOWN_FIXTURES, PROSE_FIXTURE } from './fixtures/markdownTables';

/**
 * These assert STRUCTURE, not geometry — jsdom has no layout engine, so it can
 * tell you the card layout is wired up and cannot tell you it looks right.
 * Geometry lives in e2e/markdown-tables.spec.ts, which needs a real browser.
 *
 * What this suite is actually for: the exact failure in the bug report was a
 * silent one. Nothing threw, nothing logged, TypeScript was happy, the build
 * was green — the table simply became unreadable. Every check below is a
 * property that, if it flips back, brings that failure back with it.
 */

afterEach(cleanup);

const table = () => document.querySelector('table.md-table') as HTMLTableElement | null;

describe('MarkdownRenderer — prose wrapping', () => {
  it('never puts `overflow-wrap: anywhere` on the prose root', () => {
    // THE regression. `anywhere` contributes to min-content intrinsic size, so
    // a prose root carrying it lets automatic table layout shrink every column
    // to one character — which is precisely how "Cool" became "Co / ol".
    const { container } = render(<MarkdownRenderer content={PROSE_FIXTURE} />);
    const root = container.querySelector('.md-prose');
    expect(root).not.toBeNull();
    expect(root?.className).not.toMatch(/anywhere/);
  });

  it('renders ordinary prose constructs', () => {
    const { container } = render(<MarkdownRenderer content={PROSE_FIXTURE} />);
    expect(container.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(container.querySelectorAll('ul').length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector('blockquote')).not.toBeNull();
  });

  it('shifts message headings below the page heading', () => {
    // The conversation title in Header.tsx is the page's only <h1>; an answer
    // must not mint a second one.
    const { container } = render(<MarkdownRenderer content={'# Top\n\n## Second'} />);
    expect(container.querySelector('h1')).toBeNull();
    expect(container.querySelector('h2')?.textContent).toBe('Top');
    expect(container.querySelector('h3')?.textContent).toBe('Second');
  });
});

describe.each(MARKDOWN_FIXTURES)('fixture: $name', (fixture) => {
  it('chooses the expected presentation', () => {
    render(<MarkdownRenderer content={fixture.markdown} />);
    expect(table()?.dataset.mdLayout).toBe(fixture.expect);
  });

  it('stays a real table with an intact accessibility tree', () => {
    render(<MarkdownRenderer content={fixture.markdown} />);
    const t = table();
    expect(t).not.toBeNull();
    // Roles are explicit because re-`display`ing table elements into cards
    // drops their implicit semantics in every engine.
    expect(t?.getAttribute('role')).toBe('table');
    expect(t?.querySelector('tr')?.getAttribute('role')).toBe('row');
    expect(t?.querySelector('th')?.getAttribute('role')).toBe('columnheader');
    expect(t?.querySelector('th')?.getAttribute('scope')).toBe('col');
    expect(t?.querySelector('tbody td')?.getAttribute('role')).toBe('cell');
  });

  it('gives every body cell the header it belongs to', () => {
    // `data-md-label` is what the card layout echoes above each value. Without
    // it, a stacked row is an unlabelled pile of sentences.
    render(<MarkdownRenderer content={fixture.markdown} />);
    const t = table();
    const headers = [...(t?.querySelectorAll('thead th') ?? [])].map((th) => th.textContent?.trim());
    for (const row of t?.querySelectorAll('tbody tr') ?? []) {
      [...row.querySelectorAll('td')].forEach((td, i) => {
        if (headers[i]) expect(td.dataset.mdLabel).toBe(headers[i]);
      });
    }
  });

  it('only adds a keyboard tab stop where something actually scrolls', () => {
    render(<MarkdownRenderer content={fixture.markdown} />);
    const scroller = document.querySelector('.md-table-scroller');
    if (fixture.expect === 'scroll') {
      expect(scroller?.getAttribute('tabindex')).toBe('0');
      expect(scroller?.getAttribute('role')).toBe('region');
      expect(scroller?.getAttribute('aria-label')).toBeTruthy();
    } else {
      expect(scroller?.hasAttribute('tabindex')).toBe(false);
    }
  });
});

describe('fixture specifics', () => {
  it('Case 2 — no internal citation marker survives into the reader-facing DOM', () => {
    const four = MARKDOWN_FIXTURES.find((f) => f.id === 'four-column-prose')!;
    const { container } = render(<MarkdownRenderer content={four.markdown} stripCitations />);
    expect(container.textContent).not.toMatch(/【\s*\d/);
    expect(container.textContent).not.toMatch(/\[\s*\d+\s*\]/);
    // The answer itself is untouched.
    expect(container.textContent).toContain('Lowers temperature');
  });

  it('Case 4 — a long URL keeps its own break rules, not the whole cell’s', () => {
    const urls = MARKDOWN_FIXTURES.find((f) => f.id === 'long-urls')!;
    const { container } = render(<MarkdownRenderer content={urls.markdown} />);
    const link = container.querySelector('td a');
    expect(link).not.toBeNull();
    // `.md-prose a { overflow-wrap: anywhere }` is what lets the URL break
    // without licensing the same for every word around it.
    expect(container.querySelector('.md-prose')).not.toBeNull();
  });

  it('Case 6 — a mid-stream table renders, with the streaming cursor after it', () => {
    const partial = MARKDOWN_FIXTURES.find((f) => f.id === 'streaming-partial')!;
    const { container } = render(<MarkdownRenderer content={partial.markdown} streaming />);
    expect(table()).not.toBeNull();
    expect(container.querySelector('.streaming-cursor')).not.toBeNull();
    expect(screen.getByText(/Cool the skin/)).toBeTruthy();
  });

  it('Case 6 — a table growing row by row never changes presentation mid-stream', () => {
    // Presentation churn while tokens arrive is its own bug: the reader watches
    // the answer reformat itself. Rows only ever make cells longer, so once the
    // header row and one body row exist the decision has to be stable.
    const rows = [
      '| Action | How | Why it works | Evidence |',
      '| --- | --- | --- | --- |',
      '| Cool the skin | 10-15 min cool shower or wet washcloth | Lowers temperature and reduces inflammation | 1 |',
      '| Gentle cleanse | Mild fragrance-free cleanser; pat dry | Removes sweat without stripping the barrier | 2 |',
      '| Hydrate | Thick soothing moisturiser on damp skin | Locks in water and prevents peeling | 3 |',
    ];
    const seen = new Set<string>();
    for (let i = 3; i <= rows.length; i++) {
      cleanup();
      render(<MarkdownRenderer content={rows.slice(0, i).join('\n')} streaming />);
      seen.add(table()?.dataset.mdLayout ?? 'none');
    }
    expect([...seen]).toEqual(['stack']);
  });

  it('Case 8 — rich cell content survives the cell wrapper', () => {
    const rich = MARKDOWN_FIXTURES.find((f) => f.id === 'rich-cells')!;
    const { container } = render(<MarkdownRenderer content={rich.markdown} stripCitations />);
    expect(container.querySelector('td code')).not.toBeNull();
    expect(container.querySelector('td strong')).not.toBeNull();
    expect(container.querySelector('td em')).not.toBeNull();
    expect(container.querySelector('td a')?.getAttribute('target')).toBe('_blank');
  });

  it('Case 7 — a dense grid is not turned into cards', () => {
    const dense = MARKDOWN_FIXTURES.find((f) => f.id === 'many-rows-dense')!;
    render(<MarkdownRenderer content={dense.markdown} />);
    expect(table()?.dataset.mdLayout).toBe('scroll');
    expect(table()?.querySelectorAll('tbody tr')).toHaveLength(10);
  });
});

describe('math rendering (regression: AQUA formulas showed as raw LaTeX)', () => {
  const sample = [
    '**(a)** y is in the image of f',
    '',
    '\\[ \\exists x \\in X;\\; \\bigl(f(x)=y\\bigr) \\]',
    '',
    'there exists \\(x\\) in the domain \\(X\\).',
    '',
    '\\[ \\neg\\exists x \\in X;\\; \\bigl(f(x)=z\\bigr) \\qquad\\text{or equivalently}\\qquad \\forall x \\in X;\\; \\bigl(f(x)\\neq z\\bigr) \\]',
  ].join('\n');

  it('renders KaTeX and leaves no raw commands behind', () => {
    const { container } = render(<MarkdownRenderer content={sample} />);
    expect(container.querySelectorAll('.katex-display').length).toBe(2);
    expect(container.querySelectorAll('.katex').length).toBeGreaterThanOrEqual(4);
    // KaTeX keeps the TeX source in a visually-hidden MathML annotation for
    // screen readers; what a sighted user sees is the .katex-html layer.
    container.querySelectorAll('.katex-mathml').forEach((n) => n.remove());
    const text = container.textContent ?? '';
    expect(text).not.toContain('\\bigl');
    expect(text).not.toContain('\\exists');
    expect(text).toContain('∃');
    expect(container.querySelector('.katex-error')).toBeNull();
  });

  it('keeps currency as prose', () => {
    const { container } = render(<MarkdownRenderer content="It costs $5 and $10." />);
    expect(container.querySelector('.katex')).toBeNull();
    expect(container.textContent).toContain('$5 and $10');
  });
});
