import { useState, useEffect, memo } from 'react';
import { PrismAsyncLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import oneDark from 'react-syntax-highlighter/dist/esm/styles/prism/one-dark';
import oneLight from 'react-syntax-highlighter/dist/esm/styles/prism/one-light';
import { Check, ChevronsUpDown, Copy, Download, WrapText } from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface CodeBlockProps {
  language: string;
  code: string;
}

/** Blocks taller than this auto-collapse with an expand affordance —
 *  keeps a wall of generated code from swallowing the conversation. */
const COLLAPSE_AFTER_LINES = 28;
const COLLAPSED_MAX_HEIGHT = '26rem';

const EXT_BY_LANG: Record<string, string> = {
  javascript: 'js', typescript: 'ts', jsx: 'jsx', tsx: 'tsx', python: 'py', bash: 'sh',
  shell: 'sh', json: 'json', html: 'html', css: 'css', markdown: 'md', yaml: 'yml',
  sql: 'sql', go: 'go', rust: 'rs', java: 'java', c: 'c', cpp: 'cpp', ruby: 'rb', php: 'php',
  diff: 'diff', patch: 'diff', kotlin: 'kt', swift: 'swift', dockerfile: 'Dockerfile',
};

/** Language aliases the model commonly emits, normalized to Prism grammar ids. */
const LANG_ALIASES: Record<string, string> = {
  js: 'javascript', ts: 'typescript', py: 'python', sh: 'bash', zsh: 'bash',
  shell: 'bash', console: 'bash', terminal: 'bash', shellsession: 'bash',
  yml: 'yaml', patch: 'diff', docker: 'dockerfile', 'c++': 'cpp', golang: 'go',
  md: 'markdown', htm: 'html',
};

// Each loader is its own chunk, fetched only the first time that language is
// actually rendered — this is what keeps the main bundle from carrying every
// Prism grammar up front the way the synchronous `Prism` build does.
const LANGUAGE_LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  javascript: () => import('react-syntax-highlighter/dist/esm/languages/prism/javascript'),
  jsx: () => import('react-syntax-highlighter/dist/esm/languages/prism/jsx'),
  typescript: () => import('react-syntax-highlighter/dist/esm/languages/prism/typescript'),
  tsx: () => import('react-syntax-highlighter/dist/esm/languages/prism/tsx'),
  python: () => import('react-syntax-highlighter/dist/esm/languages/prism/python'),
  bash: () => import('react-syntax-highlighter/dist/esm/languages/prism/bash'),
  shell: () => import('react-syntax-highlighter/dist/esm/languages/prism/bash'),
  json: () => import('react-syntax-highlighter/dist/esm/languages/prism/json'),
  css: () => import('react-syntax-highlighter/dist/esm/languages/prism/css'),
  html: () => import('react-syntax-highlighter/dist/esm/languages/prism/markup'),
  xml: () => import('react-syntax-highlighter/dist/esm/languages/prism/markup'),
  sql: () => import('react-syntax-highlighter/dist/esm/languages/prism/sql'),
  yaml: () => import('react-syntax-highlighter/dist/esm/languages/prism/yaml'),
  markdown: () => import('react-syntax-highlighter/dist/esm/languages/prism/markdown'),
  go: () => import('react-syntax-highlighter/dist/esm/languages/prism/go'),
  rust: () => import('react-syntax-highlighter/dist/esm/languages/prism/rust'),
  java: () => import('react-syntax-highlighter/dist/esm/languages/prism/java'),
  c: () => import('react-syntax-highlighter/dist/esm/languages/prism/c'),
  cpp: () => import('react-syntax-highlighter/dist/esm/languages/prism/cpp'),
  ruby: () => import('react-syntax-highlighter/dist/esm/languages/prism/ruby'),
  php: () => import('react-syntax-highlighter/dist/esm/languages/prism/php'),
  diff: () => import('react-syntax-highlighter/dist/esm/languages/prism/diff'),
  kotlin: () => import('react-syntax-highlighter/dist/esm/languages/prism/kotlin'),
  swift: () => import('react-syntax-highlighter/dist/esm/languages/prism/swift'),
  dockerfile: () => import('react-syntax-highlighter/dist/esm/languages/prism/docker'),
};

const registeredLanguages = new Set<string>();

/** Idempotent — safe to call every render; only fetches/registers once per language. */
async function ensureLanguageRegistered(lang: string): Promise<void> {
  if (registeredLanguages.has(lang) || !LANGUAGE_LOADERS[lang]) return;
  const mod = await LANGUAGE_LOADERS[lang]();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (SyntaxHighlighter as any).registerLanguage(lang, mod.default);
  registeredLanguages.add(lang);
}

function download(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export const CodeBlock = memo(function CodeBlock({ language, code }: CodeBlockProps) {
  const [wrap, setWrap] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [, forceRerender] = useState(0);
  const { copied, copy } = useCopyToClipboard();
  // System theme resolves via the html.dark class at runtime; reading the
  // store here keeps the highlighter palette in sync with explicit choices.
  const theme = useSettingsStore((s) => s.theme);
  const isDark =
    theme === 'dark' ||
    (theme === 'system' &&
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);

  const rawLang = (language || 'text').toLowerCase();
  const lang = LANG_ALIASES[rawLang] ?? rawLang;
  const ext = EXT_BY_LANG[lang] ?? 'txt';

  const lineCount = code.split('\n').length;
  const collapsible = lineCount > COLLAPSE_AFTER_LINES;
  const collapsed = collapsible && !expanded;

  useEffect(() => {
    let cancelled = false;
    ensureLanguageRegistered(lang).then(() => {
      if (!cancelled) forceRerender((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [lang]);

  return (
    <div className="group/code my-3 overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border bg-surface-secondary px-3 py-1.5">
        <span className="font-mono text-[11px] font-medium text-foreground-secondary">
          {lang}
          {collapsible && (
            <span className="ml-2 text-foreground-secondary/60">{lineCount} lines</span>
          )}
        </span>
        <div className="flex items-center gap-0.5 opacity-70 transition-opacity group-hover/code:opacity-100">
          {collapsible && (
            <Tooltip label={collapsed ? 'Expand' : 'Collapse'}>
              <button
                onClick={() => setExpanded((e) => !e)}
                className="rounded p-1.5 text-foreground-secondary hover:bg-surface hover:text-foreground"
                aria-label={collapsed ? 'Expand code' : 'Collapse code'}
                aria-expanded={!collapsed}
              >
                <ChevronsUpDown className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          )}
          <Tooltip label={wrap ? 'Disable wrap' : 'Wrap lines'}>
            <button
              onClick={() => setWrap((w) => !w)}
              className={cn(
                'rounded p-1.5 text-foreground-secondary hover:bg-surface hover:text-foreground',
                wrap && 'bg-surface text-primary',
              )}
              aria-label="Toggle line wrap"
            >
              <WrapText className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip label="Download">
            <button
              onClick={() => download(`snippet.${ext}`, code)}
              className="rounded p-1.5 text-foreground-secondary hover:bg-surface hover:text-foreground"
              aria-label="Download code"
            >
              <Download className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip label={copied ? 'Copied!' : 'Copy'}>
            <button
              onClick={() => copy(code)}
              className="rounded p-1.5 text-foreground-secondary hover:bg-surface hover:text-foreground"
              aria-label="Copy code"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          </Tooltip>
        </div>
      </div>

      <div
        className="relative"
        style={collapsed ? { maxHeight: COLLAPSED_MAX_HEIGHT, overflow: 'hidden' } : undefined}
      >
        <SyntaxHighlighter
          language={lang}
          style={isDark ? oneDark : oneLight}
          showLineNumbers={lineCount > 5}
          wrapLongLines={wrap}
          customStyle={{
            margin: 0,
            padding: '0.875rem 1rem',
            background: 'transparent',
            fontSize: '13px',
            lineHeight: 1.6,
            overflowX: wrap ? 'hidden' : 'auto', // pan long lines on phones instead of overflowing the bubble
            WebkitOverflowScrolling: 'touch',
          }}
          codeTagProps={{ style: { fontFamily: 'var(--font-mono)' } }}
          lineNumberStyle={{ opacity: 0.35, minWidth: '2em' }}
        >
          {code.replace(/\n$/, '')}
        </SyntaxHighlighter>

        {collapsed && (
          <div className="absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-surface via-surface/85 to-transparent pb-2 pt-10">
            <button
              onClick={() => setExpanded(true)}
              className="rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-foreground shadow-sm transition-transform hover:scale-[1.03]"
            >
              Show all {lineCount} lines
            </button>
          </div>
        )}
      </div>
    </div>
  );
});
