/**
 * AQUA Artifact Engine — Builder (P1)
 * ─────────────────────────────────────────────────────────────────────────────
 * The ONLY module that generates artifact CONTENT. Exporters describe
 * format (guidance line, mime, canonical extension) and hand each file back
 * here through helpers.generateFile — so provider concerns (router, budget,
 * fence-stripping, concurrency, abort) live in exactly one place, and every
 * exporter stays unit-testable with a stub generator.
 *
 * Per-file calls ride generateText() end-to-end — ranking, health, learned
 * priors, the full fallback chain — with the taskType picked per FORMAT
 * (code-ish files rank coding-strong providers; documents rank
 * creative_writing) so the QUALITY matrix keeps doing its job.
 *
 * Abort: clientSignal is checked BETWEEN files. An in-flight generateText
 * cannot be cancelled (the provider router owns its own timeout budget), so
 * a user's Stop takes effect at the next file boundary — bounded by one
 * file's budget, same latitude the verification pass already takes.
 */
import { generateText }  from '../providers/router.js';
import { createContext } from '../core/observability.js';
import { extractJson }   from './planner.js';

const FILE_BUDGET   = { maxResponseTokens: 4_096 };
const CONCURRENCY   = 3;

/** format id → taskType for provider ranking (must exist in QUALITY matrix). */
const FORMAT_TASK_TYPE = {
  md: 'creative_writing', txt: 'creative_writing', html: 'coding',
  css: 'coding', js: 'coding', ts: 'coding', py: 'coding',
  json: 'coding', xml: 'coding', yaml: 'coding', csv: 'analysis',
  svg: 'coding', mermaid: 'architecture', sql: 'coding', sh: 'coding',
  bat: 'coding', dockerfile: 'coding', openapi: 'architecture',
  postman: 'coding', k8s: 'coding', terraform: 'coding',
  pptx: 'creative_writing', pdf: 'creative_writing',
  docx: 'creative_writing', xlsx: 'analysis', project: 'coding',
};

// ── Structured (JSON) content generation — binary exporters (P2) ─────────────
// pptx/pdf/docx/xlsx exporters don't want raw text, they want a machine-
// renderable content model (slides array, document blocks, sheet rows). Same
// trust discipline as the planner: JSON-only prompt → extractJson → ONE
// repair pass with the parse error → throw. The exporter's own validate()
// then enforces the model's shape before anything renders.

function buildJsonSystemPrompt({ spec, file, schemaHint, formatGuidance }) {
  const structure   = spec.structure   ? JSON.stringify(spec.structure, null, 2)   : '';
  const constraints = spec.constraints ? JSON.stringify(spec.constraints, null, 2) : '';
  return [
    `You are AQUA's artifact builder. Output the complete CONTENT MODEL for one ${spec.format} artifact file ("${file.path}") as a single JSON object.`,
    formatGuidance ? `Format notes: ${formatGuidance}` : '',
    '',
    `Artifact: "${spec.title}"${spec.intentSummary ? ` — ${spec.intentSummary}` : ''}`,
    file.description ? `This file's job: ${file.description}` : '',
    structure   ? `Planned structure:\n${structure}`  : '',
    constraints ? `User constraints:\n${constraints}` : '',
    '',
    'The JSON MUST match exactly this shape:',
    schemaHint,
    '',
    'Rules:',
    '- Respond with the JSON object ONLY. No prose, no markdown fences, no comments.',
    '- Content must be complete, specific, and immediately usable — never placeholders.',
    '- Keep values internally consistent (names, numbers, dates that reference each other must agree).',
  ].filter(Boolean).join('\n');
}

/**
 * Generate + parse a JSON content model for one file. One repair retry,
 * then throws (engine converts to the standard chat fallback).
 */
async function generateJsonModel({
  spec, file, schemaHint, formatGuidance, contextBrief,
  requestId, conversationId, index, generate,
}) {
  const systemPrompt = buildJsonSystemPrompt({ spec, file, schemaHint, formatGuidance });
  const taskType = FORMAT_TASK_TYPE[spec.format] ?? 'analysis';
  const userContent = [
    `Produce the ${spec.format} content model for "${file.path}" now.`,
    contextBrief ? `\nContext about the user/conversation (personalize with it where natural):\n${contextBrief}` : '',
  ].join('\n');

  const ask = async (content, suffix) => generate(
    content,
    systemPrompt,
    [{ role: 'user', content }],
    createContext({ conversationId, requestId: requestId ? `${requestId}-artjson${index}${suffix}` : undefined }),
    taskType,
    undefined,
    FILE_BUDGET,
  );

  const first = await ask(userContent, '');
  let json = extractJson(first?.text ?? '');
  let provider = first?.provider ?? null;

  // Same trap as the planner, one layer down: a big content model (a 20-slide
  // deck, a long report) can hit maxTokens. extractJson repairs the
  // truncation, so we degrade to a slightly shorter artifact instead of
  // failing the turn — but it must never be silent.
  if (first?.truncated === true || first?.finishReason === 'length') {
    console.warn(`[ARTIFACT] content model for "${file.path}" TRUNCATED (finishReason=${first?.finishReason}) — recovered=${json != null}; artifact may be shorter than requested`);
  }

  if (json == null) {
    console.warn(`[ARTIFACT] JSON model unparseable for "${file.path}" — one repair attempt req=${requestId}`);
    const second = await ask([
      userContent, '',
      'Your previous reply was NOT parseable JSON. Previous output:',
      (first?.text ?? '').slice(0, 4_000), '',
      'Return the corrected JSON object only.',
    ].join('\n'), '-r');
    json = extractJson(second?.text ?? '');
    provider = second?.provider ?? provider;
    if (json == null) throw new Error(`Builder produced unparseable JSON model for "${file.path}" twice`);
  }
  return { json, provider };
}

export class ArtifactAbortError extends Error {
  constructor() {
    super('Artifact generation aborted by client');
    this.name = 'ArtifactAbortError';
  }
}

// ── Fence stripping ───────────────────────────────────────────────────────────
// The prompt forbids fences, but models wrap anyway. Strip ONE leading and
// ONE trailing fence pair; interior fences (legit in markdown docs) survive.

export function stripOuterFences(text) {
  let t = String(text ?? '').trim();
  const lead = t.match(/^```[\w+-]*\s*\n/);
  if (lead && t.endsWith('```')) {
    t = t.slice(lead[0].length, -3).replace(/\n$/, '');
  }
  return t.trim();
}

// ── Bounded-concurrency map ───────────────────────────────────────────────────

/**
 * Map with a worker pool of `limit`. Results keep input order. First
 * rejection wins (remaining workers drain their current item, no new items
 * start).
 */
export async function mapConcurrent(items, fn, limit = CONCURRENCY) {
  const results = new Array(items.length);
  let next = 0;
  let failed = null;

  async function worker() {
    while (true) {
      if (failed) return;
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        failed = failed ?? err;
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed) throw failed;
  return results;
}

// ── Per-file content generation ───────────────────────────────────────────────

function buildFileSystemPrompt({ spec, file, formatGuidance }) {
  const structure = spec.structure ? JSON.stringify(spec.structure, null, 2) : '';
  const constraints = spec.constraints ? JSON.stringify(spec.constraints, null, 2) : '';
  return [
    `You are AQUA's artifact builder. Output the COMPLETE, FINAL content of ONE file: "${file.path}".`,
    formatGuidance ? `Format requirements: ${formatGuidance}` : '',
    '',
    `Artifact: "${spec.title}"${spec.intentSummary ? ` — ${spec.intentSummary}` : ''}`,
    file.description ? `This file's job: ${file.description}` : '',
    structure   ? `Planned structure:\n${structure}`     : '',
    constraints ? `User constraints:\n${constraints}`    : '',
    '',
    'Rules:',
    '- Output ONLY the raw file content. No explanations, no preamble, no markdown fences around the content.',
    '- The content must be complete and immediately usable — never placeholders like "add content here".',
    '- Write at production quality: this file is downloaded and used as-is.',
  ].filter(Boolean).join('\n');
}

/**
 * Generate one file's text. Injectable `generate` (tests run offline).
 */
async function generateFileContent({
  spec, file, formatGuidance, contextBrief,
  requestId, conversationId, index, generate,
}) {
  const ctx = createContext({
    conversationId,
    requestId: requestId ? `${requestId}-artfile${index}` : undefined,
  });
  const taskType = FORMAT_TASK_TYPE[spec.format] ?? 'creative_writing';

  const userContent = [
    `Produce the file "${file.path}" now.`,
    contextBrief ? `\nContext about the user/conversation (personalize with it where natural):\n${contextBrief}` : '',
  ].join('\n');

  const result = await generate(
    userContent,
    buildFileSystemPrompt({ spec, file, formatGuidance }),
    [{ role: 'user', content: userContent }],
    ctx,
    taskType,
    undefined,
    FILE_BUDGET,
  );

  const text = stripOuterFences(result?.text ?? '');
  if (!text) throw new Error(`Builder produced empty content for "${file.path}"`);
  return { text, provider: result?.provider ?? null };
}

// ── Main entry ────────────────────────────────────────────────────────────────

/**
 * Build the exporter's content model for a validated spec.
 *
 * @param {{
 *   spec: object, exporter: object, contextBrief?: string,
 *   requestId?: string, conversationId?: string,
 *   generate?: Function, onFileDone?: (info: {path:string,index:number,total:number}) => void,
 *   signal?: AbortSignal,
 * }} input
 * @returns {Promise<{ model: object, providers: string[] }>}
 */
export async function buildArtifact({
  spec, exporter, contextBrief = '',
  requestId, conversationId,
  generate = generateText, onFileDone = () => {}, signal,
}) {
  const total     = spec.files.length;
  const providers = new Set();
  let done = 0;

  const helpers = {
    mapConcurrent,
    generateFile: async ({ spec: s, file, formatGuidance, ctx: _ctx }) => {
      if (signal?.aborted) throw new ArtifactAbortError();
      const index = s.files.indexOf(file);
      const { text, provider } = await generateFileContent({
        spec: s, file, formatGuidance, contextBrief,
        requestId, conversationId, index, generate,
      });
      if (provider) providers.add(provider);
      done += 1;
      try { onFileDone({ path: file.path, index: done, total }); } catch { /* observer errors never break the build */ }
      return text;
    },
    /** P2 — structured JSON content model (slides/blocks/sheets) for binary exporters. */
    generateJson: async ({ spec: s, file, schemaHint, formatGuidance, ctx: _ctx }) => {
      if (signal?.aborted) throw new ArtifactAbortError();
      const index = s.files.indexOf(file);
      const { json, provider } = await generateJsonModel({
        spec: s, file, schemaHint, formatGuidance, contextBrief,
        requestId, conversationId, index, generate,
      });
      if (provider) providers.add(provider);
      done += 1;
      try { onFileDone({ path: file.path, index: done, total }); } catch { /* observer errors never break the build */ }
      return json;
    },
  };

  const model = await exporter.build({ spec, ctx: { contextBrief }, helpers });
  return { model, providers: [...providers] };
}
