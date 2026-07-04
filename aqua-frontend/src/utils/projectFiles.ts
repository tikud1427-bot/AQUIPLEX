// Mirrors aqua/src/project/fileIngester.js IGNORE_DIRS / IGNORE_EXTS / IGNORE_FILES.
// Keep in sync with the backend — this is a client-side pre-filter only,
// the server re-applies its own rules regardless.
const IGNORE_DIRS = new Set([
  'node_modules', 'vendor', 'build', 'dist', 'target', '.git',
  '__pycache__', '.next', '.nuxt', '.cache', 'coverage', '.nyc_output',
  'out', 'tmp', 'temp', 'logs', '.turbo', '.svelte-kit', '.angular',
]);

const IGNORE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.bmp',
  '.mp4', '.mp3', '.wav', '.mov', '.avi', '.pdf', '.zip', '.tar',
  '.gz', '.rar', '.7z', '.exe', '.dll', '.so', '.dylib', '.bin',
  '.pyc', '.class', '.o', '.a', '.lib', '.wasm',
  '.ttf', '.woff', '.woff2', '.eot', '.otf', '.map',
]);

const IGNORE_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
  'poetry.lock', 'Pipfile.lock', 'Cargo.lock', 'composer.lock',
]);

export function shouldIgnoreClientSide(filePath: string): boolean {
  const normalised = filePath.replace(/\\/g, '/');
  const parts = normalised.split('/');
  const basename = parts[parts.length - 1];

  if (IGNORE_FILES.has(basename)) return true;
  if (basename.endsWith('.lock')) return true;
  if (basename.endsWith('.min.js') || basename.endsWith('.min.css')) return true;

  for (const part of parts.slice(0, -1)) {
    if (IGNORE_DIRS.has(part)) return true;
    if (part.startsWith('.') && part !== '.github') return true;
  }

  const dotIdx = basename.lastIndexOf('.');
  const ext = dotIdx >= 0 ? basename.slice(dotIdx).toLowerCase() : '';
  return IGNORE_EXTS.has(ext);
}

export function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

/** Returns base64 payload only (strips the `data:...;base64,` prefix). */
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
