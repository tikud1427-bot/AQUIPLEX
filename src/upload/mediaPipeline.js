/**
 * AQUA Media Pipeline — Day 5
 *
 * Image / audio / video understanding via Gemini multimodal (the ONE
 * provider in the stack that accepts inline media). Every result is
 * normalized to the same document shape the rest of the platform uses,
 * so a screenshot and a PDF are indistinguishable to chat retrieval.
 *
 * Design decisions:
 * - Vision analysis + OCR happen in ONE model call (structured prompt
 *   asking for description + verbatim text + objects + chart/UI reading).
 *   Two calls would double latency and cost for zero quality gain.
 * - SVG short-circuits: it's already text — read the markup, no model call.
 * - Fail loudly: no Gemini keys / oversize media / unsupported codec each
 *   return a distinct, user-readable error. Never a silent drop.
 * - Results are content-hash cached (in-memory LRU) — re-uploading the same
 *   screenshot never pays for a second model call.
 */
import crypto from 'crypto';
import { analyzeMediaWithGemini } from '../providers/gemini.js';

// Gemini inline-data hard limit is ~20 MB of request payload; base64 inflates
// 4/3 — stay safely under.
const MAX_IMAGE_BYTES = 12_000_000;
const MAX_AV_BYTES    = 14_000_000;
const MAX_SVG_BYTES   = 2_000_000;

// ── Result cache (content-addressed) ──────────────────────────────────────────

const CACHE_MAX = 100;
const cache = new Map(); // sha256 → result

function cacheKey(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function cacheGet(key)      { return cache.get(key) ?? null; }
function cacheSet(key, val) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value); // FIFO evict
  cache.set(key, val);
}

// ── Prompts ───────────────────────────────────────────────────────────────────

const IMAGE_PROMPT = `Analyze this image thoroughly. Respond in exactly this structure:

CAPTION: one-sentence description.

DESCRIPTION: detailed description of what the image shows — layout, subjects, colors, context.

TEXT (OCR): every piece of readable text in the image, verbatim, preserving structure. Write "none" if there is no text.

OBJECTS: comma-separated list of notable objects/elements.

SPECIAL: if this is a screenshot, describe the UI (app, screen, controls, state). If it is a chart/graph, read out the data. If it is a diagram or architecture drawing, explain the components and their relationships. Otherwise write "n/a".`;

const AUDIO_PROMPT = `Analyze this audio. Respond in exactly this structure:

SUMMARY: one-paragraph summary of the audio content.

TRANSCRIPT: full transcription of any speech, verbatim. Write "none" if there is no speech.

DETAILS: speakers, tone, music, notable sounds, approximate structure.`;

const VIDEO_PROMPT = `Analyze this video. Respond in exactly this structure:

SUMMARY: one-paragraph summary of what happens.

TRANSCRIPT: transcription of any speech, verbatim. Write "none" if there is no speech.

SCENES: chronological outline of key scenes/moments.

TEXT ON SCREEN: any readable on-screen text. Write "none" if there is none.`;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * @param {string} filename
 * @param {Buffer} buffer
 * @param {string} mime   - from uploadClassifier
 * @param {'image'|'audio'|'video'} kind
 * @returns {Promise<{ title, format, metadata, content, pages, sections, language, truncated }>}
 */
export async function processMedia(filename, buffer, mime, kind) {
  // SVG is text — no model call needed, but still normalize.
  if (mime === 'image/svg+xml') {
    if (buffer.length > MAX_SVG_BYTES) throw new Error('SVG exceeds the 2 MB limit');
    const markup = buffer.toString('utf8');
    const textNodes = [...markup.matchAll(/<(?:text|tspan)[^>]*>([^<]+)</g)].map(m => m[1].trim()).filter(Boolean);
    const content = [
      `SVG vector image "${filename}" (${buffer.length} bytes).`,
      textNodes.length ? `Text in SVG: ${textNodes.join(' | ')}` : 'No text elements.',
      '',
      'Raw SVG markup (truncated to 20 KB):',
      markup.slice(0, 20_000),
    ].join('\n');
    return normalize(filename, 'svg', { analyzed: false }, content);
  }

  const limit = kind === 'image' ? MAX_IMAGE_BYTES : MAX_AV_BYTES;
  if (buffer.length > limit) {
    throw new Error(`${kind === 'image' ? 'Image' : kind === 'audio' ? 'Audio file' : 'Video'} exceeds the ${Math.round(limit / 1e6)} MB analysis limit (${(buffer.length / 1e6).toFixed(1)} MB). Compress it and retry.`);
  }

  const key = cacheKey(buffer);
  const cached = cacheGet(key);
  if (cached) {
    console.log(`[UPLOAD] Media analysis cache hit ${filename}`);
    return cached;
  }

  const prompt = kind === 'image' ? IMAGE_PROMPT : kind === 'audio' ? AUDIO_PROMPT : VIDEO_PROMPT;

  const parts = [
    { inlineData: { mimeType: mime, data: buffer.toString('base64') } },
    { text: prompt },
  ];

  let analysis;
  try {
    analysis = await analyzeMediaWithGemini(parts, {
      systemPrompt: 'You are a precise media analysis engine. Follow the requested structure exactly. Transcribe text verbatim.',
      maxTokens: kind === 'image' ? 2048 : 4096,
    });
  } catch (err) {
    throw new Error(`${kind[0].toUpperCase() + kind.slice(1)} analysis failed: ${err.message}`);
  }

  const result = normalize(
    filename,
    mime.split('/')[1] ?? kind,
    { analyzed: true, model: analysis.model, bytes: buffer.length },
    analysis.text,
  );
  cacheSet(key, result);
  return result;
}

function normalize(filename, format, metadata, content) {
  const sections = content
    .split(/\n(?=[A-Z][A-Z ()]+:)/)
    .map(chunk => {
      const m = chunk.match(/^([A-Z][A-Z ()]+):\s*([\s\S]*)$/);
      return m ? { heading: m[1].trim(), text: m[2].trim() } : { heading: null, text: chunk.trim() };
    })
    .filter(s => s.text);

  return {
    title:     filename,
    format,
    metadata,
    content,
    pages:     null,
    sections,
    language:  null,
    truncated: false,
  };
}
