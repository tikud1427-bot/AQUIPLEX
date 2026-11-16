/**
 * ACIB v1 — drive the PRODUCTION pipeline for one scenario and capture what
 * each context lane put in front of the model (2026-11-10).
 *
 * Write path, per history message, exactly as routes/chat.js does it minus the
 * model call: prepareTurn (observation + retrieval) → persist the user message
 * → commit the turn's memory (memory/turnCommit.js) → persist an assistant
 * reply → runPostTurn. A message marked `fail` stops where a failed request
 * stops: prepareTurn ran, nothing was persisted, the route's `finally` rolled
 * the turn back. Uploads go through the real POST /upload route on loopback.
 *
 * Read path: prepareTurn for the question in a NEW conversation — its
 * memoryBlock, knowledgeContext and recall block are the personal context the
 * model would receive. No model is called (skipReasoningPass, and nothing
 * calls generate). Every non-loopback network attempt is blocked and counted.
 *
 * Callers must have isolated AQUA_DATA_DIR before importing this module
 * (eval/core/isolateDataDir.mjs) and set AQUA_EMBEDDINGS=off.
 */
import http from 'node:http';
import https from 'node:https';

// ── Network guard: loopback only (the upload route), everything else refused ──
export const network = { blocked: 0, hosts: new Set() };
const isLoopback = h => /^(127\.|localhost$|::1$|\[::1\])/.test(String(h ?? ''));
const realFetch = globalThis.fetch;
const realRequest = new Map([[http, http.request], [https, https.request]]);
/** Installed only while a scenario runs, so other suites in the same process are unaffected. */
function guardNetwork() {
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (!isLoopback(url.hostname)) {
      network.blocked++; network.hosts.add(url.hostname);
      throw new Error(`ACIB network guard: ${url.hostname} refused (benchmarks make no external calls)`);
    }
    return realFetch(input, init);
  };
  for (const [mod, orig] of realRequest) {
    mod.request = function guarded(opts, ...rest) {
      const host = typeof opts === 'string' ? new URL(opts).hostname : (opts instanceof URL ? opts.hostname : (opts?.hostname ?? opts?.host ?? 'localhost'));
      if (!isLoopback(host)) { network.blocked++; network.hosts.add(String(host)); throw new Error(`ACIB network guard: ${host} refused`); }
      return orig.call(this, opts, ...rest);
    };
  }
}
function unguardNetwork() {
  globalThis.fetch = realFetch;
  for (const [mod, orig] of realRequest) mod.request = orig;
}

const quiet = async fn => {
  const saved = { log: console.log, warn: console.warn, info: console.info, debug: console.debug };
  console.log = console.warn = console.info = console.debug = () => {};
  try { return await fn(); } finally { Object.assign(console, saved); }
};

let M = null;
async function modules() {
  if (M) return M;
  M = await quiet(async () => {
    const chat = await import('../../src/routes/chat.js');
    const obs = await import('../../src/core/observability.js');
    const cost = await import('../../src/core/costAccounting.js');
    const conv = await import('../../src/memory/conversationStore.js');
    const txn = await import('../../src/memory/turnCommit.js');
    const post = await import('../../src/routes/turnPostProcess.js');
    const jobs = await import('../../src/core/jobs/jobRegistry.js');
    const upload = await import('../../src/routes/upload.js');
    const qp = await import('../../src/brain/contextEngine/queryPlan.js');
    const flags = await import('../../src/core/flags.js');
    const express = (await import('express')).default;
    return { chat, obs, cost, conv, txn, post, jobs, upload, qp, flags, express };
  });
  return M;
}

let uploadServer = null;
async function uploadBase() {
  const { express, upload } = await modules();
  if (uploadServer) return uploadServer.base;
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use((req, _res, next) => { req.aquaUserId = req.headers['x-acib-user']; next(); });
  app.use('/upload', upload.default);
  const server = app.listen(0);
  server.unref();
  uploadServer = { server, base: `http://127.0.0.1:${server.address().port}` };
  return uploadServer.base;
}

/** Close the loopback upload server (end of run). */
export function closeAcib() { try { uploadServer?.server.close(); } catch { /* already closed */ } uploadServer = null; }

async function prepare(userId, conversationId, text) {
  const { chat, obs, cost, conv } = await modules();
  const { id } = conv.getOrCreateConversation(conversationId, { userId });
  const ctx = obs.createContext({ conversationId: id, requestId: `acib-${Math.random().toString(36).slice(2)}` });
  ctx.costLedger = cost.createTurnLedger();
  const prep = await chat.prepareTurn({ userMessage: text, workspaceId: null, conversationId: id, userId, ctx, requestId: ctx.requestId, skipReasoningPass: true });
  return { prep, ctx, conversationId: id };
}

/** One history message through the production write path. */
async function writeTurn(userId, conversationId, text, { fail = false } = {}) {
  const { conv, txn, post, chat } = await modules();
  const { prep, ctx, conversationId: id } = await prepare(userId, conversationId, text);
  if (fail) {
    // A failed request: nothing persisted; the route's finally rolls the turn back.
    txn.rollbackTurnMemory(ctx.memoryTxn, { reason: 'acib-failed-turn' });
    return;
  }
  conv.addMessage(id, 'user', text);
  txn.commitTurnMemory(ctx.memoryTxn);
  const answer = 'Noted.';
  conv.addMessage(id, 'assistant', answer);
  post.runPostTurn({ ownerId: prep.memoryOwner, conversationId: id, ...chat.memoryWriteTurn(prep, answer), taskType: prep.taskType, workspaceId: null });
}

async function uploadFiles(userId, files) {
  const base = await uploadBase();
  for (const f of files) {
    const r = await realFetch(`${base}/upload`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-acib-user': userId },
      body: JSON.stringify({ conversationId: `${userId}-${f.conv}`, files: [{ name: f.name, content: Buffer.from(f.content).toString('base64') }] }),
    });
    if (!r.ok) throw new Error(`upload failed (${r.status})`);
  }
}

/** Deterministic filler until the user's own words exceed `targetChars`. */
function fillerPlan(scenario, filler, targetChars) {
  const said = (scenario.history ?? []).filter(m => !m.fail).reduce((n, m) => n + m.text.length, 0);
  const out = [];
  let chars = said, i = 0;
  while (chars <= targetChars) { const t = filler[i % filler.length]; out.push(t); chars += t.length; i++; }
  return out;
}

/**
 * Run one scenario in one regime. Returns the personal context each arm sent,
 * the question plan, and run diagnostics. `userId` must be unique per call.
 */
export async function runScenario(scenario, { regime, filler, fillerTargetChars, userId, env = {}, ...opts }) {
  const m = await modules();
  guardNetwork();
  // The arm's configuration, applied only for this run and restored after it (Sprint 3).
  const savedEnv = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  try { return await quiet(async () => {
    const blockedBefore = network.blocked;
    // 1. History, oldest first. Uploads first (documents the user already had).
    if (scenario.uploads?.length) await uploadFiles(userId, scenario.uploads);
    for (const msg of scenario.history ?? []) {
      await writeTurn(userId, `${userId}-${msg.conv}`, msg.text, { fail: !!msg.fail });
    }
    // 1b. A long single conversation (long-history scenario), both regimes.
    const inline = filler.slice(0, scenario.inlineFiller ?? 0);
    for (const t of inline) await writeTurn(userId, `${userId}-c1`, t);
    // 2. Long regime: later conversations about other things.
    if (regime === 'long') {
      const plan = fillerPlan({ history: [...(scenario.history ?? []), ...inline.map(text => ({ text }))] }, filler, fillerTargetChars);
      for (const [i, t] of plan.entries()) await writeTurn(userId, `${userId}-f${Math.floor(i / 5)}`, t);
    }
    await m.jobs.drainJobs(10_000);
    // 3. The question, in a new conversation.
    const q0 = process.hrtime.bigint();
    const { prep, ctx } = await prepare(userId, `${userId}-question`, scenario.question);
    const questionMs = Number(process.hrtime.bigint() - q0) / 1e6;
    m.txn.rollbackTurnMemory(ctx.memoryTxn, { reason: 'acib-question-only' });   // the question is not persisted
    // Sprint 6 hybrid context: its block sits after the recall excerpts in the prompt. It is
    // scored by the SAME frozen parsers, each line once: notes ("- Conflict…", "- Not known…")
    // are read by memoryItems (a "--- NEEDS CHECK ---" section) and quotes ("[date · …]") by
    // recallItems. Without a hybrid block nothing here changes (historical runs reproduce).
    const hybridBlock = extractHybridBlock(prep.systemPrompt);
    const recallBlock = hybridBlock ? extractRecallBlock(prep.systemPrompt).replace(hybridBlock, '') : extractRecallBlock(prep.systemPrompt);
    const plan = m.qp.buildQueryPlan(scenario.question, { taskType: prep.taskType });
    return {
      taskType: prep.taskType,
      confidence: prep.confidence,
      readMode: prep.readState?.mode ?? null,
      blocks: hybridBlock
        ? { memory: [prep.memoryBlock ?? '', hybridBlock].filter(Boolean).join('\n'), knowledge: prep.knowledgeContext ?? '', recall: [recallBlock, hybridBlock].filter(Boolean).join('\n') }
        : { memory: prep.memoryBlock ?? '', knowledge: prep.knowledgeContext ?? '', recall: recallBlock },
      hybridTokens: hybridBlock ? Math.ceil(hybridBlock.length / 4) : 0,
      promptTokens: prep.promptTokens,
      planner: { taskType: plan.taskType, slots: plan.slots.map(s => s.id), required: plan.requiredSlotIds },
      networkBlocked: network.blocked - blockedBefore,
      questionMs: Math.round(questionMs * 10) / 10,
      infoNeeds: prep.infoNeeds?.summary ?? null,
      // Sprint 4 answer-level evaluation: the exact prompt the route would send (opt-in;
      // ACIB records never carry it).
      ...(opts.capturePrompt ? { prompt: { system: prep.systemPrompt ?? '', messages: prep.messages ?? [] } } : {}),
    };
  }); } finally {
    unguardNetwork();
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

/** The hybrid context block (Sprint 6) as rendered in the system prompt, or ''. */
export function extractHybridBlock(systemPrompt) {
  const m = String(systemPrompt ?? '').match(/--- NEEDS CHECK \(added after the context above; it does not replace it\) ---[\s\S]*?--- END NEEDS CHECK ---/);
  return m ? m[0] : '';
}

/** The recall block as rendered inside the system prompt (between its UNTRUSTED fence). */
export function extractRecallBlock(systemPrompt) {
  const s = String(systemPrompt ?? '');
  const i = s.indexOf('WHAT THE USER TOLD YOU BEFORE');
  if (i < 0) return '';
  const end = s.indexOf('<<<END-UNTRUSTED', i);
  return s.slice(i, end < 0 ? undefined : end);
}

/**
 * Gates that cannot change what the pipeline retrieves: the durable mirror
 * (isolation REQUIRES it off) and logging. Every other override makes a run
 * incomparable with a code-default baseline.
 */
const CONTEXT_NEUTRAL = new Set(['AQUA_DISABLE_MONGO_MIRROR', 'AQUA_LOG_CONTENT', 'AQUA_PROVIDER_LOG']);

/** Which context-relevant gates differ from their code default in this process (empty = comparable). */
export async function nonDefaultGates() {
  const { flags } = await modules();
  return flags.flagReport().filter(f => f.overridden && !CONTEXT_NEUTRAL.has(f.name)).map(f => `${f.name}=${f.raw}`);
}

/** The effective configuration, recorded with every run. */
export async function runConfiguration() {
  const { flags } = await modules();
  return {
    gates: Object.fromEntries(flags.flagReport().map(f => [f.name, f.value])),
    overridden: flags.flagReport().filter(f => f.overridden).map(f => `${f.name}=${f.raw}`),
    infrastructure: flags.infrastructure(),
    readModeExpected: flags.infrastructure().db ? 'canonical (db configured)' : 'legacy (no DATABASE_URL)',
  };
}
