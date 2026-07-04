/**
 * AQUA Adaptive Tool Orchestrator — Multi-Label Classifier
 *
 * Phase 6 spec, "Intelligent Task Classifier V2": a request may belong to
 * multiple categories, each with its own confidence score, e.g.
 *   "Build a scalable authentication system" → coding + architecture + security + planning
 *   "Compare PostgreSQL vs MongoDB"          → research + comparison + architecture
 *
 * This module does NOT replace classifier.js's classifyTask() — that
 * function's { task, confidence, labels } contract is used unchanged
 * everywhere else in the codebase (chat.js, executionPlanner.js,
 * promptBuilder.js, observability.js) and must keep working exactly as
 * before. Instead this is a thin additive layer on top of the same
 * underlying scores (via the newly-exported scoreTask()), adding:
 *   - normalized weights across all categories that clear a floor
 *   - derived cross-cutting tags (security/comparison) that aren't
 *     classifier.js task types but matter for capability selection
 *   - a single "dominant" pick, which is always identical to
 *     classifyTask(...).task by construction (same scores, same argmax)
 *
 * This is what lets one message drive several capabilities/profile
 * influences at once instead of forcing a single winner-take-all label.
 */
import { scoreTask } from '../core/classifier.js';

// Categories surfaced as multi-label "labels" — excludes purely
// conversational/meta buckets (conversation, memory_recall, memory_update,
// personal_info) which classifier.js already handles as exclusive winners
// and which don't meaningfully "co-occur" with a technical request.
const LABEL_CATEGORIES = [
  'coding', 'debugging', 'architecture', 'research', 'reasoning', 'analysis',
  'planning', 'creative_writing', 'project_query', 'file_analysis',
  'brainstorming', 'summarization', 'opinion', 'simple_qa',
];

// Cross-cutting tags: keyword groups that matter for capability/verification
// decisions but aren't classifier.js task categories in their own right.
// Spec examples explicitly ask for "security" and "comparison" as labels
// alongside coding/architecture/research.
const TAG_PATTERNS = {
  security: [
    /\b(auth(entication|orization)?|security|secure\b|encrypt|hash(ing)?|jwt|oauth|csrf|xss|sql\s*injection|vulnerabilit|exploit|sanitiz|rate.?limit|password|session\s+token)\b/i,
  ],
  comparison: [
    /\b(compare|comparison|versus\b|vs\.?\b|difference between|which is better|better than|pros and cons)\b/i,
  ],
  financial: [
    /\b(invoice|payment|billing|pricing|subscription|revenue|tax\b|currency|transaction\b|stripe|razorpay)\b/i,
  ],
  medical: [
    /\b(diagnos|symptom|medication|dosage|patient\b|clinical|treatment plan|medical record)\b/i,
  ],
};

const FLOOR = 0.15; // minimum normalized weight to be reported as a label

/**
 * @param {string} userMessage
 * @returns {{
 *   dominant: string,
 *   labels: { task: string, weight: number }[],
 *   tags: string[],
 *   raw: Object<string, number>
 * }}
 */
export function classifyMultiLabel(userMessage) {
  const raw = scoreTask(userMessage || '');
  const total = Object.values(raw).reduce((s, v) => s + v, 0);

  const labels = LABEL_CATEGORIES
    .map((task) => ({ task, weight: total > 0 ? raw[task] / total : 0 }))
    .filter((l) => l.weight >= FLOOR && raw[l.task] > 0)
    .sort((a, b) => b.weight - a.weight);

  const tags = Object.entries(TAG_PATTERNS)
    .filter(([, patterns]) => patterns.some((p) => p.test(userMessage || '')))
    .map(([tag]) => tag);

  const sortedRaw = Object.entries(raw).sort((a, b) => b[1] - a[1]);
  const dominant = sortedRaw[0] && sortedRaw[0][1] > 0 ? sortedRaw[0][0] : 'conversation';

  return { dominant, labels, tags, raw };
}
