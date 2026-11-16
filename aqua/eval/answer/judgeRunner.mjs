/**
 * Judge runner (Sprint 6, 2026-11-11) — the missing piece of the answer-level
 * evaluation (AQUA_ANSWER_EVALUATION_COST_REVIEW.md §1).
 *
 *   · reads the BLINDED requests (id, history, question, answer — no arm, no context)
 *   · asks the judge model with the rubric below; JSON only; schema-validated
 *   · a malformed reply is re-asked ONCE, then queued for human review (never dropped)
 *   · every result is appended to disk as it arrives → a run can RESUME
 *   · the spend ledger authorises every request (via the provider client)
 *   · un-blinding and review queues happen in `mergeJudgements`, after judging
 */
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { SpendCapReached } from './spendLedger.mjs';

export const JUDGE_SETTINGS = Object.freeze({ temperature: 0, max_tokens: 400 });

const DIMS = ['factual_correctness', 'grounding', 'personalization', 'temporal_accuracy', 'contradiction_handling', 'uncertainty', 'clarification_quality'];
const NULLABLE = new Set(['temporal_accuracy', 'contradiction_handling', 'uncertainty']);

/** The rubric prompt (judgeRubric.md, plus the `confidence` field proposed in Sprint 5). */
export function judgePrompt({ history, question, answer }) {
  return [
    'You are grading an assistant\'s answer to a user, given everything the user had previously told the assistant.',
    '',
    'USER HISTORY (oldest first; files are marked):', String(history ?? ''), '',
    'QUESTION:', String(question ?? ''), '',
    'ANSWER:', String(answer ?? ''), '',
    'Grade strictly from the history. Do not use outside knowledge about the user.',
    '- factual_correctness: 2 = every statement about the user matches the history; 1 = minor slip; 0 = a wrong fact about the user.',
    '- grounding: 2 = every user-specific claim can be traced to the history; 0 = claims not in the history.',
    '- personalization: 2 = uses the details that matter for this question; 1 = generic but correct; 0 = ignores relevant details or uses irrelevant personal details (on an impersonal question, any personal detail is irrelevant).',
    '- temporal_accuracy: null if nothing changed over time; 2 = uses the latest state; 0 = treats an outdated statement as current.',
    '- contradiction_handling: null if the history does not conflict; 2 = names the conflict and does not silently pick one; 0 = picks one silently.',
    '- uncertainty: null if nothing needed is missing; 2 = says what is unknown and does not invent it; 0 = invents a value.',
    '- clarification_quality: 2 = asks exactly one useful question when essential information is missing and none when it is not; 1 = too many or unhelpful questions; 0 = fails to ask when it must, or asks when it should not.',
    '- hallucination: true if ANY claim about the user, their numbers, people, dates or files is not supported by the history.',
    '- confidence: your confidence in this grading, 0 to 1.',
    '',
    'Return JSON only, exactly these keys: {"factual_correctness":0-2,"grounding":0-2,"personalization":0-2,"temporal_accuracy":0-2|null,"contradiction_handling":0-2|null,"uncertainty":0-2|null,"clarification_quality":0-2,"hallucination":true|false,"hallucinated_claims":["..."],"confidence":0-1,"notes":"one sentence"}',
  ].join('\n');
}

/** Parse and validate a judge reply. Returns { ok, value?, error? }. */
export function parseJudgement(text) {
  const s = String(text ?? '');
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, error: 'no-json' };
  let v; try { v = JSON.parse(m[0]); } catch { return { ok: false, error: 'invalid-json' }; }
  for (const d of DIMS) {
    const x = v[d];
    if (x === null && NULLABLE.has(d)) continue;
    if (![0, 1, 2].includes(x)) return { ok: false, error: `bad-${d}` };
  }
  if (typeof v.hallucination !== 'boolean') return { ok: false, error: 'bad-hallucination' };
  if (!Number.isFinite(v.confidence) || v.confidence < 0 || v.confidence > 1) return { ok: false, error: 'bad-confidence' };
  if (!Array.isArray(v.hallucinated_claims)) v.hallucinated_claims = [];
  return { ok: true, value: v };
}

const readJsonl = f => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);

/**
 * Judge every request not already in `outFile` (resume). Stops cleanly at the spend cap.
 * Returns { status: 'complete' | 'stopped-cap', judged, skipped, malformed }.
 */
export async function runJudge({ requests, outFile, client, judgeId = 'judge-1', log = () => {} }) {
  const done = new Set(readJsonl(outFile).filter(r => r.judge === judgeId).map(r => r.id));
  let judged = 0, skipped = 0, malformed = 0;
  for (const req of requests) {
    if (done.has(req.id)) { skipped++; continue; }
    try {
      const messages = [{ role: 'user', content: judgePrompt(req) }];
      let reply = await client.chat({ messages, settings: JUDGE_SETTINGS });
      let parsed = parseJudgement(reply.text);
      let attempts = 1;
      if (!parsed.ok) {   // one re-ask, then human review
        reply = await client.chat({ messages: [...messages, { role: 'assistant', content: reply.text }, { role: 'user', content: 'Return ONLY the JSON object with exactly the keys requested.' }], settings: JUDGE_SETTINGS });
        parsed = parseJudgement(reply.text); attempts = 2;
      }
      const row = parsed.ok
        ? { id: req.id, judge: judgeId, model: reply.model, status: 'ok', attempts, judgement: parsed.value }
        : { id: req.id, judge: judgeId, model: reply.model, status: 'malformed', attempts, error: parsed.error, review: 'malformed-json' };
      if (!parsed.ok) malformed++;
      appendFileSync(outFile, `${JSON.stringify(row)}\n`);
      judged++;
      log(`judged ${req.id} (${row.status})`);
    } catch (err) {
      if (err instanceof SpendCapReached) return { status: 'stopped-cap', judged, skipped, malformed, detail: err.detail };
      throw err;
    }
  }
  return { status: 'complete', judged, skipped, malformed };
}

/**
 * Un-blind and build review queues. `key` maps id → { scenario, arm, regime };
 * `rows` are the answer-eval rows (deterministic grades). Review queue:
 *   · malformed judge output
 *   · judge confidence < 0.6
 *   · two judges more than 1 point apart on any dimension
 *   · judge vs deterministic grade 2+ levels apart (judge 0–2 vs deterministic 0–1)
 */
export function mergeJudgements({ judgements, key, rows }) {
  const byId = new Map();
  for (const j of judgements) (byId.get(j.id) ?? byId.set(j.id, []).get(j.id)).push(j);
  const det = new Map(rows.map(r => [`${r.scenario}|${r.arm}|${r.regime}`, r.grades]));
  const merged = [];
  const review = [];
  for (const [id, list] of byId) {
    const k = key[id];
    if (!k) { review.push({ id, reason: 'no-key' }); continue; }
    const ok = list.filter(j => j.status === 'ok');
    for (const j of list) if (j.status !== 'ok') review.push({ id, ...k, reason: 'malformed', judge: j.judge });
    for (const j of ok) if (j.judgement.confidence < 0.6) review.push({ id, ...k, reason: 'low-confidence', judge: j.judge, confidence: j.judgement.confidence });
    if (ok.length >= 2) for (const d of DIMS) {
      const v = ok.map(j => j.judgement[d]).filter(x => x != null);
      if (v.length >= 2 && Math.max(...v) - Math.min(...v) > 1) review.push({ id, ...k, reason: `judges-disagree:${d}` });
    }
    const g = det.get(`${k.scenario}|${k.arm}|${k.regime}`);
    const j0 = ok[0]?.judgement;
    if (g && j0) {
      for (const [jd, dd] of [['factual_correctness', 'factual_correctness'], ['temporal_accuracy', 'temporal_accuracy'], ['contradiction_handling', 'contradiction_handling'], ['uncertainty', 'uncertainty_handling'], ['clarification_quality', 'clarification_quality']]) {
        if (j0[jd] == null || g[dd] == null) continue;
        if (Math.abs(j0[jd] / 2 - g[dd]) >= 0.75) review.push({ id, ...k, reason: `judge-vs-deterministic:${jd}`, judge: j0[jd], deterministic: g[dd] });
      }
    }
    merged.push({ id, ...k, judgements: ok.map(j => ({ judge: j.judge, ...j.judgement })) });
  }
  return { merged, review };
}

/** Per-arm means of judge dimensions (first judge), hallucination rate. */
export function aggregateJudge(merged) {
  const out = {};
  for (const arm of [...new Set(merged.map(m => m.arm))]) {
    const js = merged.filter(m => m.arm === arm && m.judgements[0]).map(m => m.judgements[0]);
    const mean = d => { const v = js.map(j => j[d]).filter(x => x != null); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 1000) / 1000 : null; };
    out[arm] = { n: js.length, ...Object.fromEntries(DIMS.map(d => [d, mean(d)])), hallucination_rate: js.length ? js.filter(j => j.hallucination).length / js.length : null };
  }
  return out;
}
