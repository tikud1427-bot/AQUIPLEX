import { memo, useState } from 'react';
import { Globe } from 'lucide-react';
import type { SearchSource } from '@/types';
import { dedupeSources, faviconUrl, hostnameOf } from '@/lib/citations';

/**
 * Source citation cards, rendered beneath an assistant answer — the reader-
 * facing counterpart to the internal `[n]` markers stripped from the text
 * (see lib/citations.ts + MarkdownRenderer's stripCitations).
 *
 * Fed the backend's structured `search.sources`; deduplicates same-page
 * citations and renders nothing when there are no sources. Each card is a
 * single clickable link showing favicon · title · hostname, styled to sit with
 * the app's other grounding chips (WorkspaceContextChip / AttachmentChip).
 */

function SourceFavicon({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  const host = hostnameOf(url);
  if (failed) {
    return (
      <span
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] bg-primary/15 text-[9px] font-semibold uppercase text-primary"
        aria-hidden="true"
      >
        {host.charAt(0) || '?'}
      </span>
    );
  }
  return (
    <img
      src={faviconUrl(url)}
      alt=""
      width={16}
      height={16}
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-4 w-4 shrink-0 rounded-[3px] object-contain"
    />
  );
}

function SourceCard({ source, index }: { source: SearchSource; index: number }) {
  const host = hostnameOf(source.url);
  const title = source.title?.trim() || host;
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noopener noreferrer"
      title={`${title} — ${source.url}`}
      className="tap group flex w-[190px] shrink-0 flex-col gap-1.5 rounded-xl border border-border/70 bg-surface-secondary/60 px-3 py-2.5 transition-colors hover:border-border hover:bg-surface-secondary"
    >
      <div className="flex items-center gap-1.5 text-[11px] text-foreground-secondary">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-surface text-[9px] font-semibold text-foreground-secondary/80">
          {index}
        </span>
        <SourceFavicon url={source.url} />
        <span className="truncate">{host}</span>
      </div>
      <span className="line-clamp-2 text-[12.5px] font-medium leading-snug text-foreground group-hover:text-primary">
        {title}
      </span>
    </a>
  );
}

export const SourceCards = memo(function SourceCards({ sources }: { sources?: SearchSource[] }) {
  const unique = dedupeSources(sources);
  if (unique.length === 0) return null;

  return (
    <section className="mt-3" aria-label="Sources">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-foreground-secondary/70">
        <Globe className="h-3 w-3" />
        Sources
        <span className="text-foreground-secondary/50">· {unique.length}</span>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:flex-wrap sm:overflow-visible">
        {unique.map((source, i) => (
          <SourceCard key={`${source.url}-${i}`} source={source} index={i + 1} />
        ))}
      </div>
    </section>
  );
});