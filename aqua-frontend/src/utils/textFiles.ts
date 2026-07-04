/**
 * The composer's "attach" affordance inlines small text files directly into
 * the outgoing /chat message (no backend endpoint needed for this — it's
 * just string content). This is intentionally text/source-only: AQUA's
 * project ingester (aqua/src/project/fileIngester.js) explicitly drops
 * images, PDFs, and other binaries via IGNORE_EXTS + a binary-content
 * sniff, so offering to "attach" them here would silently go nowhere.
 * Bulk source-code ingestion for real project context lives in Project
 * Upload instead, which mirrors the backend's actual capability (zip /
 * multi-file → workspace → indexed).
 */
export const ACCEPTED_TEXT_EXTENSIONS = [
  '.txt', '.md', '.mdx', '.json', '.csv', '.tsv', '.yaml', '.yml', '.toml', '.env',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.java', '.kt', '.go', '.rs',
  '.cs', '.cpp', '.cc', '.c', '.h', '.hpp', '.php', '.rb', '.swift', '.sh', '.bash',
  '.html', '.css', '.scss', '.sql', '.graphql', '.xml', '.vue', '.svelte', '.log',
];

export const MAX_ATTACHMENT_BYTES = 100_000; // mirrors backend MAX_FILE_SIZE in fileIngester.js

export function isAcceptedTextFile(file: File): boolean {
  const lower = file.name.toLowerCase();
  return ACCEPTED_TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

/** Folds attachments into the outgoing message as labeled fenced blocks. */
export function buildMessageWithAttachments(
  text: string,
  attachments: Array<{ name: string; content: string }>,
): string {
  if (attachments.length === 0) return text;
  const blocks = attachments
    .map((a) => `\`${a.name}\`:\n\`\`\`\n${a.content}\n\`\`\``)
    .join('\n\n');
  return text.trim() ? `${text}\n\n${blocks}` : blocks;
}
