/**
 * AQUA Mind — Prediction Engine (Layer 12)
 * ─────────────────────────────────────────────────────────────────────────────
 * Heuristic forecasts of the user's likely next needs, rebuilt after every
 * turn from working memory + goals + episode + belief profile. Predictions
 * are EPHEMERAL: they bias retrieval and appear in Mind View, but they are
 * never written into beliefs — only real evidence changes the model.
 */
import { CAPS, GOAL_STATUS } from './mindSchema.js';
import { currentFocus } from './workingMemory.js';
import { getActiveGoals } from './goalTracker.js';
import { touchMind } from './mindStore.js';
import { intentLabel } from '../memory/displayLabels.js';

const clamp = (x) => Math.min(0.97, Math.max(0.05, x));

export function rebuildPredictions(mind, { taskType = 'conversation', workspaceId = null } = {}) {
  const preds = [];
  const focus = currentFocus(mind, 4);
  const goals = getActiveGoals(mind, 4);
  const w = mind.working;

  // 1. Deadline pressure → prep/delivery help
  // A deadline that names something since changed is uncertain (memory/propagation.js): not predicted from.
  const deadline = w.deadlines.filter(d => !d.review).at(-1);
  if (deadline) {
    preds.push({
      label: `Likely preparing for: ${deadline.label}`,
      probability: clamp(0.6 + 0.1 * w.deadlines.length),
      basis: 'active deadline in working memory',
    });
  }

  // 2. Blockers → debugging / unblocking requests
  if (w.blockers.length) {
    preds.push({
      label: `Likely needs unblocking on: ${w.blockers[w.blockers.length - 1].text}`,
      probability: clamp(0.55 + 0.1 * w.blockers.length),
      basis: 'unresolved blocker',
    });
  }

  // 3. Task-type momentum — people continue what they were doing
  if (taskType === 'debugging') {
    preds.push({ label: 'Likely to continue debugging this issue', probability: 0.7, basis: 'current task momentum' });
  } else if (taskType === 'architecture') {
    preds.push({ label: 'Likely to request architecture / design advice', probability: 0.65, basis: 'current task momentum' });
  } else if (taskType === 'coding' || workspaceId) {
    preds.push({ label: 'Likely to request code changes in the active workspace', probability: 0.6, basis: 'coding momentum + attached workspace' });
  }

  // 4. Goal gravity — high-priority active goals attract related asks
  // Not from a plan the user has since changed: "Likely working toward: run a
  // marathon" after "I changed my goal: a half marathon" is a forecast built on
  // what is no longer true (goalTracker laterWordOnGoals).
  for (const g of goals.filter(x => !x.changedBy && !x.review).slice(0, 2)) {
    preds.push({
      label: `Likely working toward: ${g.title}`,
      probability: clamp(0.4 + 0.05 * g.mentions + 0.03 * g.priority),
      basis: `active goal (${g.mentions} mentions)`,
    });
  }

  // 5. Focus topics → likely subject matter (skip internal workspace: markers)
  // Internal intent ids (simple_qa, personal_info…) are routing, not subject
  // matter: "Next questions likely about: simple_qa" reached the page.
  const topicFocus = focus.filter(f => intentLabel(f.topic));
  if (topicFocus.length) {
    const top = topicFocus[0];
    preds.push({
      label: `Next questions likely about: ${intentLabel(top.topic)}`,
      probability: clamp(0.35 + Math.min(0.4, top.weight / 10)),
      basis: 'dominant working-memory focus',
    });
  }

  const deduped = [];
  for (const p of preds.sort((a, b) => b.probability - a.probability)) {
    if (!deduped.some(d => d.label === p.label)) deduped.push(p);
    if (deduped.length >= CAPS.PREDICTIONS) break;
  }

  mind.predictions = deduped.map(p => ({ ...p, probability: +p.probability.toFixed(2), ts: Date.now() }));
  touchMind(mind);
  return mind.predictions;
}
