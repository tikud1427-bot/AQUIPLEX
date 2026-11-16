/**
 * A/B pair runner on the evaluation provider manager (2026-11-11).
 *
 *   · A and B of a case are answered by the SAME model with the SAME settings.
 *     The model is locked per pair on its first answer; a resumed pair under a
 *     different configured model is refused (never mixed).
 *   · Every completed answer and judgement is appended to a JSONL store at once;
 *     completed work is never requested again (idempotency key per request).
 *   · Answer-provider quota exhausted → the pair pauses; the run returns
 *     `paused` with the resume time. Re-running later resumes where it stopped.
 *   · Judge-provider exhausted → completed pairs are QUEUED for judging; answering
 *     continues. The judge's provider and model are recorded per judgement.
 *   · Billing or unknown errors stop the run (the manager enforces this).
 *
 * `cases`: [{ caseId, datasetId, arms: { A: messages[], B: messages[] }, judge?: (arm, answer) => messages[] }]
 * — prompts are built by the caller from SYNTHETIC benchmark data only.
 */
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';
import { QuotaPaused, BillingStop, ReviewRequired, RequestRejected } from './providerManager.mjs';

const sha = x => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 16);
/**
 * Prompt hash with the per-build random UNTRUSTED-CONTENT delimiter normalised. Two arms whose
 * prompts hash equal here received the SAME context (verified: arm A built twice → 100/100 equal).
 * Used by the paired analysis to separate unchanged-prompt cases (model-noise control).
 */
export const normalisedPromptHash = messages => sha(JSON.parse(JSON.stringify(messages).replace(/UNTRUSTED-CONTENT [A-Za-z0-9_-]+/g, 'UNTRUSTED-CONTENT N')));
/**
 * Reproducible arm order per case: sha256(seed | caseId) decides whether the two arms run in the
 * given or the swapped order (answering AND judging). The seed is recorded with every answer and
 * in the run result, so the order of any run can be recomputed.
 */
export const DEFAULT_ORDER_SEED = 'aqua-eval-order-v1';
export function armOrder(arms, caseId, seed = DEFAULT_ORDER_SEED) {
  const b = crypto.createHash('sha256').update(`${seed}|${caseId}`).digest()[0];
  return b & 1 ? [arms[1], arms[0]] : [arms[0], arms[1]];
}
const readJsonl = f => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);

export class ModelMismatch extends Error { constructor(caseId, locked, configured) { super(`pair ${caseId} was started with ${locked}; configured ${configured} — refusing to mix models in one pair`); this.name = 'ModelMismatch'; } }

/**
 * Options (Sprint-7 integration additions, backward compatible):
 *   arms     the two arms of a pair (default ['A','B']); the store records each arm's name
 *   phases   ['answer','judge'] (default) or ['judge'] (drain the judging queue only)
 * `c.arms[arm]` may be the messages array, or a function returning it (built lazily, only
 * for arms not yet answered). The no-duplicates key is case|arm|model|settings — NOT the
 * prompt: a prompt rebuilt on a later day (dates in the context) must not cause a completed
 * answer to be regenerated. The prompt's hash is stored with the answer as metadata.
 */
export async function runPairs({ cases, manager, config, storeFile, arms = ['A', 'B'], phases = ['answer', 'judge'] }) {
  if (arms.length !== 2 || arms[0] === arms[1]) throw new Error('a pair has exactly two different arms');
  const answerModel = `${config.models.answer.provider}/${config.models.answer.model}`;
  const judgeModel = `${config.models.judge.provider}/${config.models.judge.model}`;
  const settingsHash = sha(config.models.answer.settings ?? {});
  const store = readJsonl(storeFile);
  const has = (type, key) => store.some(r => r.type === type && r.key === key);
  const put = rec => { store.push(rec); appendFileSync(storeFile, `${JSON.stringify(rec)}\n`); };
  const orderSeed = config.orderSeed ?? DEFAULT_ORDER_SEED;
  const result = { status: 'complete', answered: 0, judged: 0, skipped: 0, judgeQueued: [], pausedAt: null, resumeAt: null, refused: [], incomplete: [], orderSeed };
  let answeringPaused = !phases.includes('answer'), judgingPaused = !phases.includes('judge');

  for (const c of cases) {
    // Model lock: the model of any answer already stored for this pair.
    const prior = store.find(r => r.type === 'answer' && r.caseId === c.caseId);
    if (prior && prior.model !== answerModel) { result.refused.push({ caseId: c.caseId, reason: 'model-mismatch', locked: prior.model }); continue; }
    const answers = {};
    const order = armOrder(arms, c.caseId, orderSeed);   // reproducible per case; recorded below
    for (const arm of order) {
      const key = `${c.caseId}|${arm}|${answerModel}|${settingsHash}`;
      const done = store.find(r => r.type === 'answer' && r.key === key);
      if (done) { answers[arm] = done; result.skipped++; continue; }
      if (answeringPaused) continue;
      try {
        const messages = typeof c.arms[arm] === 'function' ? await c.arms[arm]() : c.arms[arm];
        const r = await manager.request({ role: 'answer', caseId: c.caseId, datasetId: c.datasetId, messages, settings: config.models.answer.settings });
        const rec = { type: 'answer', key, caseId: c.caseId, arm, model: answerModel, settingsHash, promptHash: sha(messages), promptHashNormalised: normalisedPromptHash(messages), armOrder: order, orderSeed, envName: r.envName, domain: r.domain, text: r.text, usage: r.usage, at: new Date().toISOString() };
        put(rec); answers[arm] = rec; result.answered++;
      } catch (err) {
        if (err instanceof QuotaPaused) { answeringPaused = true; result.status = 'paused'; result.pausedAt = c.caseId; result.resumeAt = err.resumeAt; result.pauseReason = err.detail?.reason ?? 'quota'; break; }
        if (err instanceof BillingStop || err instanceof ReviewRequired) { result.status = err.name === 'BillingStop' ? 'stopped-billing' : 'stopped-review'; return result; }
        if (err instanceof RequestRejected) { result.status = 'stopped-rejected'; result.rejected = err.detail; return result; }   // over the size limit: nothing sent, fix the config
        throw err;
      }
    }
    if (!arms.every(a => answers[a])) { result.incomplete.push(c.caseId); continue; }   // judge only complete pairs
    for (const arm of order) {
      const jkey = `${answers[arm].key}|judge|${judgeModel}`;
      if (has('judgement', jkey)) { result.skipped++; continue; }
      if (judgingPaused || !c.judge) { if (c.judge) result.judgeQueued.push(c.caseId); continue; }
      try {
        const r = await manager.request({ role: 'judge', caseId: c.caseId, datasetId: c.datasetId, messages: c.judge(arm, answers[arm].text), settings: config.models.judge.settings });
        put({ type: 'judgement', key: jkey, caseId: c.caseId, arm, judgeModel, answerModel, envName: r.envName, domain: r.domain, text: r.text, usage: r.usage, at: new Date().toISOString() });
        result.judged++;
      } catch (err) {
        if (err instanceof QuotaPaused) { judgingPaused = true; result.judgeQueued.push(c.caseId); continue; }   // answering continues
        if (err instanceof BillingStop || err instanceof ReviewRequired) { result.status = err.name === 'BillingStop' ? 'stopped-billing' : 'stopped-review'; return result; }
        if (err instanceof RequestRejected) { result.status = 'stopped-rejected'; result.rejected = err.detail; return result; }   // over the size limit: nothing sent, fix the config
        throw err;
      }
    }
  }
  result.judgeQueued = [...new Set(result.judgeQueued)];
  if (result.status === 'complete' && result.judgeQueued.length) result.status = 'complete-judging-queued';
  return result;
}
