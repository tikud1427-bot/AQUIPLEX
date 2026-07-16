/**
 * AQUA Artifact Engine — Edit Engine (P5)
 * ─────────────────────────────────────────────────────────────────────────────
 * "Change slide 5" without regenerating the deck. Two edit paths, chosen by
 * the exporter's contentModel:
 *
 *   MODEL EDIT ('slides' | 'document' | 'sheet') — binary formats persisted
 *   their content model at create (manifest.model). The LLM receives the
 *   CURRENT model JSON + the instruction and returns the full updated model
 *   (same schema the builder used — exporter.schemaHint). Validate →
 *   re-render → appendVersion. The binary is never reverse-engineered.
 *
 *   FILE EDIT ('files' — text formats + project) — targets are picked
 *   (deterministically when the instruction names a path; one bounded LLM
 *   selection call otherwise), each target is rewritten by the LLM from its
 *   CURRENT content + the instruction, untouched files are copied
 *   byte-for-byte into the new version.
 *
 * Every version is an immutable full snapshot (artifactStore.appendVersion)
 * — v1 stays downloadable forever, exactly the checkpointEngine philosophy.
 * The file SET is stable across P5 versions; structural edits are P6.
 *
 * Failure contract matches the create engine: ANY failure throws before
 * appendVersion runs — a failed edit leaves the artifact exactly as it was.
 */
import fs from 'fs';
import { generateText }   from '../providers/router.js';
import { createContext }  from '../core/observability.js';
import { getExporter }    from './exporters/registry.js';
import { extractJson, ArtifactError } from './planner.js';
import { stripOuterFences } from './builder.js';
import { validateArtifactFiles } from './validator.js';
import {
  getArtifact, appendVersion, getFileAbsolutePath,
} from './artifactStore.js';

const EDIT_BUDGET      = { maxResponseTokens: 4_096 };
const SELECTION_BUDGET = { maxResponseTokens: 300 };
const MODEL_JSON_CAP   = 400_000; // beyond this, model-edit prompts stop being sane

export { ArtifactError };

// ── Shared LLM plumbing ───────────────────────────────────────────────────────

function makeAsk({ requestId, conversationId, generate, taskType, budget }) {
  let n = 0;
  return (userContent, systemPrompt) => {
    n += 1;
    return generate(
      userContent,
      systemPrompt,
      [{ role: 'user', content: userContent }],
      createContext({ conversationId, requestId: requestId ? `${requestId}-artedit${n}` : undefined }),
      taskType,
      undefined,
      budget,
    );
  };
}

// ── FILE EDIT path ('files' content model) ────────────────────────────────────

/** Deterministic target pick: instruction names a stored path (or basename). */
export function matchTargetsByName(instruction, filePaths) {
  const lower = instruction.toLowerCase();
  const hits = filePaths.filter(p => {
    const base = p.split('/').pop().toLowerCase();
    return lower.includes(p.toLowerCase()) || (base.length > 3 && lower.includes(base));
  });
  return hits;
}

async function selectTargets({ instruction, filePaths, ask }) {
  const named = matchTargetsByName(instruction, filePaths);
  if (named.length) return { targets: named, provider: null, selectedBy: 'name' };

  if (filePaths.length === 1) return { targets: filePaths, provider: null, selectedBy: 'only-file' };

  const system = [
    'You select which files of an artifact an edit instruction affects.',
    'Reply with ONLY a JSON array of file paths chosen from the list. Choose the MINIMUM set. No prose.',
  ].join('\n');
  const res = await ask([
    `Files:\n${filePaths.map(p => `- ${p}`).join('\n')}`,
    `\nEdit instruction:\n${instruction}`,
    '\nJSON array of affected paths:',
  ].join('\n'), system);

  const parsed = extractJsonArray(res?.text ?? '');
  const valid  = (parsed ?? []).filter(p => filePaths.includes(p));
  if (!valid.length) {
    throw new ArtifactError('ARTIFACT_EDIT_NO_TARGET', 'Could not determine which files the edit affects');
  }
  return { targets: valid, provider: res?.provider ?? null, selectedBy: 'llm' };
}

function extractJsonArray(text) {
  let t = String(text ?? '').trim().replace(/^```[\w-]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  const start = t.indexOf('[');
  const end   = t.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  try {
    const arr = JSON.parse(t.slice(start, end + 1));
    return Array.isArray(arr) ? arr.filter(x => typeof x === 'string') : null;
  } catch { return null; }
}

async function editFilesModel({ manifest, instruction, ask, onEvent }) {
  const exporter  = getExporter(manifest.format);
  const filePaths = manifest.files.map(f => f.path);

  const { targets, provider: selProvider, selectedBy } =
    await selectTargets({ instruction, filePaths, ask });
  onEvent({ type: 'progress', progress: { stage: 'editing', targets, selectedBy } });

  const providers = selProvider ? [selProvider] : [];
  const current = new Map(manifest.files.map(f => [
    f.path,
    fs.readFileSync(getFileAbsolutePath(manifest, f.path)),
  ]));

  const files = [];
  let idx = 0;
  for (const p of filePaths) {
    const meta = manifest.files.find(f => f.path === p);
    if (!targets.includes(p)) {
      files.push({ path: p, buffer: current.get(p), mime: meta.mime }); // untouched — byte-identical copy
      continue;
    }
    idx += 1;
    const system = [
      `You are AQUA's artifact editor. Apply the user's edit to ONE file and output the COMPLETE, FINAL new content of "${p}".`,
      exporter.guidance ? `Format requirements: ${exporter.guidance}` : '',
      '',
      'Rules:',
      '- Output ONLY the raw file content. No explanations, no markdown fences.',
      '- Apply ONLY the requested change; preserve everything else exactly.',
      '- The result must be complete and immediately usable.',
    ].filter(Boolean).join('\n');
    const res = await ask([
      `Current content of "${p}":`,
      '────────',
      current.get(p).toString('utf8'),
      '────────',
      `Edit instruction:\n${instruction}`,
    ].join('\n'), system);
    if (res?.provider) providers.push(res.provider);

    const text = stripOuterFences(res?.text ?? '');
    if (!text) throw new ArtifactError('ARTIFACT_EDIT_EMPTY', `Editor produced empty content for "${p}"`);
    files.push({ path: p, buffer: Buffer.from(text, 'utf8'), mime: meta.mime });
    onEvent({ type: 'progress', progress: { stage: 'editing', path: p, index: idx, total: targets.length } });
  }

  return { files, providers, model: null, changed: targets };
}

// ── MODEL EDIT path ('slides' | 'document' | 'sheet') ─────────────────────────

async function editStructuredModel({ manifest, instruction, ask, onEvent }) {
  const exporter = getExporter(manifest.format);
  if (!manifest.model) {
    throw new ArtifactError('ARTIFACT_EDIT_NO_MODEL',
      `Artifact ${manifest.id} predates model persistence — regenerate it once, then edits work`);
  }
  const modelJson = JSON.stringify(manifest.model, null, 2);
  if (modelJson.length > MODEL_JSON_CAP) {
    throw new ArtifactError('ARTIFACT_EDIT_MODEL_TOO_LARGE', 'Content model too large for a bounded edit');
  }

  const system = [
    `You are AQUA's artifact editor. Apply the user's edit to the CONTENT MODEL of a ${manifest.format} artifact and return the COMPLETE updated model as a single JSON object.`,
    exporter.schemaHint ? `The JSON MUST keep exactly this shape:\n${exporter.schemaHint}` : '',
    '',
    'Rules:',
    '- Respond with the JSON object ONLY. No prose, no markdown fences.',
    '- Apply ONLY the requested change; every other value stays EXACTLY as it was.',
  ].filter(Boolean).join('\n');

  const doAsk = (extra = '') => ask([
    'Current content model:',
    modelJson,
    '',
    `Edit instruction:\n${instruction}`,
    extra,
  ].join('\n'), system);

  const first = await doAsk();
  let json = extractJson(first?.text ?? '');
  const providers = first?.provider ? [first.provider] : [];

  if (json == null) {
    const second = await doAsk('\nYour previous reply was NOT parseable JSON. Return the corrected JSON object only.');
    json = extractJson(second?.text ?? '');
    if (second?.provider) providers.push(second.provider);
    if (json == null) throw new ArtifactError('ARTIFACT_EDIT_INVALID', 'Editor produced unparseable model JSON twice');
  }

  onEvent({ type: 'progress', progress: { stage: 'editing', targets: ['model'], selectedBy: 'model' } });
  return { modelJsonRaw: json, providers };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Apply an edit instruction to an existing artifact → new version.
 *
 * @param {{
 *   artifactId: string, instruction: string,
 *   requestId?: string, conversationId?: string,
 *   onEvent?: (ev: object) => void, generate?: Function,
 * }} input
 * @returns {Promise<{ manifest: object, providers: string[], latencyMs: number, changed: string[] }>}
 */
export async function editArtifact({
  artifactId, instruction,
  requestId, conversationId,
  onEvent = () => {}, generate = generateText,
}) {
  const start = Date.now();
  const emit  = (ev) => { try { onEvent(ev); } catch { /* observers never break the pipeline */ } };

  const manifest = await getArtifact(artifactId);
  if (!manifest) throw new ArtifactError('ARTIFACT_NOT_FOUND', `No artifact ${artifactId}`);
  const exporter = getExporter(manifest.format);
  if (!exporter)  throw new ArtifactError('FORMAT_UNAVAILABLE', `No exporter for "${manifest.format}"`);

  emit({ type: 'stage', id: 'artifact_edit', label: 'Applying edit…' });

  let files, providers, newModel = null, changed;

  if (exporter.contentModel === 'files') {
    const ask = makeAsk({ requestId, conversationId, generate, taskType: 'coding', budget: EDIT_BUDGET });
    const r = await editFilesModel({ manifest, instruction, ask, onEvent: emit });
    ({ files, providers, changed } = r);
    // Exporter-level validation on the merged text model
    if (typeof exporter.validate === 'function') {
      const fv = exporter.validate({ files: files.map(f => ({ path: f.path, text: f.buffer.toString('utf8') })) });
      if (!fv.valid) throw new ArtifactError('ARTIFACT_EDIT_INVALID', `Edited files failed validation: ${fv.errors.slice(0, 5).join('; ')}`);
    }
  } else {
    const ask = makeAsk({ requestId, conversationId, generate, taskType: 'creative_writing', budget: EDIT_BUDGET });
    const { modelJsonRaw, providers: p } = await editStructuredModel({ manifest, instruction, ask, onEvent: emit });
    // Normalize through the exporter's own build-time shape: exporters accept
    // raw JSON in build(); for edit we reuse validate + export directly, so
    // run the raw JSON through the same normalize the exporter's build used —
    // exposed uniformly as exporter.build with a stub generateJson.
    newModel = await exporter.build({
      spec: manifest.spec,
      ctx: {},
      helpers: { generateJson: async () => modelJsonRaw, mapConcurrent: (i, f) => Promise.all(i.map(f)) },
    });
    if (typeof exporter.validate === 'function') {
      const fv = exporter.validate(newModel);
      if (!fv.valid) throw new ArtifactError('ARTIFACT_EDIT_INVALID', `Edited model failed validation: ${fv.errors.slice(0, 5).join('; ')}`);
    }
    ({ files } = await exporter.export(newModel, { spec: manifest.spec }));
    providers = p;
    changed = ['model'];
  }

  emit({ type: 'stage', id: 'artifact_validate', label: 'Validating new version…' });
  const gv = validateArtifactFiles(files, manifest.spec, exporter);
  if (!gv.valid) throw new ArtifactError('ARTIFACT_EDIT_INVALID', `New version failed validation: ${gv.errors.slice(0, 5).join('; ')}`);

  emit({ type: 'stage', id: 'artifact_store', label: 'Saving new version…' });
  const updated = await appendVersion(artifactId, { files, reason: instruction, model: newModel ?? undefined });

  return { manifest: updated, providers, latencyMs: Date.now() - start, changed };
}

/**
 * Regenerate an artifact (whole, or one file of a 'files' artifact) from
 * its stored spec — fresh content, same plan, new version.
 */
export async function regenerateArtifact({
  artifactId, path: onlyPath = null,
  requestId, conversationId,
  onEvent = () => {}, generate = generateText,
}) {
  const start = Date.now();
  const emit  = (ev) => { try { onEvent(ev); } catch { /* noop */ } };

  const manifest = await getArtifact(artifactId);
  if (!manifest) throw new ArtifactError('ARTIFACT_NOT_FOUND', `No artifact ${artifactId}`);
  const exporter = getExporter(manifest.format);
  if (!exporter)  throw new ArtifactError('FORMAT_UNAVAILABLE', `No exporter for "${manifest.format}"`);
  if (onlyPath && exporter.contentModel !== 'files') {
    throw new ArtifactError('ARTIFACT_REGEN_SCOPE', 'Single-file regeneration applies to text/project artifacts only');
  }
  if (onlyPath && !manifest.files.some(f => f.path === onlyPath)) {
    throw new ArtifactError('ARTIFACT_NOT_FOUND', `File "${onlyPath}" is not part of this artifact`);
  }

  emit({ type: 'stage', id: 'artifact_build', label: onlyPath ? `Regenerating ${onlyPath}…` : 'Regenerating artifact…' });

  const { buildArtifact } = await import('./builder.js');
  const spec = onlyPath
    ? { ...manifest.spec, files: manifest.spec.files.filter(f => f.path === onlyPath) }
    : manifest.spec;

  const { model, providers } = await buildArtifact({
    spec, exporter, contextBrief: '', requestId, conversationId, generate,
    onFileDone: (info) => emit({ type: 'progress', progress: { stage: 'building', ...info } }),
  });
  if (typeof exporter.validate === 'function') {
    const fv = exporter.validate(model);
    if (!fv.valid) throw new ArtifactError('ARTIFACT_BUILD_INVALID', `Regenerated content failed validation: ${fv.errors.slice(0, 5).join('; ')}`);
  }
  const exported = await exporter.export(model, { spec });

  // Single-file regen: merge fresh file into byte-identical copies of the rest.
  let files;
  if (onlyPath) {
    files = manifest.files.map(f => f.path === onlyPath
      ? exported.files.find(x => x.path === onlyPath) ?? exported.files[0]
      : { path: f.path, buffer: fs.readFileSync(getFileAbsolutePath(manifest, f.path)), mime: f.mime });
  } else {
    files = exported.files;
  }

  const gv = validateArtifactFiles(files, manifest.spec, exporter);
  if (!gv.valid) throw new ArtifactError('ARTIFACT_INVALID', `Regenerated version failed validation: ${gv.errors.slice(0, 5).join('; ')}`);

  const reason = onlyPath ? `regenerate ${onlyPath}` : 'regenerate';
  const updated = await appendVersion(artifactId, {
    files, reason,
    model: exporter.contentModel !== 'files' ? model : undefined,
  });

  return { manifest: updated, providers, latencyMs: Date.now() - start, changed: onlyPath ? [onlyPath] : files.map(f => f.path) };
}
