/**
 * AQUA Diff Engine (Day 4)
 *
 * Real line-level diffing for patch-first editing:
 *   - Myers-style LCS diff (correct, not the old 4-line-lookahead greedy scan)
 *   - Hunk generation with configurable context lines (unified-diff semantics)
 *   - Structured output (per-line ops + line numbers) for rich UI rendering
 *   - Unified-diff text rendering for LLM prompts / logs / copy-paste
 *   - Per-file added/removed stats
 *
 * Pure module: no I/O, no LLM calls, no imports from the rest of the app.
 * patchGenerator.js and editEngine.js both consume it.
 */

const DEFAULT_CONTEXT = 3;

// ── LCS core ──────────────────────────────────────────────────────────────────

/**
 * Compute a minimal edit script between two line arrays.
 * Returns ops: [{ type: 'equal'|'del'|'add', oldLine?, newLine?, text }]
 * Line numbers are 1-based.
 */
export function computeLineOps(oldLines, newLines) {
  const n = oldLines.length;
  const m = newLines.length;

  // Trim common prefix/suffix first — typical edits touch a small region,
  // this keeps the DP table tiny even for large files.
  let start = 0;
  while (start < n && start < m && oldLines[start] === newLines[start]) start++;
  let endOld = n, endNew = m;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld--; endNew--;
  }

  const midOld = oldLines.slice(start, endOld);
  const midNew = newLines.slice(start, endNew);

  const ops = [];
  for (let i = 0; i < start; i++) {
    ops.push({ type: 'equal', oldLine: i + 1, newLine: i + 1, text: oldLines[i] });
  }

  ops.push(..._lcsOps(midOld, midNew, start, start));

  const suffixLen = n - endOld;
  for (let i = 0; i < suffixLen; i++) {
    ops.push({
      type: 'equal',
      oldLine: endOld + i + 1,
      newLine: endNew + i + 1,
      text: oldLines[endOld + i],
    });
  }
  return ops;
}

function _lcsOps(a, b, oldOffset, newOffset) {
  const n = a.length, m = b.length;
  if (!n && !m) return [];

  // Guard: O(n*m) table; cap at ~4M cells then fall back to whole-block replace.
  if (n * m > 4_000_000) {
    const ops = [];
    for (let i = 0; i < n; i++) ops.push({ type: 'del', oldLine: oldOffset + i + 1, text: a[i] });
    for (let j = 0; j < m; j++) ops.push({ type: 'add', newLine: newOffset + j + 1, text: b[j] });
    return ops;
  }

  // DP LCS lengths
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] = a[i] === b[j]
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }

  // Backtrack
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'equal', oldLine: oldOffset + i + 1, newLine: newOffset + j + 1, text: a[i] });
      i++; j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      ops.push({ type: 'del', oldLine: oldOffset + i + 1, text: a[i] });
      i++;
    } else {
      ops.push({ type: 'add', newLine: newOffset + j + 1, text: b[j] });
      j++;
    }
  }
  while (i < n) { ops.push({ type: 'del', oldLine: oldOffset + i + 1, text: a[i] }); i++; }
  while (j < m) { ops.push({ type: 'add', newLine: newOffset + j + 1, text: b[j] }); j++; }
  return ops;
}

// ── Hunks ─────────────────────────────────────────────────────────────────────

/**
 * Group ops into unified-diff hunks with `context` equal lines around changes.
 * Unchanged stretches between hunks are omitted (the UI shows them collapsed).
 *
 * @returns {{ hunks, stats: { added, removed } }}
 */
export function buildHunks(ops, context = DEFAULT_CONTEXT) {
  const stats = { added: 0, removed: 0 };
  for (const op of ops) {
    if (op.type === 'add') stats.added++;
    else if (op.type === 'del') stats.removed++;
  }
  if (!stats.added && !stats.removed) return { hunks: [], stats };

  // Mark ops to keep (changes + context window around them)
  const keep = new Array(ops.length).fill(false);
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].type !== 'equal') {
      for (let c = Math.max(0, k - context); c <= Math.min(ops.length - 1, k + context); c++) {
        keep[c] = true;
      }
    }
  }

  const hunks = [];
  let current = null;
  for (let k = 0; k < ops.length; k++) {
    if (!keep[k]) { current = null; continue; }
    const op = ops[k];
    if (!current) {
      current = {
        oldStart: op.oldLine ?? _nextOldLine(ops, k),
        newStart: op.newLine ?? _nextNewLine(ops, k),
        oldCount: 0,
        newCount: 0,
        lines: [],
      };
      hunks.push(current);
    }
    current.lines.push(op);
    if (op.type !== 'add') current.oldCount++;
    if (op.type !== 'del') current.newCount++;
  }
  return { hunks, stats };
}

function _nextOldLine(ops, k) {
  for (let i = k; i < ops.length; i++) if (ops[i].oldLine) return ops[i].oldLine;
  return 1;
}
function _nextNewLine(ops, k) {
  for (let i = k; i < ops.length; i++) if (ops[i].newLine) return ops[i].newLine;
  return 1;
}

// ── Public: full file diff ────────────────────────────────────────────────────

/**
 * Diff two file contents.
 *
 * @param {string} filePath
 * @param {string} original  '' means the file is new
 * @param {string} modified  '' means the file is deleted
 * @returns {{
 *   file, changeType: 'create'|'delete'|'modify',
 *   stats: { added, removed },
 *   hunks: Array<{ oldStart, oldCount, newStart, newCount, lines }>,
 *   unified: string,
 *   totalOldLines, totalNewLines,
 * }}
 */
export function diffFile(filePath, original = '', modified = '', context = DEFAULT_CONTEXT) {
  const changeType = !original && modified ? 'create'
                   : original && !modified ? 'delete'
                   : 'modify';

  const oldLines = original ? original.split('\n') : [];
  const newLines = modified ? modified.split('\n') : [];

  const ops = computeLineOps(oldLines, newLines);
  const { hunks, stats } = buildHunks(ops, context);

  return {
    file: filePath,
    changeType,
    stats,
    hunks,
    unified: renderUnified(filePath, hunks, changeType),
    totalOldLines: oldLines.length,
    totalNewLines: newLines.length,
  };
}

/** Render hunks as standard unified-diff text. */
export function renderUnified(filePath, hunks, changeType = 'modify') {
  const header = changeType === 'create' ? `--- /dev/null\n+++ b/${filePath}`
               : changeType === 'delete' ? `--- a/${filePath}\n+++ /dev/null`
               : `--- a/${filePath}\n+++ b/${filePath}`;
  if (!hunks.length) return `${header}\n(no changes)`;

  const out = [header];
  for (const h of hunks) {
    out.push(`@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`);
    for (const line of h.lines) {
      const prefix = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
      out.push(prefix + line.text);
    }
  }
  return out.join('\n');
}
