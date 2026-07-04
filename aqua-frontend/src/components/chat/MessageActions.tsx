import { Check, Copy, FileDown, FileText, RefreshCw, Share2 } from 'lucide-react';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { Tooltip } from '@/components/ui/tooltip';
import { exportMarkdown, exportPdf, shareText } from '@/utils/export';
import { useUiStore } from '@/stores/uiStore';
import { cn } from '@/lib/utils';

interface Props {
  content: string;
  onRegenerate?: () => void;
  contentRef?: React.RefObject<HTMLDivElement | null>;
  className?: string;
}

export function MessageActions({ content, onRegenerate, contentRef, className }: Props) {
  const { copied, copy } = useCopyToClipboard();
  const toast = useUiStore((s) => s.toast);

  async function handleShare() {
    const result = await shareText(content);
    if (result === 'copied') toast('success', 'Copied to clipboard', 'Sharing isn\u2019t supported here, so we copied it instead.');
    else if (result === 'failed') toast('error', 'Could not share');
  }

  function handleExportPdf() {
    const html = contentRef?.current?.innerHTML ?? `<p>${content}</p>`;
    const ok = exportPdf(html, 'AQUA response');
    if (!ok) toast('error', 'Pop-up blocked', 'Allow pop-ups to export as PDF.');
  }

  const btn = 'rounded-md p-1.5 text-foreground-secondary/70 hover:bg-surface-secondary hover:text-foreground transition-colors';

  return (
    <div className={cn('flex items-center gap-0.5', className)}>
      <Tooltip label={copied ? 'Copied!' : 'Copy'}>
        <button onClick={() => copy(content)} className={btn} aria-label="Copy message">
          {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </Tooltip>
      {onRegenerate && (
        <Tooltip label="Regenerate">
          <button onClick={onRegenerate} className={btn} aria-label="Regenerate response">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
      )}
      <Tooltip label="Share">
        <button onClick={handleShare} className={btn} aria-label="Share message">
          <Share2 className="h-3.5 w-3.5" />
        </button>
      </Tooltip>
      <Tooltip label="Export Markdown">
        <button onClick={() => exportMarkdown(content)} className={btn} aria-label="Export as Markdown">
          <FileText className="h-3.5 w-3.5" />
        </button>
      </Tooltip>
      <Tooltip label="Export PDF">
        <button onClick={handleExportPdf} className={btn} aria-label="Export as PDF">
          <FileDown className="h-3.5 w-3.5" />
        </button>
      </Tooltip>
    </div>
  );
}
