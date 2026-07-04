export function exportMarkdown(content: string, filenameBase = 'aqua-message') {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filenameBase}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * No PDF-generation library is pulled in for this — the browser's own
 * print pipeline already renders headings/code/tables correctly and lets
 * the user pick "Save as PDF" with zero added bundle weight or the layout
 * drift that html2canvas-style rasterization tends to introduce.
 */
export function exportPdf(html: string, title = 'AQUA') {
  const win = window.open('', '_blank', 'width=800,height=1000');
  if (!win) return false;

  win.document.write(`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>
  body { font-family: -apple-system, Inter, system-ui, sans-serif; color: #0f172a; max-width: 720px; margin: 40px auto; padding: 0 24px; line-height: 1.6; }
  pre { background: #f1f5f9; padding: 12px 14px; border-radius: 8px; overflow-x: auto; font-size: 13px; }
  code { font-family: 'JetBrains Mono', ui-monospace, monospace; }
  :not(pre) > code { background: #f1f5f9; padding: 1px 5px; border-radius: 4px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #e2e8f0; padding: 6px 10px; text-align: left; }
  blockquote { border-left: 3px solid #94a3b8; margin: 0; padding-left: 12px; color: #475569; }
  @media print { body { margin: 0; } }
</style>
</head>
<body>${html}</body>
</html>`);
  win.document.close();
  win.focus();
  // Give the new document a tick to paint before invoking print.
  setTimeout(() => win.print(), 300);
  return true;
}

export async function shareText(text: string): Promise<'shared' | 'copied' | 'failed'> {
  if (navigator.share) {
    try {
      await navigator.share({ text });
      return 'shared';
    } catch {
      // user cancelled the native share sheet — not an error worth surfacing
      return 'failed';
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'failed';
  }
}
