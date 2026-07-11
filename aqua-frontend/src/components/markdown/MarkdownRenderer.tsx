import { memo, useMemo, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './CodeBlock';
<<<<<<< HEAD
=======
import { stripCitationMarkers } from '@/lib/citations';
>>>>>>> 7306efb7 (update)

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

  table({ children }) {
    return (
      <div className="my-3 overflow-x-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    );
  },
  thead({ children }) {
    return <thead className="bg-surface-secondary">{children}</thead>;
  },
  th({ children }) {
    return <th className="border-b border-border px-3 py-2 text-left font-semibold text-foreground">{children}</th>;
  },
  td({ children }) {
    return <td className="border-b border-border/60 px-3 py-2 align-top text-foreground-secondary last:border-b-0">{children}</td>;
  },

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

  h1: ({ children }) => <h1 className="mb-3 mt-5 text-xl font-semibold text-foreground first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2.5 mt-5 text-lg font-semibold text-foreground first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-2 mt-4 text-base font-semibold text-foreground first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="mb-1.5 mt-3 text-sm font-semibold text-foreground first:mt-0">{children}</h4>,

  p: ({ children }) => <p className="leading-relaxed [&:not(:first-child)]:mt-2.5">{children}</p>,
  hr: () => <hr className="my-4 border-border" />,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
};

/**
 * Split markdown into stable top-level blocks (blank-line separated, fenced
 * code kept intact). During streaming, appended tokens only ever change the
 * LAST block — memoizing each block means everything above it skips
 * react-markdown's parse + render entirely on every frame. This is what
 * keeps long streaming answers smooth: parse cost stays O(tail block), not
 * O(entire message) per animation frame.
 */
function splitMarkdownBlocks(content: string): string[] {
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

  for (const line of lines) {
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

const MarkdownBlock = memo(function MarkdownBlock({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {content}
    </ReactMarkdown>
  );
});

export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  streaming = false,
<<<<<<< HEAD
=======
  stripCitations = false,
>>>>>>> 7306efb7 (update)
}: {
  content: string;
  /** Appends the blinking cursor after the last rendered block. */
  streaming?: boolean;
<<<<<<< HEAD
}) {
  const blocks = useMemo(() => splitMarkdownBlocks(content), [content]);
=======
  /** Remove internal web-search citation markers (`[n]`, `[n†…]`) from prose.
   *  Code spans and markdown links are left intact. Enable for assistant turns
   *  that may carry search grounding. */
  stripCitations?: boolean;
}) {
  const prepared = useMemo(
    () => (stripCitations ? stripCitationMarkers(content, { streaming }) : content),
    [content, stripCitations, streaming],
  );
  const blocks = useMemo(() => splitMarkdownBlocks(prepared), [prepared]);
>>>>>>> 7306efb7 (update)

  return (
    <div className="text-[15px] text-foreground [overflow-wrap:anywhere]">
      {blocks.map((block, i) => (
        // Index keys are correct here: blocks only ever append/extend at the
        // tail during streaming, so indices are stable for finished blocks.
        <MarkdownBlock key={i} content={block} />
      ))}
      {streaming && <span className="streaming-cursor" aria-hidden="true" />}
    </div>
  );
});
