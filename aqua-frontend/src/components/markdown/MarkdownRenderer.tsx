import type React from 'react';
import { memo, useMemo, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { CodeBlock } from './CodeBlock';
import { MarkdownTable, MarkdownTd, MarkdownTh, MarkdownTr } from './MarkdownTable';
import { stripCitationMarkers } from '@/lib/citations';
import { normalizeMath, splitMarkdownBlocks } from '@/lib/markdown';

interface CodeChildProps {
  className?: string;
  children?: ReactNode;
}

/**
 * react-markdown v9 no longer passes an `inline` flag to the `code`
 * renderer, so the reliable way to tell a fenced block from inline code is
 * structural: fenced blocks are always `<pre><code>`, inline code never has
 * a `<pre>` parent. We override `pre` and read the wrapped `<code>` element
 * directly, which also lets us skip react-markdown's own `code` render pass
 * for blocks entirely and hand off straight to the syntax highlighter.
 */
const components: Components = {
  pre({ children }) {
    const codeEl = children as ReactElement<CodeChildProps> | undefined;
    const className = codeEl?.props?.className ?? '';
    const match = /language-(\w+)/.exec(className);
    const raw = codeEl?.props?.children;
    const code = Array.isArray(raw) ? raw.join('') : String(raw ?? '');
    return <CodeBlock language={match?.[1] ?? 'text'} code={code.replace(/\n$/, '')} />;
  },

  code({ className, children, ...props }) {
    return (
      <code
        className={
          'rounded bg-surface-secondary px-1.5 py-0.5 font-mono text-[0.85em] text-foreground before:content-none after:content-none ' +
          (className ?? '')
        }
        {...props}
      >
        {children}
      </code>
    );
  },

  a({ children, ...props }) {
    return (
      <a {...props} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2 hover:opacity-80">
        {children}
      </a>
    );
  },

  img({ alt, ...props }) {
    return <img {...props} alt={alt ?? ''} loading="lazy" className="my-2 max-w-full rounded-lg border border-border" />;
  },

  // Tables are the one construct whose PRESENTATION has to change with the
  // width it is given, so they own a module. `thead`/`tbody` are deliberately
  // NOT overridden: leaving them as intrinsic elements is what lets
  // analyzeTable tell a header row from a body row. Styling lives in
  // `.md-table` in globals.css.
  table: MarkdownTable,
  tr: MarkdownTr,
  th: MarkdownTh,
  td: MarkdownTd,

  blockquote({ children }) {
    return <blockquote className="my-2 border-l-2 border-primary/40 pl-3 text-foreground-secondary italic">{children}</blockquote>;
  },

  ul({ children, className }) {
    const isTaskList = className?.includes('contains-task-list');
    return <ul className={isTaskList ? 'my-2 space-y-1 pl-1' : 'my-2 list-disc space-y-1 pl-5'}>{children}</ul>;
  },
  ol({ children }) {
    return <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>;
  },
  li({ children, className }) {
    if (className?.includes('task-list-item')) {
      return <li className="flex list-none items-start gap-2 [&>input]:mt-1 [&>input]:accent-primary">{children}</li>;
    }
    return <li className="leading-relaxed">{children}</li>;
  },

  // Levels are shifted down one. The page's <h1> is the conversation title in
  // Header.tsx; a message that opens with `# Quick-Fix` is a section of that
  // page, not a second document. Visual scale is unchanged — only the tag is.
  h1: ({ children }) => <h2 className="mb-3 mt-5 text-xl font-semibold text-foreground first:mt-0">{children}</h2>,
  h2: ({ children }) => <h3 className="mb-2.5 mt-5 text-lg font-semibold text-foreground first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="mb-2 mt-4 text-base font-semibold text-foreground first:mt-0">{children}</h4>,
  h4: ({ children }) => <h5 className="mb-1.5 mt-3 text-sm font-semibold text-foreground first:mt-0">{children}</h5>,
  h5: ({ children }) => <h6 className="mb-1.5 mt-3 text-sm font-semibold text-foreground first:mt-0">{children}</h6>,

  p: ({ children }) => <p className="leading-relaxed [&:not(:first-child)]:mt-2.5">{children}</p>,
  hr: () => <hr className="my-4 border-border" />,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
};

// Single-dollar parsing is OFF: "$5 and $10" must stay prose. normalizeMath()
// rewrites `\(…\)`, `\[…\]` and unambiguous `$…$` to the `$$` form first.
// throwOnError:false → a malformed formula renders as red source, never as a
// crashed message.
const remarkPlugins = [remarkGfm, [remarkMath, { singleDollarTextMath: false }]] as NonNullable<
  React.ComponentProps<typeof ReactMarkdown>['remarkPlugins']
>;
const rehypePlugins = [[rehypeKatex, { throwOnError: false, strict: 'ignore' }]] as NonNullable<
  React.ComponentProps<typeof ReactMarkdown>['rehypePlugins']
>;

const MarkdownBlock = memo(function MarkdownBlock({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
      {content}
    </ReactMarkdown>
  );
});

export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  streaming = false,
  stripCitations = false,
}: {
  content: string;
  /** Appends the blinking cursor after the last rendered block. */
  streaming?: boolean;
  /** Remove internal web-search citation markers (`[n]`, `[n†…]`) from prose.
   *  Code spans and markdown links are left intact. Enable for assistant turns
   *  that may carry search grounding. */
  stripCitations?: boolean;
}) {
  const prepared = useMemo(
    () => normalizeMath(stripCitations ? stripCitationMarkers(content, { streaming }) : content, { streaming }),
    [content, stripCitations, streaming],
  );
  const blocks = useMemo(() => splitMarkdownBlocks(prepared), [prepared]);

  return (
    // `.md-prose` wraps with `overflow-wrap: break-word`. It used to be
    // `anywhere`, which shrinks min-content intrinsic size and therefore
    // collapsed every table column to a single character — see the header
    // comment in MarkdownTable.tsx. `anywhere` is now scoped to links and
    // inline code, the only things that should break mid-token.
    <div className="md-prose text-lead text-foreground">
      {blocks.map((block, i) => (
        // Index keys are correct here: blocks only ever append/extend at the
        // tail during streaming, so indices are stable for finished blocks.
        <MarkdownBlock key={i} content={block} />
      ))}
      {streaming && <span className="streaming-cursor" aria-hidden="true" />}
    </div>
  );
});
