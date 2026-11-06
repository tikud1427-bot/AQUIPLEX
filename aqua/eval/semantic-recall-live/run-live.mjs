#!/usr/bin/env node
/**
 * Controlled live validation of semantic episodic recall embeddings (2026-11-05).
 *
 *   node run-live.mjs --dry-run                       no network, no key: fake vectors, checks the plan + analysis
 *   node run-live.mjs --oracle                        no network, no key: concept vectors (oracle-concepts.mjs) —
 *                                                     shows the harness detects a SUCCESSFUL semantic retrieval
 *   node run-live.mjs --confirm "isolated-embedding-key:<new-project-label>" --out runs/<run-id>
 *
 * LIVE MODE REFUSES unless ALL hold:
 *   · AQUA_EMBEDDING_API_KEY is set (the dedicated recall credential — the ONLY key read);
 *   · it differs from every GEMINI* / Gemini* variable in this process (no shared key substituted);
 *   · --confirm "isolated-embedding-key:<label>" states it comes from a NEW Google project used for nothing else;
 *   · --out names a directory that does not exist (nothing is overwritten).
 * Never reads .env. Never prints or stores the key. Hard cap: 20 requests (plan: 9).
 * Stops at the first provider error and records it.
 *
 * Requests (one embedContent call each):
 *   1  24 passages   production config (EMBED_MODEL, EMBED_DIM, no task type) — via dedicatedEmbedder
 *   2  10 queries    production config                                       — via dedicatedEmbedder
 *   3  24 passages   taskType RETRIEVAL_DOCUMENT (comparison only)
 *   4  10 queries    taskType RETRIEVAL_QUERY    (comparison only)
 *   5–9 one query each, cache cleared — single-call latency as a chat turn sees it
 * Provider failure / timeout fallback is tested with simulated failures (no requests).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
const ORACLE = argv.includes('--oracle');
const DRY = argv.includes('--dry-run') || ORACLE;     // the oracle is a dry run: nothing is ever sent
const MAX_REQUESTS = 20;
const die = m => { console.error(`refused: ${m}`); process.exit(2); };

// Isolation of the app modules this imports: private data dir, no mirror, no DB, and no
// credential other than the dedicated one visible to the embedder.
process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'aqua-recall-live-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1'; process.env.MONGO_URI = ''; process.env.DATABASE_URL = '';

const KEY = String(process.env.AQUA_EMBEDDING_API_KEY ?? '').trim();
let out = null;
if (!DRY) {
  if (!KEY) die('AQUA_EMBEDDING_API_KEY is not set — no isolated credential, nothing is sent (do not substitute a shared key)');
  const sharedSame = Object.entries(process.env).filter(([k, v]) => /^gemini/i.test(k) && String(v ?? '').trim() === KEY).map(([k]) => k);
  if (sharedSame.length) die(`AQUA_EMBEDDING_API_KEY equals ${sharedSame.join(', ')} — that is a shared key`);
  if (!/^isolated-embedding-key:\S+/.test(flag('confirm') ?? '')) die('--confirm "isolated-embedding-key:<label of the new Google project>" is required');
  out = flag('out') ?? die('--out runs/<run-id> is required');
  out = path.resolve(HERE, out);
  if (fs.existsSync(out)) die(`${out} exists — runs are never overwritten`);
}
// Nothing but the dedicated key reaches the embedder module.
for (const k of Object.keys(process.env)) if (/^gemini/i.test(k) || /_API_KEY$/.test(k) && k !== 'AQUA_EMBEDDING_API_KEY') delete process.env[k];
if (DRY) process.env.AQUA_EMBEDDING_API_KEY = 'dry-run-not-a-key';

const DS = JSON.parse(fs.readFileSync(path.join(HERE, 'dataset.v1.json'), 'utf8'));
const DE = await import('../../src/embeddings/dedicatedEmbedder.js');
const { EMBED_MODEL, EMBED_DIM } = await import('../../src/embeddings/embeddingModel.js');
const { cosineSim, upsert, __resetForTests: resetVectors } = await import('../../src/embeddings/vectorStore.js');
const R = await import('../../src/memory/episodicRecall.js');
const SR = await import('../../src/memory/semanticRecall.js');

// ── Transport: the production call, counted and timed; or fake vectors in dry run ──
const requests = [];
let GoogleGenAI = null;
if (!DRY) ({ GoogleGenAI } = await import('@google/genai'));
// Dry run: hashed bag of words (no meaning — checks plumbing only). Oracle: concept vectors (harness self-check).
const { conceptVec } = ORACLE ? await import('./oracle-concepts.mjs') : { conceptVec: null };
const fakeVec = ORACLE ? t => conceptVec(t, EMBED_DIM)
  : t => { const v = new Array(EMBED_DIM).fill(0); for (const w of String(t).toLowerCase().match(/[a-z]+/g) ?? []) v[[...w].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % EMBED_DIM, 7)] += 1; return v; };
async function call(label, texts, taskType = null) {
  if (requests.length >= MAX_REQUESTS) throw new Error(`request cap ${MAX_REQUESTS} reached`);
  const t0 = Date.now();
  const rec = { n: requests.length + 1, label, inputs: texts.length, taskType, model: EMBED_MODEL, dim: EMBED_DIM, ms: null, ok: false, usage: null, error: null };
  requests.push(rec);
  try {
    let res;
    if (DRY) res = { embeddings: texts.map(t => ({ values: fakeVec(t) })) };
    else {
      const ai = new GoogleGenAI({ apiKey: KEY });
      res = await ai.models.embedContent({ model: EMBED_MODEL, contents: texts, config: { outputDimensionality: EMBED_DIM, ...(taskType ? { taskType } : {}) } });
    }
    rec.ms = Date.now() - t0;
    rec.usage = res?.usageMetadata ?? res?.metadata ?? null;            // recorded when the API returns any
    rec.responseKeys = Object.keys(res ?? {});
    const vecs = (res?.embeddings ?? []).map(e => e?.values ?? null);
    rec.ok = vecs.length === texts.length && vecs.every(v => Array.isArray(v) && v.length === EMBED_DIM);
    if (!rec.ok) throw new Error(`misaligned response (${vecs.length}/${texts.length})`);
    return vecs;
  } catch (err) {
    rec.ms = Date.now() - t0;
    rec.error = { status: err?.status ?? null, message: String(err?.message ?? err).split(KEY).join('[redacted]').slice(0, 200) };
    throw err;
  }
}
// Production path for requests 1, 2, 5–9: dedicatedEmbedder with this transport.
DE.__setDedicatedTransportForTests(async (key, texts) => ({ embeddings: (await call(`production:${texts.length === 1 ? 'single' : 'batch'}`, texts)).map(values => ({ values })) }));

// ── Run ───────────────────────────────────────────────────────────────────────
const P = DS.passages, Q = DS.queries;
const result = { dataset: DS.id, model: EMBED_MODEL, dim: EMBED_DIM, dryRun: DRY, oracle: ORACLE, weights: SR.SEMANTIC_DEFAULTS.weights, startedAt: new Date().toISOString(), requests };
let stoppedOn = null;
const vec = { prod: { p: null, q: null }, task: { p: null, q: null } };
try {
  vec.prod.p = await DE.dedicatedEmbed(P.map(x => x.text));
  if (vec.prod.p.some(v => !v)) throw new Error('production path returned null vectors');
  vec.prod.q = await DE.dedicatedEmbed(Q.map(x => x.text));
  vec.task.p = await call('taskType:RETRIEVAL_DOCUMENT', P.map(x => x.text), 'RETRIEVAL_DOCUMENT');
  vec.task.q = await call('taskType:RETRIEVAL_QUERY', Q.map(x => x.text), 'RETRIEVAL_QUERY');
  result.singleLatencyMs = [];
  for (const q of Q.slice(0, 5)) {
    DE.__resetDedicatedForTests();                         // cold: no cached vector
    const t0 = Date.now();
    const v = await DE.dedicatedEmbedOne(q.text);
    result.singleLatencyMs.push({ query: q.id, ms: Date.now() - t0, ok: !!v });
  }
} catch (err) {
  stoppedOn = String(err?.message ?? err).split(KEY).join('[redacted]').slice(0, 200);
}
result.stoppedOn = stoppedOn;

// ── Analysis (offline, on the vectors received) ──────────────────────────────
const DAY = 86_400_000, T0 = Date.UTC(2026, 0, 1);
function analyse(pv, qv, label) {
  if (!pv || !qv) return null;
  const conv = new Map([['synthetic', { meta: { userId: 'live', title: 'synthetic' }, messages: P.map((p, i) => ({ role: 'user', content: p.text, ts: T0 + p.day * DAY + i })) }]]);
  R.__clearCacheForTests();
  const units = R.collectUnits({ userId: 'live', conversationId: 'none', conversations: conv });
  const idOf = u => P.find(p => p.text === u.text)?.id;
  const perQuery = [];
  const rel = [], non = [];
  Q.forEach((q, qi) => {
    const cos = Object.fromEntries(P.map((p, pi) => [p.id, +cosineSim(qv[qi], pv[pi]).toFixed(4)]));
    for (const p of P) (q.relevant.includes(p.id) ? rel : non).push(cos[p.id]);
    const semMap = new Map(units.map(u => [u.key, cos[idOf(u)]]));
    const rankOf = list => list.map(idOf);
    const kwRank = rankOf(R.scoreUnits(units, q.text).scored.map(s => s.unit));
    const semRank = [...P].sort((a, b) => cos[b.id] - cos[a.id]).map(p => p.id);
    const hybridList = SR.rankHybrid(units, q.text, semMap);
    const hyRank = rankOf(hybridList.map(x => x.unit));
    // Score components as the production ranking weighs them (weights read from SEMANTIC_DEFAULTS, not copied).
    const W = SR.SEMANTIC_DEFAULTS.weights, MIN = SR.SEMANTIC_DEFAULTS.minCosine;
    // rankHybrid reports its own parts since the 2026-11-05 revision; the fallback reconstructs the first formula.
    const components = hybridList.slice(0, 5).map(x => {
      const kwPart = x.parts ? x.parts.keyword : W.keyword * x.keyword;
      const semPart = x.parts ? x.parts.semantic : (x.semantic >= MIN ? W.semantic * (x.semantic - MIN) / (1 - MIN) : 0);
      return { id: idOf(x.unit), score: +x.score.toFixed(4), keyword: +kwPart.toFixed(4), semantic: +semPart.toFixed(4), recency: +(x.score - kwPart - semPart).toFixed(4), cosine: +x.semantic.toFixed(4), why: x.why, ...(x.admitted != null ? { admitted: x.admitted, z: +x.z.toFixed(4), pool: x.pool } : {}) };
    });
    // The full selection as the prompt would get it (ranked mode, hybrid).
    const sel = R.selectRecall(units, q.text, { allUnderChars: 0, semantic: semMap }).excerpts.map(idOf);
    const metric = rank => {
      if (!q.relevant.length) return { hit1: null, hit3: null, mrr: null, falsePositives: rank.slice(0, 3) };
      const first = rank.findIndex(id => q.relevant.includes(id));
      return { hit1: q.relevant.includes(rank[0]), hit3: rank.slice(0, 3).some(id => q.relevant.includes(id)), mrr: first < 0 ? 0 : +(1 / (first + 1)).toFixed(3) };
    };
    perQuery.push({
      id: q.id, kind: q.kind, text: q.text, relevant: q.relevant,
      cosine: cos,
      keyword: { rank: kwRank.slice(0, 5), ...metric(kwRank) },
      semantic: { rank: semRank.slice(0, 5), ...metric(semRank) },
      hybrid: { rank: hyRank.slice(0, 5), ...metric(hyRank), components },
      selected: sel,
      currentFirst: q.current ? hyRank.indexOf(q.current) >= 0 && hyRank.indexOf(q.current) < Math.min(...q.relevant.filter(r => r !== q.current).map(r => (hyRank.indexOf(r) < 0 ? 99 : hyRank.indexOf(r)))) : null,
      bothQuoted: q.current ? q.relevant.every(r => sel.includes(r)) : null,
      trapAboveRelevant: q.trap ? { keyword: kwRank.indexOf(q.trap) >= 0 && kwRank.indexOf(q.trap) < Math.min(...q.relevant.map(r => (kwRank.indexOf(r) < 0 ? 99 : kwRank.indexOf(r)))), hybrid: hyRank.indexOf(q.trap) >= 0 && hyRank.indexOf(q.trap) < Math.min(...q.relevant.map(r => (hyRank.indexOf(r) < 0 ? 99 : hyRank.indexOf(r)))) } : null,
      aboveFloor: P.filter(p => cos[p.id] >= SR.SEMANTIC_DEFAULTS.minCosine).map(p => p.id),
    });
  });
  // Threshold calibration: cosine ≥ t as a "relevant" classifier over all (query, passage) pairs.
  const sweep = [];
  for (let t = 0.40; t <= 0.90001; t += 0.025) {
    const tp = rel.filter(c => c >= t).length, fp = non.filter(c => c >= t).length, fn = rel.length - tp;
    const precision = tp + fp ? tp / (tp + fp) : 1, recall = rel.length ? tp / rel.length : 0;
    sweep.push({ t: +t.toFixed(3), precision: +precision.toFixed(3), recall: +recall.toFixed(3), f1: precision + recall ? +(2 * precision * recall / (precision + recall)).toFixed(3) : 0, fp });
  }
  const best = [...sweep].sort((a, b) => b.f1 - a.f1 || b.t - a.t)[0];
  // A best value on the edge of the swept range is not a calibration: the optimum may lie outside it.
  best.atEdge = best.t === sweep[0].t ? 'low' : best.t === sweep.at(-1).t ? 'high' : null;
  const stats = xs => { const s = [...xs].sort((a, b) => a - b); return { n: s.length, min: s[0], p50: s[Math.floor(s.length / 2)], max: s.at(-1) }; };
  const mean = k => +(perQuery.filter(x => x[k].mrr != null).reduce((n, x) => n + x[k].mrr, 0) / perQuery.filter(x => x[k].mrr != null).length).toFixed(3);
  return {
    label, relevantCosine: stats(rel), unrelatedCosine: stats(non), sweep, bestThreshold: best, currentThreshold: SR.SEMANTIC_DEFAULTS.minCosine,
    mrr: { keyword: mean('keyword'), semantic: mean('semantic'), hybrid: mean('hybrid') },
    hit1: Object.fromEntries(['keyword', 'semantic', 'hybrid'].map(k => [k, perQuery.filter(x => x[k].hit1).length])),
    perQuery,
  };
}
result.production = analyse(vec.prod.p, vec.prod.q, 'production config (no task type)');
result.taskType = analyse(vec.task.p, vec.task.q, 'RETRIEVAL_DOCUMENT / RETRIEVAL_QUERY');

// ── Fallback (simulated provider failures; no requests) ──────────────────────
{
  const conv = new Map([['synthetic', { meta: { userId: 'fb', title: 'synthetic' }, messages: [...P, ...Array.from({ length: 80 }, (_, i) => ({ text: `Filler line ${i} about an ordinary sunny afternoon walk in the park.`, day: 50 }))].map((p, i) => ({ role: 'user', content: p.text, ts: T0 + p.day * DAY + i })) }]]);
  const fb = [];
  for (const [label, transport] of [['http 500', () => { const e = new Error('server error'); e.status = 500; throw e; }], ['http 429', () => { const e = new Error('rate'); e.status = 429; throw e; }], ['http 401', () => { const e = new Error('bad key'); e.status = 401; throw e; }], ['timeout', () => new Promise(() => {})]]) {
    DE.__resetDedicatedForTests(); DE.__setDedicatedTransportForTests(transport); resetVectors(); R.__clearCacheForTests();
    process.env.AQUA_SEMANTIC_RECALL = 'on';
    const units = R.collectUnits({ userId: 'fb', conversationId: 'none', conversations: conv });
    units.slice(0, 5).forEach(u => upsert(SR.recallNamespace('user:fb'), u.key, fakeVec(u.text), DE.dedicatedContentHash(u.text)));
    const kw = R.selectRecall(units, 'When is the release date?', {}).excerpts.map(e => e.key);
    const r = await R.recallForTurn({ ownerId: 'user:fb', userId: 'fb', conversationId: 'none', query: 'When is the release date?', conversations: conv, includeFiles: false, semanticTimeoutMs: 200 });
    fb.push({ failure: label, sameAsKeyword: JSON.stringify(r.excerpts.map(e => e.key)) === JSON.stringify(kw), mode: r.stats.mode });
  }
  delete process.env.AQUA_SEMANTIC_RECALL;
  result.fallback = fb;
}
result.finishedAt = new Date().toISOString();
result.requestCount = requests.length;

// ── Report ────────────────────────────────────────────────────────────────────
const p = result.production;
console.log(`${ORACLE ? 'ORACLE DRY RUN (concept vectors — harness self-check, nothing sent; its cosines say nothing about Gemini)' : DRY ? 'DRY RUN (fake hashed-word vectors, nothing sent)' : 'LIVE'} · ${EMBED_MODEL} dim ${EMBED_DIM} · requests ${requests.length}/${MAX_REQUESTS}${stoppedOn ? ` · STOPPED: ${stoppedOn}` : ''}`);
for (const r of requests) console.log(`  #${r.n} ${r.label.padEnd(30)} inputs=${r.inputs} ${r.ok ? 'ok' : 'FAIL'} ${r.ms}ms usage=${r.usage ? JSON.stringify(r.usage) : 'not returned'}`);
for (const a of [result.production, result.taskType].filter(Boolean)) {
  console.log(`\n${a.label}: MRR keyword ${a.mrr.keyword} · semantic ${a.mrr.semantic} · hybrid ${a.mrr.hybrid}; hit@1 ${JSON.stringify(a.hit1)}`);
  console.log(`  relevant cosine ${JSON.stringify(a.relevantCosine)} · unrelated ${JSON.stringify(a.unrelatedCosine)}`);
  console.log(`  best threshold ${a.bestThreshold.t} (P ${a.bestThreshold.precision} R ${a.bestThreshold.recall} F1 ${a.bestThreshold.f1}) · current ${a.currentThreshold}${a.bestThreshold.atEdge ? `  ⚠ AT THE ${a.bestThreshold.atEdge.toUpperCase()} EDGE of the sweep (${a.sweep[0].t}–${a.sweep.at(-1).t}): not a calibration` : ''}`);
}
if (p) for (const q of p.perQuery) {
  console.log(`  ${q.id.padEnd(3)} ${q.kind.padEnd(19)} hybrid ${q.hybrid.rank.slice(0, 3).join(',').padEnd(9)} kw ${q.keyword.rank.slice(0, 3).join(',').padEnd(9)} current-first=${q.currentFirst ?? '-'} both-quoted=${q.bothQuoted ?? '-'} trap=${q.trapAboveRelevant ? JSON.stringify(q.trapAboveRelevant) : '-'} ≥floor=${q.aboveFloor.length}`);
  for (const c of q.hybrid.components.slice(0, 3)) console.log(`        ${c.id.padEnd(3)} score ${c.score.toFixed(3)} = keyword ${c.keyword.toFixed(3)} + semantic ${c.semantic.toFixed(3)} + recency ${c.recency.toFixed(3)}  (cosine ${c.cosine.toFixed(3)}, ${c.why})`);
}
console.log(`\nfallback: ${result.fallback.map(f => `${f.failure}=${f.sameAsKeyword ? 'keyword result' : 'DIFFERENT'}`).join(' · ')}`);
if (result.singleLatencyMs) console.log(`single-call latency ms: ${result.singleLatencyMs.map(x => x.ms).join(', ')}`);
if (out) { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log(`\n→ ${path.relative(HERE, out)}/result.json`); }
process.exit(stoppedOn ? 1 : 0);
