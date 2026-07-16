/**
 * AQUA Artifact Engine — Text Exporter Family (P1)
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE shared implementation for every plain-text format — the spec's "no
 * duplicated logic" requirement made concrete. Each entry in TEXT_FORMATS is
 * a registration, not a code path: build/validate/export are shared closures
 * parameterized only by the table row.
 *
 * build() delegates content generation to helpers.generateFile (owned by
 * builder.js, which owns the LLM call, budget, fence-stripping, and
 * concurrency) — exporters describe FORMAT, the builder produces CONTENT.
 * That keeps every exporter trivially unit-testable with a stub generator
 * and keeps provider concerns in exactly one file.
 */
import { registerExporter } from './registry.js';

// id → { label, ext (canonical), mime, aliases?, guidance (format-specific
// prompt line the builder appends), defaultName (primary-file name the
// planner is nudged toward) }
export const TEXT_FORMATS = {
  md:         { label: 'Markdown document',      ext: '.md',   mime: 'text/markdown',
                guidance: 'Well-structured Markdown: one # title, ## sections, lists/tables/code fences where they genuinely help.' },
  html:       { label: 'HTML page',              ext: '.html', mime: 'text/html',
                guidance: 'A complete standalone HTML5 document: <!doctype html>, inline <style>, no external network dependencies.' },
  css:        { label: 'CSS stylesheet',         ext: '.css',  mime: 'text/css',
                guidance: 'Valid CSS only — organized sections with comments.' },
  js:         { label: 'JavaScript file',        ext: '.js',   mime: 'text/javascript',
                guidance: 'Valid modern JavaScript (ES2022). Include brief header comment. No surrounding prose.' },
  ts:         { label: 'TypeScript file',        ext: '.ts',   mime: 'text/typescript',
                guidance: 'Valid TypeScript with explicit types. No surrounding prose.' },
  py:         { label: 'Python file',            ext: '.py',   mime: 'text/x-python',
                guidance: 'Valid Python 3 with a module docstring. PEP 8. No surrounding prose.' },
  json:       { label: 'JSON file',              ext: '.json', mime: 'application/json',
                guidance: 'STRICTLY valid JSON — double quotes, no comments, no trailing commas.' },
  xml:        { label: 'XML file',               ext: '.xml',  mime: 'application/xml',
                guidance: 'Well-formed XML with a single root element and an XML declaration.' },
  yaml:       { label: 'YAML file',              ext: '.yaml', mime: 'application/yaml', aliases: ['.yml'],
                guidance: 'Valid YAML — 2-space indentation, comments where helpful.' },
  csv:        { label: 'CSV file',               ext: '.csv',  mime: 'text/csv',
                guidance: 'RFC-4180 CSV: header row first, comma-separated, quote fields containing commas/newlines. NO markdown table syntax.' },
  svg:        { label: 'SVG graphic',            ext: '.svg',  mime: 'image/svg+xml',
                guidance: 'A single valid <svg> element with xmlns and viewBox. Self-contained — no external refs, no scripts.' },
  mermaid:    { label: 'Mermaid diagram',        ext: '.mmd',  mime: 'text/vnd.mermaid', aliases: ['.mermaid'],
                guidance: 'Valid Mermaid syntax ONLY (flowchart/sequenceDiagram/classDiagram/mindmap...). No markdown fences.' },
  sql:        { label: 'SQL script',             ext: '.sql',  mime: 'application/sql',
                guidance: 'Executable SQL with comments. State the dialect in a leading comment.' },
  sh:         { label: 'Shell script',           ext: '.sh',   mime: 'text/x-shellscript',
                guidance: 'A POSIX/bash script starting with #!/usr/bin/env bash and `set -euo pipefail`. Comment each section.' },
  bat:        { label: 'Windows batch file',     ext: '.bat',  mime: 'text/plain',
                guidance: 'A valid Windows .bat script starting with @echo off.' },
  txt:        { label: 'Plain text file',        ext: '.txt',  mime: 'text/plain',
                guidance: 'Plain text — no markdown syntax.' },
  dockerfile: { label: 'Dockerfile',             ext: '',      mime: 'text/plain', fixedName: 'Dockerfile',
                guidance: 'A production-quality multi-stage Dockerfile with comments. Output the Dockerfile content only.' },
  openapi:    { label: 'OpenAPI 3 specification', ext: '.yaml', mime: 'application/yaml', defaultName: 'openapi.yaml',
                guidance: 'A complete, valid OpenAPI 3.0+ YAML document: info, servers, paths, components/schemas.' },
  postman:    { label: 'Postman collection',     ext: '.json', mime: 'application/json', defaultName: 'postman_collection.json',
                guidance: 'STRICTLY valid Postman Collection v2.1 JSON (info._postman_id, item[], request objects).' },
  k8s:        { label: 'Kubernetes manifests',   ext: '.yaml', mime: 'application/yaml',
                guidance: 'Valid Kubernetes YAML. Multiple resources separated by `---`. apiVersion/kind/metadata on each.' },
  terraform:  { label: 'Terraform configuration', ext: '.tf',  mime: 'text/plain',
                guidance: 'Valid Terraform HCL — terraform/provider blocks, variables with descriptions, comments.' },
};

// ── Shared implementation (closed over each table row) ───────────────────────

function makeTextExporter(id, fmt) {
  return {
    label: fmt.label,
    extensions: [fmt.ext || '', ...(fmt.aliases ?? [])].filter(Boolean).length
      ? [fmt.ext, ...(fmt.aliases ?? [])].filter(Boolean)
      : ['.txt'], // dockerfile: extensionless canonical name, .txt as registry fallback ext
    mimes: [fmt.mime],
    contentModel: 'files',
    guidance: fmt.guidance,
    fixedName: fmt.fixedName,
    defaultName: fmt.defaultName,

    /**
     * Generate text for every file in the spec via the builder's
     * generateFile helper (LLM call lives THERE, not here).
     */
    async build({ spec, ctx, helpers }) {
      const files = await helpers.mapConcurrent(spec.files, (file) =>
        helpers.generateFile({ spec, file, formatGuidance: fmt.guidance, ctx })
          .then(text => ({ path: file.path, text })));
      return { files };
    },

    validate(model) {
      const errors = [];
      if (!model?.files?.length) errors.push('model produced no files');
      for (const f of model?.files ?? []) {
        if (typeof f.text !== 'string' || !f.text.trim()) {
          errors.push(`"${f.path}": empty content`);
        }
      }
      return { valid: errors.length === 0, errors };
    },

    export(model) {
      return {
        files: model.files.map(f => ({
          path:   f.path,
          buffer: Buffer.from(f.text, 'utf8'),
          mime:   fmt.mime,
        })),
      };
    },
  };
}

for (const [id, fmt] of Object.entries(TEXT_FORMATS)) {
  registerExporter(id, makeTextExporter(id, fmt));
}

console.log(`[ARTIFACT] ${Object.keys(TEXT_FORMATS).length} text exporters registered`);

export {};
