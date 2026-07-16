/**
 * AQUA Artifact Engine — Code Project Exporter (P3)
 * ─────────────────────────────────────────────────────────────────────────────
 * The 'project' format — multi-file runnable code trees ("build me an
 * Airbnb clone", "generate a SaaS boilerplate", "create a node backend").
 * The LAST detector target to go live: registering this flips every
 * project-intent rule with zero detector/engine/route changes.
 *
 * Content path is the P1 text pipeline at project scale: the planner emits
 * the file tree (each file with a precise description), builder generates
 * every file through helpers.generateFile (pool of 3), and this module owns
 * per-extension mime typing + language-aware prompt guidance. Downloads
 * always travel as an archive (zip default; tar/tar.gz when asked).
 */
import path from 'path';
import { registerExporter } from './registry.js';
import { TEXT_FORMATS }     from './textExporter.js';

const GUIDANCE = 'A complete, runnable multi-file project. Every file must be consistent with every other file: imports resolve, the package manifest lists what the code uses, the README matches reality.';

// ── Extension → mime + per-language guidance ──────────────────────────────────
// Seeded from the P1 text-format table (single source for shared exts),
// extended with project-only file types.

const EXT_META = (() => {
  const m = new Map();
  for (const fmt of Object.values(TEXT_FORMATS)) {
    const hint = fmt.guidance;
    for (const ext of [fmt.ext, ...(fmt.aliases ?? [])]) {
      if (ext) m.set(ext, { mime: fmt.mime, hint });
    }
  }
  const extra = {
    '.jsx':        { mime: 'text/javascript', hint: 'Valid React JSX. No surrounding prose.' },
    '.tsx':        { mime: 'text/typescript', hint: 'Valid React TSX with explicit prop types.' },
    '.vue':        { mime: 'text/plain',      hint: 'A valid Vue single-file component (<template>/<script>/<style>).' },
    '.env.example':{ mime: 'text/plain',      hint: 'KEY=example_value lines with a comment per key. NEVER real secrets.' },
    '.gitignore':  { mime: 'text/plain',      hint: 'One ignore pattern per line, grouped with comments.' },
    '.toml':       { mime: 'text/plain',      hint: 'Valid TOML.' },
    '.ini':        { mime: 'text/plain',      hint: 'Valid INI.' },
    '.cfg':        { mime: 'text/plain',      hint: 'Valid config file for its tool.' },
    '.go':         { mime: 'text/plain',      hint: 'Valid Go — gofmt style, package line first.' },
    '.rs':         { mime: 'text/plain',      hint: 'Valid Rust — rustfmt style.' },
    '.java':       { mime: 'text/plain',      hint: 'Valid Java — one public class matching the filename.' },
    '.kt':         { mime: 'text/plain',      hint: 'Valid Kotlin.' },
    '.rb':         { mime: 'text/plain',      hint: 'Valid Ruby.' },
    '.php':        { mime: 'text/plain',      hint: 'Valid PHP starting with <?php.' },
    '.prisma':     { mime: 'text/plain',      hint: 'A valid Prisma schema (datasource, generator, models).' },
    '.graphql':    { mime: 'text/plain',      hint: 'Valid GraphQL SDL.' },
    '.proto':      { mime: 'text/plain',      hint: 'Valid proto3.' },
  };
  for (const [ext, meta] of Object.entries(extra)) m.set(ext, meta);
  return m;
})();

const SPECIAL_NAMES = new Map([
  ['dockerfile',     { mime: 'text/plain', hint: TEXT_FORMATS.dockerfile.guidance }],
  ['makefile',       { mime: 'text/plain', hint: 'A valid Makefile — TAB-indented recipes, .PHONY targets.' },],
  ['.gitignore',     EXT_META.get('.gitignore') ?? { mime: 'text/plain', hint: '' }],
  ['.env.example',   EXT_META.get('.env.example') ?? { mime: 'text/plain', hint: '' }],
  ['license',        { mime: 'text/plain', hint: 'A complete standard license text (MIT unless the user chose another).' }],
]);

export function metaForPath(relPath) {
  const base = path.basename(relPath).toLowerCase();
  if (SPECIAL_NAMES.has(base)) return SPECIAL_NAMES.get(base);
  // Compound extensions first (.env.example already caught by basename)
  const ext = path.extname(base);
  return EXT_META.get(ext) ?? { mime: 'text/plain', hint: '' };
}

registerExporter('project', {
  label: 'Multi-file code project',
  extensions: ['.zip', '.tar', '.tar.gz'],   // archive forms it downloads as
  mimes: [...new Set([...EXT_META.values(), ...SPECIAL_NAMES.values()].map(m => m.mime))],
  contentModel: 'files',
  guidance: GUIDANCE,

  async build({ spec, ctx, helpers }) {
    const files = await helpers.mapConcurrent(spec.files, (file) =>
      helpers.generateFile({
        spec, file, ctx,
        formatGuidance: [
          GUIDANCE,
          metaForPath(file.path).hint,
        ].filter(Boolean).join(' '),
      }).then(text => ({ path: file.path, text })));
    return { files };
  },

  validate(model) {
    const errors = [];
    if (!model?.files?.length) errors.push('project produced no files');
    for (const f of model?.files ?? []) {
      if (typeof f.text !== 'string' || !f.text.trim()) errors.push(`"${f.path}": empty content`);
    }
    return { valid: errors.length === 0, errors };
  },

  export(model) {
    return {
      files: model.files.map(f => ({
        path:   f.path,
        buffer: Buffer.from(f.text, 'utf8'),
        mime:   metaForPath(f.path).mime,
      })),
    };
  },
});

export {};
