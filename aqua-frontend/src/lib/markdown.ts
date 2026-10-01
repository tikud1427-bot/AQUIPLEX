/**
 * Pure Markdown helpers — no React, no DOM.
 *
 * These live outside the component files for two reasons: react-refresh wants
 * a component module to export only components, and the regression suite
 * should be able to exercise the decisions without mounting anything.
 */

/**
 * Split markdown into stable top-level blocks (blank-line separated, fenced
 * code kept intact). During streaming, appended tokens only ever change the
 * LAST block — memoizing each block means everything above it skips
 * react-markdown's parse + render entirely on every frame. This is what
 * keeps long streaming answers smooth: parse cost stays O(tail block), not
 * O(entire message) per animation frame.
 *
 * Moved here verbatim from MarkdownRenderer; the algorithm is unchanged.
 */
export function splitMarkdownBlocks(content: string): string[] {
  const lines = content.split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  let fenceMarker = '';

  const push = () => {
    if (current.length) {
      blocks.push(current.join('\n'));
      current = [];
    }
  };

  let inMath = false;

  for (const line of lines) {
    // `$$ … $$` display math may contain blank lines; splitting there would
    // hand remark-math two halves of one formula. Fences win over math.
    if (!inFence && /^\s*\$\$\s*$/.test(line)) {
      inMath = !inMath;
      current.push(line);
      if (!inMath) push();
      continue;
    }
    if (inMath) {
      current.push(line);
      continue;
    }
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fenceMatch[1][0].repeat(3);
      } else if (line.trimStart().startsWith(fenceMarker)) {
        inFence = false;
        current.push(line);
        push(); // close the code block as its own unit
        continue;
      }
    }
    if (!inFence && line.trim() === '') {
      push();
      continue;
    }
    current.push(line);
  }
  push();
  return blocks;
}

export type TableLayout = 'plain' | 'stack' | 'scroll';

/** Longest cell we still read as "a value" rather than "a sentence". */
export const DENSE_CELL_CHARS = 20;
/** A two-column table only earns cards once its cells are genuinely prose. */
export const PAIR_PROSE_CHARS = 90;

/**
 * Pick a presentation from a table's shape.
 *
 *  plain  — wraps naturally at any width. Few columns, or short cells.
 *  scroll — genuinely tabular grid (many short/numeric columns). Keeps the
 *           grid and pans inside its own scroller when it cannot fit.
 *  stack  — prose laid out as a table. Becomes one labelled card per row on
 *           narrow containers, stays an ordinary table on wide ones.
 *
 * The rule set is deliberately small and shape-based rather than
 * content-sniffing: an AI can emit any table, and a heuristic nobody can
 * predict is worse than one that is occasionally conservative.
 */
export function chooseTableLayout(cols: number, maxCellChars: number): TableLayout {
  if (cols <= 1) return 'plain';
  if (maxCellChars <= DENSE_CELL_CHARS) return cols >= 4 ? 'scroll' : 'plain';
  if (cols >= 3) return 'stack';
  return maxCellChars > PAIR_PROSE_CHARS ? 'stack' : 'plain';
}

/**
 * Make the delimiters LLMs actually emit parseable by remark-math.
 *
 * Models write math as `\[ … \]` / `\( … \)` (LaTeX) and `$ … $`. CommonMark
 * treats `\[` and `\(` as escaped punctuation and drops the backslash, which
 * is why formulas used to show up as `[ \exists x … ]` with raw commands.
 * remark-math only understands `$`, so we rewrite to its dialect first:
 *
 *   \[ … \]  → display block   ($$ on its own lines)
 *   \( … \)  → inline          ($$…$$ — single-dollar parsing is off)
 *   $ … $      → inline          ($$…$$) only when it cannot be currency
 *
 * Fenced code and inline code are never touched. When `streaming`, a trailing
 * unclosed `\[` is opened as a display block so the formula does not flash as
 * garbled text until its closer arrives.
 */
export function normalizeMath(content: string, opts: { streaming?: boolean } = {}): string {
  if (!content.includes('\\') && !content.includes('$')) return content;

  // Split out code (fenced + inline) so it passes through verbatim.
  const parts = content.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g);
  const out = parts.map((part, i) => (i % 2 === 1 ? part : normalizeProse(part)));
  let result = out.join('');

  if (opts.streaming) {
    // An open \[ with no \] after it (outside code): open $$ early.
    const open = result.lastIndexOf('\\[');
    if (open !== -1 && result.indexOf('\\]', open) === -1 && !inCode(result, open)) {
      result = result.slice(0, open) + '\n$$\n' + result.slice(open + 2);
    }
  }
  return result;
}

function inCode(text: string, index: number): boolean {
  const fences = text.slice(0, index).match(/^\s*(```|~~~)/gm);
  return !!fences && fences.length % 2 === 1;
}

function normalizeProse(text: string): string {
  let t = text;
  // Display: \[ … \]  (may span lines). Keep $$ on their own lines so the
  // block splitter and remark-math both see a display block.
  t = t.replace(/\\\[([\s\S]+?)\\\]/g, (_m, body: string) => `\n$$\n${body.trim()}\n$$\n`);
  // Inline: \( … \)
  t = t.replace(/\\\(([\s\S]+?)\\\)/g, (_m, body: string) => `$$${body.trim()}$$`);
  // Pandoc-style $…$: opener not followed by space, closer not preceded by
  // space nor followed by a digit/word char — so "$5 and $10" stays currency.
  t = t.replace(
    /(?<![\\$\w])\$(?![\s$])([^$\n]+?)(?<![\s\\])\$(?![\d$\w])/g,
    (_m, body: string) => `$$${body}$$`,
  );
  return t;
}
