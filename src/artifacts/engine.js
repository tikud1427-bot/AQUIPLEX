/**
 * AQUA Artifact Engine (P1) — the conductor
 * ─────────────────────────────────────────────────────────────────────────────
 * plan → build → validate → export → package-decision → store, with typed
 * progress events for the SSE layer. Registers itself as the 'artifact'
 * agent on import — the exact side-effect pattern verificationAgent /
 * reasoningAgent / searchAgent established, so chat.js discovers it through
 * getAgent('artifact') and capabilities.js can report it honestly.
 *
 * Failure contract (the one that matters): execute() THROWS on any
 * problem — invalid plan after repair, unavailable format, failed build,
 * failed validation, aborted client. chat.js catches, logs, and falls back
 * to the normal chat pipeline. A user request never fails because the
 * artifact path hiccuped; worst case they get a normal chat answer — the
 * same guarantee the edit branch has honored since Day 4.
 *
 * Transport-agnostic: emits { type, ... } events through onEvent; chat.js
 * maps them onto SSE (`stage`, `artifact_plan`, `artifact_progress`,
 * `artifact`). The engine never touches res.
 */
import { generateText }   from '../providers/router.js';
import { registerAgent }  from '../intelligence/agentRegistry.js';
import './exporters/textExporter.js'; // side effect: registers all P1 text formats
import './exporters/xlsxExporter.js'; // P2 — binary formats (registry gate flips
import './exporters/docxExporter.js'; //      the detector's pptx/pdf/docx/xlsx
import './exporters/pdfExporter.js';  //      mappings live with ZERO detector,
import './exporters/pptxExporter.js'; //      engine, or route changes)
import './exporters/codeProjectExporter.js'; // P3 — 'project': the last detector format goes live
import { getExporter }    from './exporters/registry.js';
import { planArtifact, ArtifactError }   from './planner.js';
import { buildArtifact, ArtifactAbortError } from './builder.js';
import { validateArtifactFiles }         from './validator.js';
import { resolvePackaging }              from './packager.js';
import { createArtifact }                from './artifactStore.js';

export { ArtifactError, ArtifactAbortError };

// ── Context brief — compact grounding from the turn's prep ────────────────────

const BRIEF_MAX = 1_500;

/**
 * Fold what prepareTurn() already gathered (memory facts, attachment names,
 * search sources, project files) into a compact grounding block for the
 * planner + builder. Bounded hard — this rides inside every per-file prompt.
 */
export function buildContextBrief(prep) {
  if (!prep) return '';
  const parts = [];

  const facts = (prep.relevantFacts ?? []).slice(0, 6)
    .map(f => typeof f === 'string' ? f : (f?.value ?? f?.fact ?? f?.text ?? ''))
    .filter(Boolean);
  if (facts.length) parts.push(`Known about the user:\n- ${facts.join('\n- ')}`);

  const attachments = (prep.attachments ?? []).map(a => a?.name).filter(Boolean).slice(0, 8);
  if (attachments.length) parts.push(`Files the user attached this conversation: ${attachments.join(', ')}`);

  const sources = (prep.searchSources ?? prep.search?.sources ?? []).slice(0, 4)
    .map(s => s?.title ?? s?.url).filter(Boolean);
  if (sources.length) parts.push(`Fresh web sources this turn: ${sources.join(' | ')}`);

  const projectFiles = (prep.projectFiles ?? []).slice(0, 10);
  if (projectFiles.length) parts.push(`Workspace files in context: ${projectFiles.join(', ')}`);

  return parts.join('\n\n').slice(0, BRIEF_MAX);
}

// ── Public manifest (what SSE / done payload / list API expose) ───────────────

export function publicManifest(m) {
  return {
    id: m.id,
    format: m.format,
    title: m.title,
    version: m.version,
    // P6 — lean version history so clients can offer old versions. Per-version
    // FILE metas stay server-side (they'd bloat every SSE payload); the
    // download/file/preview routes resolve them from ?version=N.
    versions: (m.versions ?? []).map(v => ({
      v: v.v, createdAt: v.createdAt, reason: v.reason, bytes: v.bytes,
    })),
    files: m.files.map(f => ({ path: f.path, size: f.size, mime: f.mime })),
    totalBytes: m.totalBytes,
    packaging: m.packaging,
    conversationId: m.conversationId,
    workspaceId: m.workspaceId ?? null,
    createdAt: m.createdAt,
    downloadUrl: `/artifacts/${m.id}/download`,
  };
}

// ── Summary text (the assistant's chat message for an artifact turn) ──────────

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** P5 — assistant message for an edit turn (new version of an existing artifact). */
export function composeArtifactEditSummary(manifest, changed = []) {
  const what = changed.length && changed[0] !== 'model'
    ? changed.slice(0, 6).map(p => `\`${p}\``).join(', ') + (changed.length > 6 ? ` +${changed.length - 6} more` : '')
    : 'the content';
  return [
    `Updated **${manifest.title}** → v${manifest.version} (changed ${what}).`,
    '',
    `Every earlier version stays downloadable. Grab v${manifest.version} below.`,
  ].join('\n');
}

export function composeArtifactSummary(manifest) {
  const lines = [
    `**${manifest.title}** is ready — ${manifest.files.length} file${manifest.files.length > 1 ? 's' : ''}, ${fmtBytes(manifest.totalBytes)}.`,
    '',
    ...manifest.files.slice(0, 12).map(f => `- \`${f.path}\` (${fmtBytes(f.size)})`),
  ];
  if (manifest.files.length > 12) lines.push(`- …and ${manifest.files.length - 12} more`);
  lines.push('', manifest.packaging === 'zip'
    ? 'Download below — files arrive as a .zip.'
    : 'Download below.');
  return lines.join('\n');
}

// ── Main entry ────────────────────────────────────────────────────────────────

/**
 * Run the full artifact pipeline for one turn.
 *
 * @param {{
 *   userMessage: string,
 *   prep: object,                 prepareTurn() output (memory/attachments/search grounding)
 *   intent: object,               detectArtifactIntent() result (wants:true)
 *   ownerId: string|null,         prep.memoryOwner — the SAME owner model memory uses
 *   conversationId: string, workspaceId?: string|null, requestId: string,
 *   onEvent?: (ev: object) => void,
 *   clientSignal?: AbortSignal,
 *   generate?: Function,          test injection; flows into planner + builder
 * }} input
 * @returns {Promise<{ manifest: object, summaryText: string, providers: string[], latencyMs: number }>}
 */
export async function execute({
  userMessage, prep, intent,
  ownerId = null, conversationId, workspaceId = null, requestId,
  onEvent = () => {}, clientSignal, generate = generateText,
}) {
  const start = Date.now();
  const emit  = (ev) => { try { onEvent(ev); } catch { /* observer errors never break the pipeline */ } };

  // Gate: the detector maps to TRUE formats (pitch deck → pptx) even before
  // that exporter ships. Unregistered → throw now, chat.js answers inline.
  if (intent?.format && !getExporter(intent.format)) {
    throw new ArtifactError('FORMAT_UNAVAILABLE', `Format "${intent.format}" has no registered exporter yet`);
  }

  const contextBrief = buildContextBrief(prep);

  // 1 — Plan
  emit({ type: 'stage', id: 'artifact_plan', label: 'Planning artifact…' });
  const plan = await planArtifact({ userMessage, contextBrief, intent, requestId, conversationId, generate });
  const spec = plan.spec;

  const exporter = getExporter(spec.format);
  if (!exporter) {
    // validateSpec constrains format to the registry, so this is a hard invariant.
    throw new ArtifactError('FORMAT_UNAVAILABLE', `No exporter for planned format "${spec.format}"`);
  }

  emit({ type: 'plan', plan: {
    format: spec.format,
    title: spec.title,
    files: spec.files.map(f => ({ path: f.path, role: f.role ?? 'source' })),
    packaging: spec.packaging,
  } });

  if (clientSignal?.aborted) throw new ArtifactAbortError();

  // 2 — Build (content generation)
  emit({ type: 'stage', id: 'artifact_build', label: `Building ${spec.files.length} file${spec.files.length > 1 ? 's' : ''}…` });
  const { model, providers } = await buildArtifact({
    spec, exporter, contextBrief, requestId, conversationId, generate,
    signal: clientSignal,
    onFileDone: (info) => emit({ type: 'progress', progress: { stage: 'building', ...info } }),
  });

  // 3 — Format-level validation (exporter's own rules)
  if (typeof exporter.validate === 'function') {
    const fv = exporter.validate(model);
    if (!fv.valid) {
      throw new ArtifactError('ARTIFACT_BUILD_INVALID', `Exporter validation failed: ${fv.errors.slice(0, 5).join('; ')}`);
    }
  }

  // 4 — Export to concrete files (may be async — pptx/pdf/docx renderers are;
  //     text exporters stay sync and `await` passes them through untouched)
  const { files } = await exporter.export(model, { spec });

  // 5 — Global validation (quotas, executables, mime, utf8)
  emit({ type: 'stage', id: 'artifact_validate', label: 'Validating artifact…' });
  const gv = validateArtifactFiles(files, spec, exporter);
  if (!gv.valid) {
    throw new ArtifactError('ARTIFACT_INVALID', `Artifact validation failed: ${gv.errors.slice(0, 5).join('; ')}`);
  }

  if (clientSignal?.aborted) throw new ArtifactAbortError();

  // 6 — Packaging decision + store (sources are the truth; archives build at download)
  const packaging = resolvePackaging(spec, files.length);
  emit({ type: 'stage', id: 'artifact_store', label: 'Saving artifact…' });
  const manifest = await createArtifact({
    ownerId, conversationId, workspaceId, requestId,
    format: spec.format, title: spec.title, spec, packaging, files,
    // P5 — binary formats persist their content model so edits work on the
    // MODEL ("change slide 5"), never on the rendered binary. 'files'
    // formats reconstruct from stored text at edit time instead.
    model: exporter.contentModel !== 'files' ? model : undefined,
  });

  const pub = publicManifest(manifest);
  emit({ type: 'artifact', manifest: pub });

  return {
    manifest: pub,
    summaryText: composeArtifactSummary(pub),
    providers: [plan.provider, ...providers].filter(Boolean),
    latencyMs: Date.now() - start,
  };
}

// ── Register as the 'artifact' agent (side effect on import) ─────────────────
registerAgent('artifact', {
  name: 'artifact',
  description:
    'Universal Artifact Engine: plans, builds, validates, and stores real ' +
    'downloadable files (P1: 21 text formats — md, html, csv, svg, mermaid, ' +
    'sql, dockerfile, openapi, k8s, terraform, …). Fails closed into the ' +
    'normal chat pipeline — a broken artifact turn becomes a chat answer.',
  run: execute,
});

console.log('[ARTIFACT] artifact agent registered');
