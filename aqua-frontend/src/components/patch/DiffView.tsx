import { memo, useMemo, useState } from 'react';
import { PrismAsyncLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import oneDark from 'react-syntax-highlighter/dist/esm/styles/prism/one-dark';
import oneLight from 'react-syntax-highlighter/dist/esm/styles/prism/one-light';
import { ChevronsDownUp } from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import { cn } from '@/lib/utils';
import type { DiffHunk, DiffLine, PatchFileDiff } from '@/types';

/**
 * Day 4 — professional diff rendering.
 *   - unified view: old/new line-number gutters, +/- indicators, per-line
 *     add/remove tinting UNDER real syntax highlighting
 *   - unchanged stretches between hunks render as collapsed "⋯ N unchanged
 *     lines" separators
 *   - hunks come pre-computed from the backend diff engine — nothing is
 *     re-diffed client-side
 */

const LANG_BY_EXT: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', tsx: 'tsx',
  json: 'json', css: 'css', scss: 'scss', html: 'markup', ejs: 'markup',
  py: 'python', md: 'markdown', yml: 'yaml', yaml: 'yaml', sh: 'bash',
};

function langForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return LANG_BY_EXT[ext] ?? 'javascript';
}

/** One source line, syntax-highlighted, no wrapping chrome. */
const HighlightedLine = memo(function HighlightedLine({ text, language, dark }: { text: string; language: string; dark: boolean }) {
  return (
    <SyntaxHighlighter
      language={language}
      style={dark ? oneDark : oneLight}
      PreTag="span"
      CodeTag="span"
      customStyle={{ background: 'transparent', padding: 0, margin: 0, display: 'inline', whiteSpace: 'pre' }}
    >
      {text || ' '}
    </SyntaxHighlighter>
  );
});

function DiffRow({ line, language, dark }: { line: DiffLine; language: string; dark: boolean }) {
  const isAdd = line.type === 'add';
  const isDel = line.type === 'del';
  return (
    <tr
      className={cn(
        'font-mono text-[12px] leading-[1.55]',
        isAdd && 'bg-success/10',
        isDel && 'bg-danger/10',
      )}
    >
      <td className="w-10 select-none border-r border-border/50 px-1.5 text-right text-foreground-secondary/50">
        {line.oldLine ?? ''}
      </td>
      <td className="w-10 select-none border-r border-border/50 px-1.5 text-right text-foreground-secondary/50">
        {line.newLine ?? ''}
      </td>
      <td
        className={cn(
          'w-5 select-none text-center font-semibold',
          isAdd && 'text-success',
          isDel && 'text-danger',
        )}
      >
        {isAdd ? '+' : isDel ? '−' : ''}
      </td>
      <td className="whitespace-pre px-2">
        <HighlightedLine text={line.text} language={language} dark={dark} />
      </td>
    </tr>
  );
}

/** "⋯ N unchanged lines" separator between hunks. */
function GapRow({ count }: { count: number }) {
  return (
    <tr className="select-none bg-surface-secondary/50">
      <td colSpan={4} className="px-3 py-1 text-center font-mono text-[11px] text-foreground-secondary/60">
        <ChevronsDownUp className="mr-1.5 inline h-3 w-3" />
        {count} unchanged line{count === 1 ? '' : 's'}
      </td>
    </tr>
  );
}

export const DiffView = memo(function DiffView({ file }: { file: PatchFileDiff }) {
  const theme = useSettingsStore((s) => s.theme);
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  const language = useMemo(() => langForPath(file.path), [file.path]);
  const [expanded, setExpanded] = useState(false);

  // Whole-file creations can be huge — cap initial render, offer expand.
  const CREATE_PREVIEW_LINES = 40;
  const rows: React.ReactNode[] = [];
  let prevHunkEndOld = 0;

  const hunks: DiffHunk[] = file.hunks;
  hunks.forEach((hunk, hi) => {
    const gapBefore = hunk.oldStart - 1 - prevHunkEndOld;
    if (hi === 0 && gapBefore > 0) rows.push(<GapRow key={`gap-top`} count={gapBefore} />);
    if (hi > 0 && gapBefore > 0) rows.push(<GapRow key={`gap-${hi}`} count={gapBefore} />);

    let lines = hunk.lines;
    if (file.changeType === 'create' && !expanded && lines.length > CREATE_PREVIEW_LINES) {
      lines = lines.slice(0, CREATE_PREVIEW_LINES);
    }
    lines.forEach((line, li) => {
      rows.push(<DiffRow key={`${hi}-${li}`} line={line} language={language} dark={dark} />);
    });
    prevHunkEndOld = hunk.oldStart + hunk.oldCount - 1;
  });

  const tailGap = file.totalOldLines - prevHunkEndOld;
  if (tailGap > 0 && file.changeType !== 'create') rows.push(<GapRow key="gap-tail" count={tailGap} />);

  const truncatedCreate =
    file.changeType === 'create' && !expanded && (hunks[0]?.lines.length ?? 0) > CREATE_PREVIEW_LINES;

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <tbody>{rows}</tbody>
      </table>
      {truncatedCreate && (
        <button
          onClick={() => setExpanded(true)}
          className="w-full border-t border-border/50 bg-surface-secondary/50 py-1.5 text-center text-[11px] font-medium text-foreground-secondary hover:bg-surface-secondary"
        >
          Show all {file.totalNewLines} lines
        </button>
      )}
    </div>
  );
});
