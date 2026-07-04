/**
 * AQUA File Ingester
 *
 * Handles ZIP archives and raw file arrays.
 * Filters ignored directories (node_modules, .git, dist, etc.).
 * Detects language per file and project type from manifest files.
 */
import path from 'path';
import { isDocumentExt, parseDocument } from './documentParser.js';

// ── Constants ─────────────────────────────────────────────────────────────────

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
  '.ttf', '.woff', '.woff2', '.eot', '.otf',
  '.map', '.min.js', // source maps + minified bundles
  // .docx/.pptx/.xlsx deliberately not added here (never were) — same
  // reasoning as .pdf, see the base64-document check in ingestFiles():
  // ignore rules apply normally UNLESS the file is explicitly tagged
  // encoding: 'base64', which no existing caller sends today, so this
  // whole list still behaves exactly as it did before this change.
]);

const DOCUMENT_LANG = { '.pdf': 'pdf', '.docx': 'docx', '.pptx': 'pptx', '.xlsx': 'xlsx' };

const IGNORE_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
  'poetry.lock', 'Pipfile.lock', 'Cargo.lock', 'composer.lock',
]);

const MAX_FILE_SIZE = 100_000; // 100 KB per file

const LANG_MAP = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript', '.jsx': 'javascript',
  '.py': 'python',   '.pyw': 'python',
  '.java': 'java',   '.kt': 'kotlin',
  '.go': 'go',
  '.rs': 'rust',
  '.cs': 'csharp',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp',
  '.c': 'c',     '.h': 'cpp', '.hpp': 'cpp',
  '.php': 'php',
  '.rb': 'ruby',
  '.swift': 'swift',
  '.md': 'markdown', '.mdx': 'markdown',
  '.json': 'json',
  '.yaml': 'yaml', '.yml': 'yaml',
  '.toml': 'toml',
  '.env': 'env',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
  '.html': 'html', '.htm': 'html',
  '.css': 'css', '.scss': 'css', '.sass': 'css', '.less': 'css',
  '.sql': 'sql',
  '.graphql': 'graphql', '.gql': 'graphql',
  '.proto': 'protobuf',
  '.xml': 'xml',
  '.tf': 'terraform',
  '.vue': 'vue',
  '.svelte': 'svelte',
};

// ── Language / project detection ──────────────────────────────────────────────

export function detectLanguage(filePath) {
  const base = path.basename(filePath).toLowerCase();
  if (base === 'dockerfile')     return 'dockerfile';
  if (base === 'makefile')       return 'makefile';
  if (base === 'gemfile')        return 'ruby';
  if (base === 'procfile')       return 'shell';
  if (base.startsWith('.env'))   return 'env';
  const ext = path.extname(filePath).toLowerCase();
  return LANG_MAP[ext] ?? 'unknown';
}

export function shouldIgnore(filePath) {
  const normalised = filePath.replace(/\\/g, '/');
  const parts = normalised.split('/');
  const basename = parts[parts.length - 1];

  if (IGNORE_FILES.has(basename)) return true;
  if (basename.endsWith('.lock')) return true;

  // Ignore hidden directories (except .env files)
  for (const part of parts.slice(0, -1)) {
    if (IGNORE_DIRS.has(part)) return true;
    if (part.startsWith('.') && part !== '.github') return true;
  }

  const ext = path.extname(filePath).toLowerCase();
  if (IGNORE_EXTS.has(ext)) return true;
  // Skip minified JS
  if (basename.endsWith('.min.js') || basename.endsWith('.min.css')) return true;

  return false;
}

export function detectProjectType(files) {
  const byName = new Map(files.map(f => [path.basename(f.path).toLowerCase(), f]));
  const paths  = files.map(f => f.path.toLowerCase());

  if (byName.has('package.json')) {
    const pkgFile = byName.get('package.json');
    try {
      const pkg = JSON.parse(pkgFile.content);
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.next)    return 'nodejs-next';
      if (deps.react)   return 'nodejs-react';
      if (deps.express || deps.fastify || deps.koa) return 'nodejs-express';
      if (deps.vue)     return 'nodejs-vue';
    } catch { /* malformed JSON */ }
    return 'nodejs';
  }
  if (byName.has('requirements.txt') || byName.has('pyproject.toml') || byName.has('setup.py')) return 'python';
  if (byName.has('go.mod'))            return 'go';
  if (byName.has('cargo.toml'))        return 'rust';
  if (byName.has('pom.xml') || byName.has('build.gradle')) return 'java';
  if (byName.has('composer.json'))     return 'php';
  if (byName.has('gemfile'))           return 'ruby';
  if (paths.some(p => p.endsWith('.csproj') || p.endsWith('.sln'))) return 'csharp';
  if (paths.some(p => p.endsWith('.cpp') || p.endsWith('.cc')))     return 'cpp';

  return 'unknown';
}

// ── Core ingestion ────────────────────────────────────────────────────────────

/**
 * Ingest an array of { path, content } objects.
 * Applies ignore rules, size limits, and binary detection.
 *
 * content is normally UTF-8 text. For PDF/DOCX/PPTX/XLSX, callers send
 * base64-encoded raw bytes instead, tagged with encoding: 'base64' (see
 * extractZip() below, and routes/project.js's upload contract) — those
 * are routed to real extraction instead of the text-file path, which
 * would otherwise mangle or (via isBinary()) silently drop them.
 *
 * @param {Array<{path: string, content: string, encoding?: 'base64'}>} rawFiles
 * @returns {Promise<Array<{path, content, lang, size, truncated, documentMeta?}>>}
 */
export async function ingestFiles(rawFiles) {
  const results = [];

  for (const file of rawFiles) {
    if (!file?.path || !file?.content) continue;

    const ext = path.extname(file.path).toLowerCase();
    const isBase64Document = file.encoding === 'base64' && isDocumentExt(ext);

    // Ignore rules apply normally UNLESS this is an explicitly base64-tagged
    // document — that's the opt-in signal (see file header comment). A
    // .pdf/.docx/.pptx/.xlsx sent the old way (no encoding field, which is
    // every existing caller today) still hits shouldIgnore() exactly as
    // before and gets dropped — zero behavior change for anyone not using
    // the new contract.
    if (!isBase64Document && shouldIgnore(file.path)) continue;

    if (isBase64Document) {
      const entry = await ingestDocumentFile(file, ext);
      if (entry) results.push(entry);
      continue;
    }

    if (isBinary(file.content)) continue;

    const lang = detectLanguage(file.path);
    let content = file.content;
    let truncated = false;

    if (content.length > MAX_FILE_SIZE) {
      content = content.slice(0, MAX_FILE_SIZE) + '\n// ... [truncated]';
      truncated = true;
    }

    results.push({ path: file.path, content, lang, size: file.content.length, truncated });
  }

  console.log(`[Index] Ingested ${results.length} files from ${rawFiles.length} total`);
  return results;
}

/**
 * Decode + extract one base64-tagged document file. Fails open at the
 * per-file level: any problem (bad base64, corrupt/password-protected
 * document, unsupported internal structure, oversize) skips just this
 * file with a logged reason — never throws out of ingestFiles(), so one
 * bad document can't fail an entire batch upload.
 *
 * @param {{path: string, content: string}} file - content is base64
 * @param {string} ext
 * @returns {Promise<{path, content, lang, size, truncated, documentMeta}|null>}
 */
async function ingestDocumentFile(file, ext) {
  let buffer;
  try {
    buffer = Buffer.from(file.content, 'base64');
  } catch {
    console.warn(`[Index] Skipped ${file.path}: invalid base64`);
    return null;
  }

  let extracted;
  try {
    extracted = await parseDocument(ext, buffer);
  } catch (err) {
    console.warn(`[Index] Skipped ${file.path}: ${err.message}`);
    return null;
  }

  if (!extracted?.text) {
    console.warn(`[Index] Skipped ${file.path}: no extractable text`);
    return null;
  }

  let content = extracted.text;
  let truncated = false;
  if (content.length > MAX_FILE_SIZE) {
    content = content.slice(0, MAX_FILE_SIZE) + '\n... [truncated]';
    truncated = true;
  }

  return {
    path: file.path,
    content,
    lang: DOCUMENT_LANG[ext],
    size: content.length,
    truncated,
    documentMeta: extracted.meta,
  };
}

/**
 * Extract files from a base64-encoded ZIP buffer.
 *
 * @param {string} base64
 * @returns {Promise<Array<{path: string, content: string}>>}
 */
// Archive safety caps (demo stability): a hostile or simply enormous ZIP
// previously decompressed every entry into memory with no limits — a
// classic zip-bomb / memory-spike path that could OOM the process live.
const ZIP_MAX_ENTRIES        = 10_000;        // more than any sane repo after ignore rules
const ZIP_MAX_ENTRY_BYTES    = 20_000_000;    // 20 MB uncompressed per entry (documents cap at 15 MB anyway)
const ZIP_MAX_TOTAL_BYTES    = 300_000_000;   // 300 MB total uncompressed budget

export async function extractZip(base64) {
  try {
    const { default: AdmZip } = await import('adm-zip');
    const buffer = Buffer.from(base64, 'base64');
    const zip    = new AdmZip(buffer);
    const files  = [];

    const entries = zip.getEntries();
    if (entries.length > ZIP_MAX_ENTRIES) {
      throw new Error(`Archive has ${entries.length} entries (limit ${ZIP_MAX_ENTRIES}). Remove build artifacts (node_modules, dist) before zipping.`);
    }

    let totalBytes = 0;
    let skippedOversize = 0;

    for (const entry of entries) {
      if (entry.isDirectory) continue;

      // Check the DECLARED uncompressed size BEFORE decompressing — never
      // pay the memory cost for an entry we'd drop anyway.
      const declaredSize = entry.header?.size ?? 0;
      if (declaredSize > ZIP_MAX_ENTRY_BYTES) {
        skippedOversize++;
        continue;
      }
      totalBytes += declaredSize;
      if (totalBytes > ZIP_MAX_TOTAL_BYTES) {
        throw new Error('Archive expands beyond the 300 MB extraction budget — likely includes dependencies or binaries. Trim it and retry.');
      }

      const ext = path.extname(entry.entryName).toLowerCase();
      // Cheap pre-filter: never decompress entries the ingester would
      // discard anyway (node_modules, images, lockfiles, ...). Documents
      // are exempt exactly like ingestFiles()'s base64 path.
      if (!isDocumentExt(ext) && shouldIgnore(entry.entryName)) continue;
      if (isDocumentExt(ext)) {
        // Binary format — carry raw bytes through as base64. toString('utf8')
        // below would corrupt them, and ingestFiles()'s isBinary() check
        // would then silently drop the corrupted result anyway.
        files.push({ path: entry.entryName, content: entry.getData().toString('base64'), encoding: 'base64' });
        continue;
      }

      try {
        const content = entry.getData().toString('utf8');
        files.push({ path: entry.entryName, content });
      } catch {
        // Binary or encoding error — skip silently
      }
    }

    if (skippedOversize) console.warn(`[Index] Skipped ${skippedOversize} oversize ZIP entries (> ${ZIP_MAX_ENTRY_BYTES / 1e6} MB each)`);
    console.log(`[Index] Extracted ${files.length} entries from ZIP`);
    return files;
  } catch (err) {
    console.error('[PROJECT] ZIP extraction failed:', err.message);
    throw new Error('Failed to extract ZIP: ' + err.message);
  }
}

/**
 * Build a nested directory structure object from file paths.
 */
export function buildStructure(files) {
  const root = {};
  for (const file of files) {
    const parts = file.path.replace(/\\/g, '/').split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node[parts[i]]) node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = { _file: true, lang: file.lang, size: file.size };
  }
  return root;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isBinary(content) {
  const sample = content.slice(0, 512);
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code < 9 || (code > 13 && code < 32 && code !== 27)) nonPrintable++;
  }
  return nonPrintable / Math.max(sample.length, 1) > 0.1;
}
