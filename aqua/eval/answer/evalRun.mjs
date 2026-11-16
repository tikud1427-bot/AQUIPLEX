/**
 * Zero-budget answer evaluation core (2026-11-11). Shared by scripts/answer-eval.mjs
 * (answer + judge) and scripts/answer-judge.mjs (drain the judging queue; merge).
 *
 * EVERY model request goes through the evaluation provider manager
 * (eval/providers/providerManager.mjs) — whose preflight makes verified free-tier
 * status mandatory — and through the pair runner (model lock, persistence,
 * resume, judge queue). There is no other request path in these scripts.
 *
 * On top of the manager's preflight, this module refuses (zeroBudgetGate):
 *   · production credentials of any kind (credentialSource must be 'evaluation';
 *     allowProductionCredentials must not be true);
 *   · reading credentials from the repository's .env or any file inside the
 *     repository (an evaluation credentials file lives outside it);
 *   · non-standard credentials: allowNonStandard must be empty, EXCEPT in
 *     credentialMode 'existing-numbered-pools' where each opted-in name must be a
 *     numbered GEMINI_KEY_<n> covered by credentialVerification { by, at, statement,
 *     envNames } (founder verification of the AQ.-prefixed values, 2026-11-11);
 *   · a benchmark dataset not allow-listed as synthetic;
 *   · --execute without AQUA_ANSWER_EVAL_APPROVED=yes; the live transport itself
 *     also requires AQUA_EVAL_LIVE_APPROVED=yes.
 *
 * Dry runs use a SYNTHETIC config, SYNTHETIC credentials and the mock transport:
 * nothing from process.env or .env is read, and nothing can reach the network.
 */
import { readFileSync, existsSync, realpathSync, openSync, writeSync, closeSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createManager } from '../providers/providerManager.mjs';
import { preflight, verifiedNonStandardNames } from '../providers/evalConfig.mjs';
import { mockTransport, liveTransport } from '../providers/transports.mjs';
import { runPairs } from '../providers/pairRunner.mjs';
import { judgePrompt, parseJudgement } from './judgeRunner.mjs';
import { gradeAnswer, aggregateGrades } from './answerGrader.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '../../..');

export class ZeroBudgetRefused extends Error {
  constructor(reasons) { super(`zero-budget gate refused:\n  - ${reasons.join('\n  - ')}`); this.name = 'ZeroBudgetRefused'; this.reasons = reasons; }
}

/** KEY=VALUE text → object (comments and blanks ignored). Values are never printed. */
export function parseEnvFile(text) {
  const env = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l.startsWith('#')) continue;
    const i = l.indexOf('=');
    if (i <= 0) continue;
    env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

/**
 * Real location of a path: symlinks and Windows junctions resolved (realpath of the nearest
 * existing ancestor, so a not-yet-existing file under a linked directory resolves too).
 * Without this, a link OUTSIDE the repository pointing INTO it would pass the check.
 */
export function realLocation(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try { return path.join(realpathSync.native(cur), ...tail); }
    catch { const parent = path.dirname(cur); if (parent === cur) return path.resolve(p); tail.unshift(path.basename(cur)); cur = parent; }
  }
}
/** Provider credential variable NAMES (production routing reads these from the process environment). */
export const PROVIDER_CREDENTIAL_VAR = /^(?:GEMINI_KEY_\d+|GEMINI_API_KEY|Gemini_API_Key|GROQ_API_KEY(?:_\d+)?|OPENROUTER_API_KEY(?:_\d+)?|NVIDIA_API_KEY(?:_\d+)?|ANTHROPIC_API_KEY|OPENAI_API_KEY|AQUA_EMBEDDING_API_KEY)$/;

export const insideRepo = file => { const rel = path.relative(realLocation(REPO_ROOT), realLocation(file)); return !rel.startsWith('..') && !path.isAbsolute(rel); };

/**
 * No production data, in dry runs and live runs alike: the pipeline that builds the
 * prompts must not reach a real database, the Mongo mirror or the real ~/.aquiplex store.
 * Returns refusal reasons (empty = safe).
 */
export function productionDataGuard(env = process.env, home = os.homedir()) {
  const r = [];
  if (String(env.DATABASE_URL ?? '').trim()) r.push('DATABASE_URL is set — unset it: evaluation never reaches a real database');
  for (const k of ['MONGO_URI', 'MONGODB_URI', 'MONGO_URL']) if (String(env[k] ?? '').trim()) r.push(`${k} is set — unset it: evaluation never reaches the Mongo mirror`);
  // The prompts are built by the PRODUCTION chat pipeline. With provider credentials in the process
  // environment, that pipeline could hold credentials for production routing. Evaluation credentials
  // are read only by the manager (from a file), so the process environment must carry none.
  const providerVars = Object.keys(env).filter(k => PROVIDER_CREDENTIAL_VAR.test(k) && String(env[k] ?? '').trim());
  if (providerVars.length) r.push(`provider credentials are present in the process environment (${providerVars.join(', ')}) — start the evaluation from a shell without them; the evaluation reads its credentials itself`);
  if (env.AQUA_DISABLE_MONGO_MIRROR !== '1') r.push('AQUA_DISABLE_MONGO_MIRROR must be 1 for evaluation');
  const real = realLocation(path.join(home, '.aquiplex'));
  const dataDir = env.AQUA_DATA_DIR ? realLocation(env.AQUA_DATA_DIR) : null;
  if (!dataDir) r.push('AQUA_DATA_DIR is not set — the evaluation data dir must be an isolated temporary directory');
  else { const rel = path.relative(real, dataDir); if (!rel.startsWith('..') && !path.isAbsolute(rel)) r.push('AQUA_DATA_DIR points at the real ~/.aquiplex store — refused'); }
  return r;
}

/** The integration's own refusals (the manager's preflight runs afterwards, in createManager). */
export function zeroBudgetGate({ execute, config, credentialsFile, configFile = null, datasetHash, env = process.env, now = Date.now() }) {
  const r = [];
  if (!execute) return;                                           // dry runs never touch real config or credentials
  // The approval switch is one MORE requirement. Nothing below is skipped when it is set.
  if (env.AQUA_ANSWER_EVAL_APPROVED !== 'yes') r.push('--execute needs AQUA_ANSWER_EVAL_APPROVED=yes (explicit, per-run approval)');
  if (!config) r.push('--provider-config <file> is required (evaluation provider configuration)');
  if (configFile && insideRepo(configFile)) r.push('the provider config must not be inside the repository (keep evaluation configuration with its credentials, outside)');
  const existingPools = config?.credentialMode === 'existing-numbered-pools';
  if (existingPools) {
    // Founder decision 2026-11-11: the existing NUMBERED production pools, read in memory from the
    // repository .env (the only source in this mode — a separate credentials file is refused so the
    // source is never ambiguous). Every other rule below still applies; the manager's preflight
    // additionally requires founderDecision, numbered-only keys and a per-run requestBudget.
    if (credentialsFile) r.push("--credentials-env is not used with credentialMode 'existing-numbered-pools' (credentials come only from the numbered variables of the repository .env)");
    if (config.credentialSource !== 'production') r.push("credentialMode 'existing-numbered-pools' requires credentialSource: 'production'");
    if (config.allowProductionCredentials !== true) r.push("credentialMode 'existing-numbered-pools' requires allowProductionCredentials: true");
    const fd = config.founderDecision;
    if (!fd?.by || !fd?.at || !fd?.statement) r.push('founderDecision { by, at, statement } is required for existing production key pools');
    // D-P2-5: production-usage safety check before EACH evaluation day. Recorded by the founder from
    // the provider console; dated today (UTC); the remaining daily quota must be at least TWICE the
    // largest group budget, so evaluation can take at most half of what production has left.
    const pc = config.productionUsageCheck;
    const today = new Date(now).toISOString().slice(0, 10);
    const maxGroup = Math.max(0, ...Object.values(config.tokenBudget?.group ?? {}).filter(Number.isInteger));
    if (!pc?.by || !pc?.method || pc?.date !== today) r.push(`productionUsageCheck { date: "${today}" (today, UTC), by, method, remainingDailyTokens } is required before each evaluation day`);
    else if (!(Number.isInteger(pc.remainingDailyTokens) && pc.remainingDailyTokens >= 2 * maxGroup)) r.push(`productionUsageCheck.remainingDailyTokens must be at least 2 × the largest group budget (${2 * maxGroup}); production keeps at least half of what remains today`);
  } else {
    if (!credentialsFile) r.push('--credentials-env <file> is required (an evaluation-only credentials file OUTSIDE the repository)');
    if (credentialsFile && insideRepo(credentialsFile)) r.push('the credentials file must not be inside the repository (the repository .env holds production credentials)');
    if (credentialsFile && path.basename(credentialsFile) === '.env' && path.resolve(path.dirname(credentialsFile)) === REPO_ROOT) r.push('the repository .env is never used for evaluation');
  }
  if (config) {
    if (!existingPools && config.credentialSource !== 'evaluation') r.push("credentialSource must be 'evaluation' (or use credentialMode 'existing-numbered-pools' with a recorded founder decision)");
    if (!existingPools && config.allowProductionCredentials === true) r.push('allowProductionCredentials must not be true outside existing-numbered-pools mode');
    const ns = config.allowNonStandard ?? [];
    if (ns.length && !existingPools) r.push("allowNonStandard must be empty: non-standard credentials (including the AQ.-prefixed Gemini values) are never used outside credentialMode 'existing-numbered-pools' with a recorded credentialVerification");
    if (ns.length && existingPools) {
      // Founder verification 2026-11-11: the AQ.-prefixed GEMINI_KEY_<n> are approved, but only
      // as a RECORDED verification that names each variable. No record → refused, as before.
      const covered = verifiedNonStandardNames(config);
      const uncovered = ns.filter(n => !covered.has(n));
      if (uncovered.length) r.push(`allowNonStandard: ${uncovered.join(', ')} not covered by credentialVerification { by, at, statement, envNames } — non-standard (AQ.-prefixed) credentials are never used for evaluation without a recorded founder verification (numbered GEMINI_KEY_<n> only)`);
    }
    if (!(config.syntheticDatasets ?? []).includes(datasetHash)) r.push('this benchmark dataset is not in syntheticDatasets');
    const a = config.models?.answer, j = config.models?.judge;
    if (a && j && a.provider === j.provider && a.model === j.model) r.push('the judge must be a different model from the answering model');
  }
  if (r.length) throw new ZeroBudgetRefused(r);
}

/**
 * Existing numbered pools: from the .env TEXT (read in memory, never copied or written),
 * keep ONLY GEMINI_KEY_<n> and GROQ_API_KEY_<n>. Every other variable — the unnumbered
 * production keys, database URLs, secrets of other services — never reaches the manager.
 */
export const NUMBERED_POOL = /^(?:GEMINI_KEY_\d+|GROQ_API_KEY_\d+)$/;
/**
 * One LIVE evaluation at a time (machine-wide). Request budgets and quota state live in one
 * process; two concurrent live runs would each spend their own budget against the same shared
 * quota group. Quota accounting is NOT shared across processes, so concurrency is refused.
 * A lock whose holder process is gone (crash) is reclaimed.
 */
export const DEFAULT_LOCK = path.join(os.tmpdir(), 'aquiplex-evaluation.lock');
export class RunLocked extends Error {
  constructor(holder) { super(`another live evaluation is running (pid ${holder?.pid ?? 'unknown'}, since ${holder?.at ?? 'unknown'}) — concurrent runs are refused because quota accounting is per process`); this.name = 'RunLocked'; this.holder = holder; }
}
const pidAlive = p => { try { process.kill(p, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export function acquireRunLock(lockFile = DEFAULT_LOCK, { pid = process.pid, isAlive = pidAlive } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockFile, 'wx');                         // exclusive create: atomic
      writeSync(fd, JSON.stringify({ pid, at: new Date().toISOString() }));
      closeSync(fd);
      return {
        release() { try { if (JSON.parse(readFileSync(lockFile, 'utf8')).pid === pid) unlinkSync(lockFile); } catch { /* already gone */ } },
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let holder = null;
      try { holder = JSON.parse(readFileSync(lockFile, 'utf8')); } catch { /* unreadable → treat as stale */ }
      if (holder?.pid && isAlive(holder.pid)) throw new RunLocked(holder);
      try { unlinkSync(lockFile); } catch { /* raced */ }            // stale: the holder is gone
    }
  }
  throw new RunLocked(null);
}

/** Env names the config explicitly authorises (listed in its quota domains). */
export function authorisedNames(config) { return [...new Set((config?.domains ?? []).flatMap(d => d.envNames ?? []))]; }

export function numberedPoolEnv(envText, authorised = null) {
  const all = parseEnvFile(envText);
  // With `authorised` (the env NAMES the config's quota domains list), only those numbered
  // variables are kept: an unlisted numbered key (e.g. the excluded AQ. Gemini values) never
  // even reaches the manager's memory.
  const allow = authorised ? new Set(authorised) : null;
  return Object.fromEntries(Object.entries(all).filter(([k]) => NUMBERED_POOL.test(k) && (!allow || allow.has(k))));
}

/** Synthetic dry-run configuration: fake credentials, mock transport only. */
export function dryRunSetup(datasetHash) {
  const env = { GROQ_API_KEY_1: `gsk_DRYRUN${'0'.repeat(24)}`, GEMINI_API_KEY: `AIza${'DRYRUN'.padEnd(35, '0')}` };
  const evidence = { method: 'synthetic dry run — mock transport, no network', by: 'answer-eval', at: '2026-11-11' };
  const config = {
    evaluationOnly: true, credentialSource: 'evaluation', allowProductionCredentials: false, allowNonStandard: [],
    syntheticDatasets: [datasetHash],
    models: { answer: { provider: 'groq', model: 'dry-run-answer-model', settings: { temperature: 0, max_tokens: 700 } }, judge: { provider: 'gemini', model: 'dry-run-judge-model', settings: { temperature: 0, max_tokens: 400 } } },
    domains: [
      { id: 'dry-groq', provider: 'groq', envNames: ['GROQ_API_KEY_1'], verification: evidence, billing: 'free-tier-verified', billingEvidence: evidence },
      { id: 'dry-gemini', provider: 'gemini', envNames: ['GEMINI_API_KEY'], verification: evidence, billing: 'free-tier-verified', billingEvidence: evidence },
    ],
  };
  const transport = mockTransport(call => ({ status: 200, text: call.provider === 'gemini' ? JSON.stringify({ factual_correctness: 1, grounding: 1, personalization: 1, temporal_accuracy: null, contradiction_handling: null, uncertainty: null, clarification_quality: 1, hallucination: false, hallucinated_claims: [], confidence: 0.5, notes: 'dry run' }) : 'DRY RUN ANSWER.', usage: { prompt_tokens: 0, completion_tokens: 0 } }));
  return { env, config, transport };
}

/** Real setup: config + credentials file, both gated. The live transport refuses without AQUA_EVAL_LIVE_APPROVED=yes. */
export function liveSetup({ configFile, credentialsFile, datasetHash, env = process.env, repoEnvPath = path.join(REPO_ROOT, '.env') }) {
  const config = configFile && existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : null;
  zeroBudgetGate({ execute: true, config, credentialsFile, configFile, datasetHash, env });
  const credEnv = config.credentialMode === 'existing-numbered-pools'
    ? numberedPoolEnv(readFileSync(repoEnvPath, 'utf8'), authorisedNames(config))   // tests inject a synthetic file; production: the repository .env
    : parseEnvFile(readFileSync(credentialsFile, 'utf8'));
  preflight(config, credEnv);          // free-tier verification BEFORE a live transport can exist
  return { env: credEnv, config, transport: liveTransport({ env }) };
}

/**
 * Build pair cases from an ACIB dataset. Prompts are built LAZILY by the real pipeline
 * (runScenario with capturePrompt), only for arms not yet answered.
 */
export function acibCases({ ds, datasetHash, scenarios, armEnvs, regime, label, runScenario }) {
  return scenarios.map(s => {
    const history = [...(s.history ?? []).map(h => h.text), ...(s.uploads ?? []).map(u => `[file] ${u.content}`)].join('\n');
    const arms = {};
    for (const [arm, armEnv] of Object.entries(armEnvs)) {
      arms[arm] = async () => {
        // 'very-long' (ACIB v3 secondary regime): the long mechanism with a larger filler target
        // (ds.veryLongFillerTargetChars, default 60,000 characters, per the v3 plan).
        const veryLong = regime === 'very-long';
        const built = await runScenario(s, { regime: veryLong ? 'long' : regime, filler: ds.filler, fillerTargetChars: veryLong ? (ds.veryLongFillerTargetChars ?? 60000) : ds.fillerTargetChars, userId: `answer-${label}-${arm}-${s.id}-${regime}`, env: armEnv, capturePrompt: true });
        return [{ role: 'system', content: built.prompt.system }, ...built.prompt.messages.filter(m => m.role !== 'system')];
      };
    }
    return { caseId: `${s.id}@${regime}`, datasetId: datasetHash, arms, judge: (_arm, answer) => [{ role: 'user', content: judgePrompt({ history, question: s.question, answer }) }], scenario: s, history };
  });
}

const readJsonl = f => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);

/** The four judge dimensions that apply to every scenario (the others may be null by design). */
export const CORE_JUDGE_DIMS = ['factual_correctness', 'grounding', 'personalization', 'clarification_quality'];
export const DEFAULT_REVIEW_SEED = 'aqua-review-v1';
const seededUnit = (seed, key) => crypto.createHash('sha256').update(`${seed}|${key}`).digest().readUInt32BE(0) / 2 ** 32;

/**
 * Un-blind from the pair store (the judge never saw arms), grade deterministically, queue reviews.
 * Human-review queue (every item names caseId, arm and reason):
 *   malformed:<error>       the judge reply did not parse or validate
 *   low-confidence          judge confidence < 0.6
 *   ah-disagreement         A and H of the same case got different verdicts (any core dimension or the
 *                           hallucination flag differs) — one item per case, both arms
 *   judge-vs-deterministic  judge factual correctness and the deterministic grade are 2+ levels apart
 *   random-audit            a seeded random sample (reviewSampleRate) of judgements NOT otherwise queued
 * The seed and rate are returned with the queue so the sample can be recomputed.
 */
export function mergeStore({ storeFile, ds, arms, reviewSampleRate = 0.1, reviewSeed = DEFAULT_REVIEW_SEED }) {
  const recs = readJsonl(storeFile);
  const byScenario = new Map(ds.scenarios.map(s => [s.id, s]));
  const answers = recs.filter(r => r.type === 'answer');
  const judgements = recs.filter(r => r.type === 'judgement');
  const review = [];
  const queued = new Set();
  const enqueue = item => { review.push(item); for (const a of String(item.arm).split('|')) queued.add(`${item.caseId}|${a}`); };
  const perArm = Object.fromEntries(arms.map(a => [a, { grades: [], judge: [] }]));
  const detFc = new Map();           // caseId|arm → deterministic factual correctness (0..1 or null)
  for (const a of answers) {
    const s = byScenario.get(a.caseId.split('@')[0]);
    if (!s || !perArm[a.arm]) continue;
    const sources = [...(s.history ?? []).map(h => h.text), ...(s.uploads ?? []).map(u => u.content)].join('\n');
    const g = gradeAnswer(s, a.text, { sources });
    perArm[a.arm].grades.push(g);
    detFc.set(`${a.caseId}|${a.arm}`, g.factual_correctness);
  }
  const parsed = new Map();          // caseId|arm → judge value
  for (const j of judgements) {
    const p = parseJudgement(j.text);
    if (!p.ok) { enqueue({ caseId: j.caseId, arm: j.arm, reason: `malformed:${p.error}`, judgeModel: j.judgeModel }); continue; }
    if (p.value.confidence < 0.6) enqueue({ caseId: j.caseId, arm: j.arm, reason: 'low-confidence', confidence: p.value.confidence });
    parsed.set(`${j.caseId}|${j.arm}`, p.value);
    perArm[j.arm]?.judge.push(p.value);
  }
  if (arms.length === 2) {
    for (const caseId of new Set(judgements.map(j => j.caseId))) {
      const a = parsed.get(`${caseId}|${arms[0]}`), h = parsed.get(`${caseId}|${arms[1]}`);
      if (!a || !h) continue;
      const dims = CORE_JUDGE_DIMS.filter(d => a[d] !== h[d]);
      if (dims.length || a.hallucination !== h.hallucination) enqueue({ caseId, arm: `${arms[0]}|${arms[1]}`, reason: 'ah-disagreement', dimensions: [...dims, ...(a.hallucination !== h.hallucination ? ['hallucination'] : [])] });
    }
  }
  for (const [k, v] of parsed) {
    const det = detFc.get(k);
    if (det != null && Math.abs(v.factual_correctness - det * 2) >= 2) { const [caseId, arm] = k.split('|'); enqueue({ caseId, arm, reason: 'judge-vs-deterministic', judge: v.factual_correctness, deterministic: det }); }
  }
  for (const k of parsed.keys()) {
    if (queued.has(k)) continue;
    if (seededUnit(reviewSeed, k) < reviewSampleRate) { const [caseId, arm] = k.split('|'); enqueue({ caseId, arm, reason: 'random-audit' }); }
  }
  const DIMS = ['factual_correctness', 'grounding', 'personalization', 'temporal_accuracy', 'contradiction_handling', 'uncertainty', 'clarification_quality'];
  const mean = (xs, d) => { const v = xs.map(x => x[d]).filter(x => x != null); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 1000) / 1000 : null; };
  const aggregates = Object.fromEntries(arms.map(a => [a, {
    answers: perArm[a].grades.length, deterministic: aggregateGrades(perArm[a].grades),
    judged: perArm[a].judge.length, judge: Object.fromEntries(DIMS.map(d => [d, mean(perArm[a].judge, d)])),
    hallucinationRate: perArm[a].judge.length ? perArm[a].judge.filter(j => j.hallucination).length / perArm[a].judge.length : null,
  }]));
  const models = { answer: [...new Set(answers.map(a => a.model))], judge: [...new Set(judgements.map(j => j.judgeModel))] };
  const reviewCounts = review.reduce((m, r) => { const k = r.reason.split(':')[0]; m[k] = (m[k] ?? 0) + 1; return m; }, {});
  return { aggregates, review, reviewSample: { rate: reviewSampleRate, seed: reviewSeed }, reviewCounts, models, counts: { answers: answers.length, judgements: judgements.length } };
}

/** Run (or resume) answering and/or judging through the manager. Returns a content-free record. */
export async function runEvaluation({ setup, cases, storeFile, arms, phases, managerOptions = {} }) {
  // managerOptions: tests inject a clock (now/sleep) to exercise pacing without real waits.
  const manager = createManager({ config: setup.config, env: setup.env, transport: setup.transport, ...managerOptions });   // preflight: free tier mandatory
  const r = await runPairs({ cases, manager, config: setup.config, storeFile, arms, phases });
  return {
    status: r.status, answered: r.answered, judged: r.judged, skipped: r.skipped, judgeQueued: r.judgeQueued, incomplete: r.incomplete,
    pausedAt: r.pausedAt, resumeAt: r.resumeAt, refused: r.refused, rejected: r.rejected ?? null, pauseReason: r.pauseReason ?? null, orderSeed: r.orderSeed,
    models: { answer: `${setup.config.models.answer.provider}/${setup.config.models.answer.model}`, judge: `${setup.config.models.judge.provider}/${setup.config.models.judge.model}` },
    usage: manager.summary(), quota: manager.state(),
  };
}
