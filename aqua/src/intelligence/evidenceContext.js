/**
 * AQUA Internal Intelligence Engine — Evidence Context (Phase 0, audit F1/F3/F5)
 *
 * THE GROUNDING CONTRACT: no reviewer may judge a draft with less evidence
 * than the drafter had.
 *
 * Root cause this module exists to fix (audit §1): prepareTurn() grounds the
 * FIRST-pass model in attachment analyses (video/audio/image → Gemini text),
 * project context, web-search results, and memory — all injected into the
 * system prompt. The verification and debate agents then re-judged that
 * answer from `userMessage + draftAnswer` ALONE. A text-only critique model,
 * shown a detailed video description with zero evidence any video analysis
 * ever happened, correctly concludes "hallucination" under its rubric and
 * rewrites the answer to "I cannot watch videos" — which the `replace` event
 * then ships over the correct draft the user was already reading.
 *
 * Two exports, both pure (no I/O, no LLM):
 *
 *   composeEvidenceContext(parts) — one labeled block assembled from the
 *       exact context strings prepareTurn() already builds. Empty string when
 *       nothing is grounded, so ungrounded turns are byte-identical to
 *       pre-Phase-0 behavior at every call site.
 *
 *   isCapabilityRefusal(text) — detects "I cannot watch videos / read PDFs /
 *       view images"-class answers. Deliberately DISTINCT from
 *       identity/identityRouter.js isRefusal(): that detects knowledge
 *       hedging ("I don't know", "no verifiable source") on self-questions;
 *       this detects CAPABILITY DENIAL about files/media. Different failure,
 *       different guard, kept separate so tuning one can never regress the
 *       other.
 *
 * Consumed by verificationAgent.js and debateAgent.js (the only two
 * post-generation revisers) and threaded from chat.js prepareTurn().
 */

/** Order fixed and labeled — reviewers see evidence the way the drafter did. */
const SECTIONS = [
  ['attachmentContext', 'UPLOADED FILE ANALYSES'],
  ['projectContext',    'PROJECT / WORKSPACE CONTEXT'],
  ['searchContext',     'WEB SEARCH RESULTS'],
  ['memoryBlock',       'MEMORY CONTEXT'],
];

/**
 * Assemble the grounded-evidence block for reviewer prompts.
 *
 * @param {object} [parts]
 * @param {string} [parts.attachmentContext] - formatAttachmentsForPrompt() output
 * @param {string} [parts.projectContext]    - formatProjectContext() output
 * @param {string} [parts.searchContext]     - search contextBlock
 * @param {string} [parts.memoryBlock]       - memoryRetrieve() block
 * @returns {string} labeled block, or '' when no evidence exists
 */
export function composeEvidenceContext(parts = {}) {
  const blocks = [];
  for (const [key, label] of SECTIONS) {
    const v = typeof parts[key] === 'string' ? parts[key].trim() : '';
    if (v) blocks.push(`── ${label} ──\n${v}`);
  }
  return blocks.join('\n\n');
}

/** True when the turn had ANY grounded evidence — gates the refusal guard. */
export function hasGroundedEvidence(evidenceContext) {
  return typeof evidenceContext === 'string' && evidenceContext.trim().length > 0;
}

// ── Capability-refusal detection ──────────────────────────────────────────────
//
// Shape: [inability] + [perception/access verb] + [file/media noun] within a
// short span. Each half is anchored so ordinary sentences never match:
// "I can't verify this claim" (no media noun), "the video cannot be
// compressed further" (inability not first-person), "you cannot upload
// files over 20 MB" (second person) all pass through.

const INABILITY =
  String.raw`i\s*(?:'m|am)?\s*(?:can\s*not|cannot|can['’]?t|unable\s+to|not\s+able\s+to|don['’]?t\s+have\s+the\s+(?:ability|capability)\s+to|do\s+not\s+have\s+the\s+(?:ability|capability)\s+to|lack\s+the\s+ability\s+to)`;

const PERCEIVE =
  String.raw`(?:watch|view|see|look\s+at|open|access|read|analyz\w*|process|play|listen\s+to|hear|interpret|examine|understand|transcrib\w*)`;

const MEDIA_NOUN =
  String.raw`(?:videos?|images?|photos?|pictures?|screenshots?|audio(?:\s+files?)?|recordings?|voice\s+(?:notes?|memos?)|clips?|footage|files?|attachments?|documents?|pdfs?|spreadsheets?|media|uploads?)`;

const CAPABILITY_REFUSAL_PATTERNS = [
  // "I cannot watch videos" / "I'm unable to view the attached image"
  new RegExp(String.raw`\b${INABILITY}\s+(?:directly\s+|actually\s+)?${PERCEIVE}\b[^.!?\n]{0,40}?\b${MEDIA_NOUN}`, 'i'),
  // "As an AI(, I) ... cannot ... video|image|..." — the classic disclaimer
  new RegExp(String.raw`\bas\s+an?\s+(?:ai|text-based|language)\s*(?:model|assistant)?\b[^.!?\n]{0,80}?\b(?:can\s*not|cannot|can['’]?t|unable)\b[^.!?\n]{0,60}?\b${MEDIA_NOUN}`, 'i'),
  // "I do not have access to (the) video/files/attachments"
  new RegExp(String.raw`\bi\s+(?:do\s+not|don['’]?t)\s+have\s+(?:direct\s+)?access\s+to\b[^.!?\n]{0,40}?\b${MEDIA_NOUN}`, 'i'),
  // "no ability to watch/view/process video(s)"
  new RegExp(String.raw`\bno\s+(?:ability|way)\s+to\s+${PERCEIVE}\b[^.!?\n]{0,40}?\b${MEDIA_NOUN}`, 'i'),
];

/**
 * Does this text deny the ability to access/perceive user files or media?
 *
 * Checked against a REVISER's proposed replacement: when the turn was
 * grounded (hasGroundedEvidence), such a revision is by definition wrong —
 * the analyses exist in the prompt — and must be discarded, never shipped.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isCapabilityRefusal(text) {
  if (!text) return false;
  return CAPABILITY_REFUSAL_PATTERNS.some(re => re.test(text));
}

export { CAPABILITY_REFUSAL_PATTERNS as _capabilityRefusalPatterns };
