/**
 * AQUA Artifact Engine — Planner (P1)
 * ─────────────────────────────────────────────────────────────────────────────
 * "Generate investor pitch deck" → a machine-checkable ArtifactSpec. One LLM
 * call through the SAME provider router every other agent uses (ranking,
 * health, fallback chain, learned priors — free), classified as 'planning'
 * so the strategy table biases toward the providers strong at it.
 *
 * Trust model (mirrors verificationAgent/reasoningAgent):
 *   • prompt asks for JSON ONLY
 *   • reply is fence-stripped, brace-sliced, JSON.parse'd
 *   • specSchema.validateSpec() is the gate — on failure, EXACTLY ONE repair
 *     call goes back with the full error list; a second failure throws
 *     ArtifactError('ARTIFACT_PLAN_INVALID') and chat.js falls back to the
 *     normal pipeline. A flaky plan can never fail a user's request.
 *   • a high-confidence detector format ("… as a .md file") overrides a
 *     planner that wandered to a different format — the user's explicit word
 *     beats the model's taste.
 *
 * `generate` is injectable for offline tests — the exact hook
 * reasoningAgent.js exposes.
 */
import fs   from 'fs';
import path from 'path';
import { fileURLToPath }  from 'url';
import { generateText }   from '../providers/router.js';
import { createContext }  from '../core/observability.js';
import { validateSpec }   from './specSchema.js';
import { listExporterDefs, getExporter } from './exporters/registry.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));

export class ArtifactError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ArtifactError';
    this.code = code;
  }
}

// Style/quality guidance shared by planner + builder — hot-editable without
// touching code, same pattern as src/prompts/*.txt task modules.
let ARTIFACT_GUIDANCE = '';
try {
  ARTIFACT_GUIDANCE = fs.readFileSync(path.join(__dir, '..', 'prompts', 'artifact.txt'), 'utf8').trim();
} catch { /* optional — planner works without it */ }

// The plan is a SPEC, not content — but "15-slide Series A deck" tempts the
// model to outline all 15 slides in `structure`, which blew past the old
// 1,500-token budget and truncated mid-JSON (the whole plan then failed).
// 4,096 gives real headroom; buildPlannerSystemPrompt also caps `structure`
// to titles-only, and extractJson repairs a truncation if one still happens.
const PLAN_BUDGET = { maxResponseTokens: 4_096 };

// ── Prompt construction ───────────────────────────────────────────────────────

function formatCatalog() {
  return listExporterDefs()
    .map(d => `  - ${d.id} — ${d.label} (${d.extensions.filter(Boolean).join(', ') || d.fixedName || 'no extension'})`)
    .join('\n');
}

function buildPlannerSystemPrompt(intent) {
  return [
    'You are the AQUA Artifact Planner. The user asked for a digital artifact (a real downloadable file). Your ONLY job is to output the generation plan as a single JSON object. You never produce the artifact content itself.',
    '',
    'ALLOWED FORMATS (the "format" field MUST be exactly one of these ids):',
    formatCatalog(),
    '',
    intent?.format ? `The system detected the user wants format "${intent.format}". Use it unless their words clearly demand another allowed format.` : '',
    '',
    'Output JSON with EXACTLY this shape:',
    '{',
    '  "format": "<one allowed id>",',
    '  "title": "<short human title for the artifact>",',
    '  "intentSummary": "<one sentence: what the user wants>",',
    '  "files": [ { "path": "<relative filename>", "role": "primary|source|asset|doc|config|test", "description": "<what goes in this file>" } ],',
    '  "packaging": "auto",',
    '  "structure": { <optional format-specific outline: sections, columns, diagram type, etc.> },',
    '  "constraints": { <optional explicit user constraints: counts, tone, language, ...> }',
    '}',
    '',
    'Rules:',
    '- Paths are RELATIVE filenames with forward slashes. NEVER use "..", never start with "/". Use sensible names ("README.md", "schema.sql").',
    '- Single-document formats (md, pdf, html, csv, sql, ...) normally mean ONE file unless the user clearly asked for a set.',
    '- Give every file a specific, useful "description" — the builder writes each file from it.',
    '- "structure" should capture the outline implied by the request (sections for documents, header columns for csv, diagram type for mermaid, resources for k8s...).',
    '- KEEP "structure" COMPACT — TITLES/LABELS ONLY, never the actual content. A 15-slide deck lists 15 short slide titles, NOT their bullets. A separate builder step writes every word of the content from your plan; a long plan is a WRONG plan.',
    '- Put counts, tone, audience, currency and similar requirements in "constraints" as short values (e.g. {"slideCount": 15, "audience": "Series A investors"}) — never expand them into content.',
    '- Format "project" = a complete runnable multi-file tree: 5-25 ESSENTIAL files (package manifest, entry point, source modules, README, config) — no filler files, every description precise enough to write the file from.',
    '- "packaging" stays "auto" unless the user explicitly asked for zip, tar, or tar.gz.',
    '- Respond with the JSON object ONLY. No prose, no markdown fences, no comments.',
    ARTIFACT_GUIDANCE ? `\n${ARTIFACT_GUIDANCE}` : '',
  ].filter(Boolean).join('\n');
}

// ── JSON extraction ───────────────────────────────────────────────────────────

/**
 * Close a truncated JSON fragment: terminate an open string, drop a trailing
 * comma/dangling key, and close every open bracket in the right order.
 * Exported for tests.
 */
export function repairTruncatedJson(fragment) {
  let t = String(fragment);
  const stack = [];
  let inString = false;
  let escaped  = false;

  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (escaped)            { escaped = false; continue; }
    if (c === '\\')         { if (inString) escaped = true; continue; }
    if (c === '"')          { inString = !inString; continue; }
    if (inString)           continue;
    if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') stack.pop();
  }

  if (inString) t += '"';                 // unterminated string
  t = t.replace(/[,:]\s*$/, '');          // trailing comma or dangling "key":
  while (stack.length) t += stack.pop() === '{' ? '}' : ']';
  t = t.replace(/,(\s*[}\]])/g, '$1');    // trailing commas before closers
  return t;
}

/** Last structural (outside-string) index of any char in `chars`. */
function lastStructuralIndex(t, chars) {
  let inString = false, escaped = false, found = -1;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (escaped)    { escaped = false; continue; }
    if (c === '\\') { if (inString) escaped = true; continue; }
    if (c === '"')  { inString = !inString; continue; }
    if (inString)   continue;
    if (chars.includes(c)) found = i;
  }
  return found;
}

/**
 * Fence-strip → brace-slice → parse. TOLERANT (P6.1): models wrap JSON in
 * prose/markdown and providers truncate at maxTokens, so a strict parse
 * throws away plans that are 95% there. Strategy:
 *   1. parse as-is
 *   2. close the truncation (repairTruncatedJson)
 *   3. progressively drop the last incomplete element and re-close, up to
 *      MAX_TRIM times
 * Returns null only when nothing salvageable remains.
 *
 * Safe by construction: validateSpec() is still the gate — a repaired plan
 * missing required fields is rejected exactly like any other bad plan.
 * Repair only ever RECOVERS structure; it never invents content.
 */
const MAX_TRIM = 60;

export function extractJson(text) {
  if (typeof text !== 'string') return null;
  let t = text.trim()
    .replace(/^```[\w-]*\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();

  const start = t.indexOf('{');
  if (start === -1) return null;
  const end = t.lastIndexOf('}');

  // Complete-looking object first (cheapest path, unchanged behavior).
  if (end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch { /* fall through to repair */ }
  }

  // Truncated (or malformed): take everything from the first brace and repair.
  let body = t.slice(start);
  try { return JSON.parse(repairTruncatedJson(body)); } catch { /* fall through to trimming */ }

  for (let i = 0; i < MAX_TRIM && body.length > 2; i++) {
    const cut = lastStructuralIndex(body, ',');
    if (cut <= 0) break;
    body = body.slice(0, cut);
    try { return JSON.parse(repairTruncatedJson(body)); } catch { /* keep trimming */ }
  }
  return null;
}

// ── Format reconcile ──────────────────────────────────────────────────────────

/**
 * A ≥0.9-confidence detector hit is the user's own words ("… as a .md
 * file") — enforce it over planner drift, re-pointing the primary file's
 * extension at the enforced format's canonical one.
 */
function reconcileFormat(spec, intent) {
  if (!intent?.format || intent.confidence < 0.9) return spec;
  if (spec.format === intent.format) return spec;
  const target = getExporter(intent.format);
  if (!target) return spec; // unregistered (P2/P3 format) — engine gates earlier, belt-and-braces here

  console.warn(`[ARTIFACT] planner chose "${spec.format}" but user asked for "${intent.format}" — enforcing user's format`);
  spec.format = intent.format;

  const canonicalExt = target.extensions[0] ?? '';
  spec.files = spec.files.map((f, i) => {
    if (i > 0 && f.role !== 'primary') return f;
    const fixed = Object.assign(Object.create(null), f);
    if (target.fixedName) {
      fixed.path = target.fixedName;
    } else if (canonicalExt && !fixed.path.toLowerCase().endsWith(canonicalExt)) {
      fixed.path = fixed.path.replace(/\.[a-z0-9]{1,8}$/i, '') + canonicalExt;
    }
    return fixed;
  });
  return spec;
}

// ── Main entry ────────────────────────────────────────────────────────────────

/**
 * @param {{
 *   userMessage: string,
 *   contextBrief?: string,        compact grounding block from engine.js
 *   intent?: object,              detector result
 *   requestId?: string, conversationId?: string,
 *   generate?: Function,          test injection; defaults to generateText
 * }} input
 * @returns {Promise<{ spec: object, provider: string|null, latencyMs: number, repaired: boolean }>}
 * @throws {ArtifactError} ARTIFACT_PLAN_INVALID when both attempts fail
 */
export async function planArtifact({
  userMessage, contextBrief = '', intent = null,
  requestId, conversationId, generate = generateText,
}) {
  const start        = Date.now();
  const knownFormats = listExporterDefs().map(d => d.id);
  const systemPrompt = buildPlannerSystemPrompt(intent);
  const planCtx      = createContext({ conversationId, requestId: requestId ? `${requestId}-artplan` : undefined });

  const userContent = [
    `User request:\n${userMessage}`,
    contextBrief ? `\nRelevant context about the user/conversation (use it to personalize):\n${contextBrief}` : '',
  ].filter(Boolean).join('\n');

  const ask = (content) => generate(
    userMessage,
    systemPrompt,
    [{ role: 'user', content }],
    planCtx,
    'planning',        // real task type → planning-strong provider ranking
    undefined,
    PLAN_BUDGET,
  );

  // Attempt 1
  const first  = await ask(userContent);
  let parsed   = extractJson(first?.text ?? '');
  let checked  = parsed ? validateSpec(parsed, { knownFormats }) : { valid: false, errors: ['reply was not parseable JSON'] };
  let repaired = false;
  let provider = first?.provider ?? null;

  // The router surfaces { text, truncated, finishReason } and treats a
  // truncation as success. The planner USES that signal now: a truncated
  // reply means the model ran out of budget mid-JSON, so the retry must ask
  // for a SMALLER plan — repeating the same prompt just truncates again
  // (the original failure mode: two truncated calls, then fallback to chat).
  const wasTruncated = first?.truncated === true || first?.finishReason === 'length';
  if (wasTruncated) {
    console.warn(`[ARTIFACT] planner reply TRUNCATED (finishReason=${first?.finishReason}) — repaired=${!!parsed} req=${requestId}`);
  }

  // Attempt 2 — exactly one repair pass with the full error list
  if (!checked.valid) {
    console.warn(`[ARTIFACT] plan invalid (${checked.errors.length} errors) — one repair attempt req=${requestId}`);
    const repairContent = [
      userContent,
      '',
      wasTruncated
        ? 'Your previous JSON plan was CUT OFF because it was too long. Produce a MUCH SHORTER plan: "structure" must contain only short titles/labels (no content), and "constraints" only short values. The plan must be complete and closed.'
        : 'Your previous JSON plan was INVALID:',
      ...(wasTruncated ? [] : checked.errors.map(e => `- ${e}`)),
      '',
      ...(wasTruncated ? [] : ['Previous output:', (first?.text ?? '').slice(0, 4_000)]),
      '',
      'Return the CORRECTED JSON object only.',
    ].join('\n');

    const second = await ask(repairContent);
    parsed  = extractJson(second?.text ?? '');
    checked = parsed ? validateSpec(parsed, { knownFormats }) : { valid: false, errors: ['repair reply was not parseable JSON'] };
    provider = second?.provider ?? provider;
    repaired = true;

    if (!checked.valid) {
      throw new ArtifactError(
        'ARTIFACT_PLAN_INVALID',
        `Planner produced an invalid spec twice: ${checked.errors.slice(0, 5).join('; ')}`,
      );
    }
  }

  const spec = reconcileFormat(checked.spec, intent);
  console.log(`[ARTIFACT] plan ok format=${spec.format} files=${spec.files.length} repaired=${repaired} provider=${provider} latency=${Date.now() - start}ms req=${requestId}`);
  return { spec, provider, latencyMs: Date.now() - start, repaired };
}
