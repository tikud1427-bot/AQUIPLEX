/**
 * AQUA Continuation Intent (Memory 5.0, Phase F — predictive memory fast-path)
 * ─────────────────────────────────────────────────────────────────────────────
 * "Let's continue." carries zero retrievable tokens — yet it is the single
 * clearest signal that the user wants the SYSTEM to know where they were.
 * This detector lets memoryRetrieve treat it as such: the latest episode
 * surfaces even with no token overlap, and workspace/file memory is treated
 * as in-intent, so the model resumes with project, files, goals and blockers
 * already in context — without asking.
 *
 * Deliberately anchored and conservative: "continue the story about dragons"
 * is a CONTENT request that names its own subject — the normal lanes handle
 * it; the fast-path must not hijack it. Matches only when the message is
 * essentially just the continuation phrase plus a tiny courteous tail
 * ("please", "now", "from there").
 */

// One body expression, two anchored regexes built from it — no source-string
// surgery, so the pair can never drift apart.
const BODY =
  "(?:ok(?:ay)?[,.!\\s]+|so[,\\s]+)?" +
  "(?:let'?s\\s+|shall\\s+we\\s+)?" +
  '(?:continue|resume|carry\\s+on|keep\\s+going|' +
  'pick\\s+up\\s+where\\s+(?:we|i)\\s+left\\s+off|' +
  'where\\s+(?:were|was)\\s+(?:we|i)|back\\s+to\\s+(?:it|work))\\b';

const FULL_RE = new RegExp(`^\\s*${BODY}[\\s.!?]*$`, 'i');
const HEAD_RE = new RegExp(`^\\s*${BODY}`, 'i');
const TAIL_OK_RE = /^[\s,]*(?:please|now|then|from\s+there)?[\s.!?]*$/i;

/**
 * @param {string} message
 * @returns {boolean} true when the message is a bare continuation request.
 */
export function detectContinuation(message) {
  const msg = String(message || '');
  if (FULL_RE.test(msg)) return true;
  const m = msg.match(HEAD_RE);
  if (!m) return false;
  return TAIL_OK_RE.test(msg.slice(m[0].length));
}
