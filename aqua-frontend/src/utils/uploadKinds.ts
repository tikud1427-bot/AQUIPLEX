/**
 * Client-side upload classification — mirrors aqua/src/upload/uploadClassifier.js.
 * Used only for instant UI (icons, size limits, hints); the backend
 * re-classifies with magic-byte verification regardless.
 */
export type UploadKind = 'repository' | 'source' | 'document' | 'image' | 'audio' | 'video' | 'unknown';

const ARCHIVE_EXTS  = ['.zip', '.tar', '.tar.gz', '.tgz', '.gz'];
const DOCUMENT_EXTS = ['.pdf', '.docx', '.pptx', '.xlsx', '.csv', '.odt', '.epub'];
const IMAGE_EXTS    = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.heic', '.heif'];
const AUDIO_EXTS    = ['.mp3', '.wav', '.m4a'];
const VIDEO_EXTS    = ['.mp4', '.mov', '.avi'];
const SOURCE_EXTS   = [
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.java', '.kt', '.go', '.rs',
  '.cs', '.cpp', '.cc', '.c', '.h', '.hpp', '.php', '.rb', '.swift', '.md', '.mdx',
  '.txt', '.json', '.yaml', '.yml', '.toml', '.xml', '.html', '.htm', '.css', '.scss',
  '.sass', '.less', '.sql', '.graphql', '.gql', '.proto', '.sh', '.bash', '.zsh',
  '.env', '.tf', '.vue', '.svelte', '.log', '.ini', '.cfg', '.conf', '.tsv',
];

export function classifyFile(name: string): UploadKind {
  const lower = name.toLowerCase();
  const has = (exts: string[]) => exts.some((e) => lower.endsWith(e));
  if (has(ARCHIVE_EXTS))  return 'repository';
  if (has(DOCUMENT_EXTS)) return 'document';
  if (has(IMAGE_EXTS))    return 'image';
  if (has(AUDIO_EXTS))    return 'audio';
  if (has(VIDEO_EXTS))    return 'video';
  if (has(SOURCE_EXTS) || ['dockerfile', 'makefile', 'gemfile', 'procfile', 'license', 'readme'].includes(lower)) return 'source';
  return 'unknown';
}

/** Per-kind client-side size limits (backend enforces its own — these fail fast). */
export const MAX_BYTES_BY_KIND: Record<UploadKind, number> = {
  repository: 35_000_000, // base64 inflates 4/3 into the 50 MB JSON body limit
  document:   15_000_000,
  image:      12_000_000,
  audio:      14_000_000,
  video:      14_000_000,
  source:      2_000_000,
  unknown:     1,          // rejected client-side with a clear message anyway
};

export function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}
