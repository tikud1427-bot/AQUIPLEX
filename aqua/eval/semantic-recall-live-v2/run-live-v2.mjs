#!/usr/bin/env node
/**
 * Independent live validation of semantic episodic recall (v2, prepared 2026-11-05).
 *
 *   node run-live-v2.mjs --dry-run      no network, no key: hashed-word vectors (plumbing only)
 *   node run-live-v2.mjs --oracle       no network, no key: concept vectors (harness self-check)
 *   node run-live-v2.mjs --confirm "isolated-embedding-key:<dedicated project label>" --out runs/<run-id>
 *
 * BEFORE ANY REQUEST the runner checks, and refuses on any failure:
 *   · MANIFEST.sha256 — dataset, grading, criteria, runner, oracle unchanged since the freeze;
 *   · CODE.sha256     — the production ranking/embedding code is the code frozen with the package
 *                       (the algorithm is tested as is, never tuned on this set);
 *   · independence    — no v1 passage, question or name reused;
 *   · AQUA_EMBEDDING_API_KEY set, and different from every GEMINI… / Gemini… variable present;
 *   · --confirm "isolated-embedding-key:<label>"; --out names a folder that does not exist.
 * Never reads .env, never prints the key. HARD CAP: 9 requests. Plan: 7.
 *
 *   1  all 35 passages (3 users)  production path (dedicatedEmbedder, model/dim as production)
 *   2  all 19 questions           production path
 *   3–7 five single questions, cache cleared — single-call latency (informational)
 * Fallback is tested with simulated failures (no requests).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AQUA = path.join(HERE, '../..');
const argv = process.argv.slice(2);
const flag = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
const ORACLE = argv.includes('--oracle');
const DRY = argv.includes('--dry-run') || ORACLE;
const MAX_REQUESTS = 9;
const die = m => { console.error(`refused: ${m}`); process.exit(2); };
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// ── Freeze checks (every mode) ────────────────────────────────────────────────
function checkManifest(file, base) {
  if (!fs.existsSync(file)) return [`${path.basename(file)} missing`];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => l.match(/^([0-9a-f]{64}) [ *](.+)$/)).filter(Boolean)
    .filter(([, h, f]) => !fs.existsSync(path.join(base, f)) || sha(path.join(base, f)) !== h).map(([, , f]) => f);
}
const changed = [...checkManifest(path.join(HERE, 'MANIFEST.sha256'), HERE), ...checkManifest(path.join(HERE, 'CODE.sha256'), AQUA)];
if (changed.length && !argv.includes('--unfrozen-ok')) die(`frozen files changed since the freeze: ${changed.join(', ')}`);

const DS = JSON.parse(fs.readFileSync(path.join(HERE, 'dataset.v2.json'), 'utf8'));
const V1 = JSON.parse(fs.readFileSync(path.join(AQUA, 'eval/semantic-recall-live/dataset.v1.json'), 'utf8'));
{
  const v1Text = new Set([...V1.passages.map(p => p.text), ...V1.queries.map(q => q.text)].map(s => s.toLowerCase()));
  const v2Text = [...Object.values(DS.users).flatMap(u => u.passages.map(p => p.text)), ...DS.questions.map(q => q.text)];
  const reused = v2Text.filter(s => v1Text.has(s.toLowerCase()));
  const names = ['Larkspur', 'Oakridge', 'Leeds', 'Bristol', 'Priya', 'Tomas', 'Series A', 'ukulele', 'sourdough'];
  const nameHits = v2Text.filter(s => names.some(n => s.includes(n)));
  if (reused.length || nameHits.length) die(`v1 material reused: ${[...reused, ...nameHits].join(' | ')}`);
}

// ── Isolation: private data dir; only the dedicated key is visible to the embedder ──
process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-recall-live-v2-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1'; process.env.MONGO_URI = ''; process.env.DATABASE_URL = '';
const KEY = String(process.env.AQUA_EMBEDDING_API_KEY ?? '').trim();
let out = null;
if (!DRY) {
  // The override exists for offline modes only; a live run never accepts it, changed or not.
  if (argv.includes('--unfrozen-ok')) die('--unfrozen-ok is for --dry-run / --oracle only; a live run never accepts it');
  if (changed.length) die('a live run needs the frozen package and code unchanged');
  if (!KEY) die('AQUA_EMBEDDING_API_KEY is not set — no isolated credential, nothing is sent (do not substitute a shared key)');
  // A placeholder must never reach the network (2026-11-05: a safeguard probe with a fake value
  // passed every other check and one request was sent and rejected). Google issues more than one
  // key format (AIza…, AQ.…) and the SDK sends any string as x-goog-api-key, so this only rejects
  // placeholders; it never judges validity or isolation (keyPool.cjs: shape is not validity).
  if (!/^[A-Za-z0-9._-]{30,256}$/.test(KEY) || new Set(KEY).size < 12) die('AQUA_EMBEDDING_API_KEY looks like a placeholder, not an API key — nothing is sent');
  const same = Object.entries(process.env).filter(([k, v]) => /^gemini/i.test(k) && String(v ?? '').trim() === KEY).map(([k]) => k);
  if (same.length) die(`AQUA_EMBEDDING_API_KEY equals ${same.join(', ')} — that is a shared key`);
  if (!/^isolated-embedding-key:\S+/.test(flag('confirm') ?? '')) die('--confirm "isolated-embedding-key:<label of the dedicated Google project>" is required');
  out = flag('out') ?? die('--out runs/<run-id> is required');
  out = path.resolve(HERE, out);
  if (fs.existsSync(out)) die(`${out} exists — runs are never overwritten`);
}
for (const k of Object.keys(process.env)) if (/^gemini/i.test(k) || (/_API_KEY$/.test(k) && k !== 'AQUA_EMBEDDING_API_KEY')) delete process.env[k];
if (DRY) process.env.AQUA_EMBEDDING_API_KEY = 'dry-run-not-a-key';

const DE = await import('../../src/embeddings/dedicatedEmbedder.js');
const { EMBED_MODEL, EMBED_DIM } = await import('../../src/embeddings/embeddingModel.js');
const { cosineSim, upsert, __resetForTests: resetVectors } = await import('../../src/embeddings/vectorStore.js');
const R = await import('../../src/memory/episodicRecall.js');
const SR = await import('../../src/memory/semanticRecall.js');
const { grade, evaluate, CRITERIA } = await import('./grade-v2.mjs');

// ── Transport: the production call, counted and timed; fake vectors in dry modes ──
const requests = [];
const GoogleGenAI = DRY ? null : (await import('@google/genai')).GoogleGenAI;
const { conceptVec } = ORACLE ? await import('./oracle-concepts-v2.mjs') : { conceptVec: null };
const fakeVec = ORACLE ? t => conceptVec(t, EMBED_DIM)
  : t => { const v = new Array(EMBED_DIM).fill(0); for (const w of String(t).toLowerCase().match(/[a-z0-9]+/g) ?? []) v[[...w].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % EMBED_DIM, 7)] += 1; return v; };
DE.__setDedicatedTransportForTests(async (key, texts) => {
  if (requests.length >= MAX_REQUESTS) throw new Error(`request cap ${MAX_REQUESTS} reached`);
  const rec = { n: requests.length + 1, inputs: texts.length, model: EMBED_MODEL, dim: EMBED_DIM, ms: null, ok: false, usage: null, error: null };
  requests.push(rec);
  const t0 = Date.now();
  try {
    const res = DRY ? { embeddings: texts.map(t => ({ values: fakeVec(t) })) }
      : await new GoogleGenAI({ apiKey: key }).models.embedContent({ model: EMBED_MODEL, contents: texts, config: { outputDimensionality: EMBED_DIM } });
    rec.ms = Date.now() - t0;
    rec.usage = res?.usageMetadata ?? res?.metadata ?? null;
    rec.responseKeys = Object.keys(res ?? {});
    rec.ok = (res?.embeddings ?? []).length === texts.length;
    return res;
  } catch (err) {
    rec.ms = Date.now() - t0;
    rec.error = { status: err?.status ?? null, message: String(err?.message ?? err).split(KEY).join('[redacted]').slice(0, 200) };
    throw err;
  }
});

// ── Run ───────────────────────────────────────────────────────────────────────
const passages = Object.entries(DS.users).flatMap(([user, u]) => u.passages.map(p => ({ ...p, user })));
const result = { dataset: DS.id, datasetSha256: sha(path.join(HERE, 'dataset.v2.json')), codeSha256: fs.existsSync(path.join(HERE, 'CODE.sha256')) ? sha(path.join(HERE, 'CODE.sha256')) : null,
  model: EMBED_MODEL, dim: EMBED_DIM, dryRun: DRY, oracle: ORACLE, defaults: SR.SEMANTIC_DEFAULTS, criteria: CRITERIA, startedAt: new Date().toISOString(), requests };
let stoppedOn = null, pv = null, qv = null;
try {
  pv = await DE.dedicatedEmbed(passages.map(p => p.text));
  if (pv.some(v => !v)) throw new Error(`passages: ${pv.filter(v => !v).length} null vectors (stopped)`);
  qv = await DE.dedicatedEmbed(DS.questions.map(q => q.text));
  if (qv.some(v => !v)) throw new Error(`questions: ${qv.filter(v => !v).length} null vectors (stopped)`);
  result.singleLatencyMs = [];
  for (const q of DS.questions.slice(0, 5)) {
    DE.__resetDedicatedForTests();
    const t0 = Date.now();
    const v = await DE.dedicatedEmbedOne(q.text);
    result.singleLatencyMs.push({ question: q.id, ms: Date.now() - t0, ok: !!v });
    if (!v) throw new Error(`single ${q.id}: no vector (stopped)`);
  }
} catch (err) { stoppedOn = String(err?.message ?? err).split(KEY).join('[redacted]').slice(0, 200); }
result.stoppedOn = stoppedOn;

if (pv && qv && !pv.some(v => !v) && !qv.some(v => !v)) {
  const pIndex = new Map(passages.map((p, i) => [p.id, i]));
  const qIndex = new Map(DS.questions.map((q, i) => [q.id, i]));
  const cosOf = (qid, pid) => cosineSim(qv[qIndex.get(qid)], pv[pIndex.get(pid)]);
  // Fallback (simulated; no requests): failing transports → recallForTurn gives the keyword result.
  const fb = [];
  {
    const user = DS.users.mara;
    const conv = new Map([['fb', { meta: { userId: 'fb', title: 'fb' }, messages: [...user.passages, ...Array.from({ length: 80 }, (_, i) => ({ text: `Filler line ${i} about an ordinary afternoon walk in the park.`, day: 50 }))].map((p, i) => ({ role: 'user', content: p.text, ts: Date.UTC(2026, 0, 1) + p.day * 86_400_000 + i })) }]]);
    for (const [label, tr] of [['http 500', () => { const e = new Error('server'); e.status = 500; throw e; }], ['http 429', () => { const e = new Error('rate'); e.status = 429; throw e; }], ['http 401', () => { const e = new Error('key'); e.status = 401; throw e; }], ['timeout', () => new Promise(() => {})]]) {
      DE.__resetDedicatedForTests(); DE.__setDedicatedTransportForTests(tr); resetVectors(); R.__clearCacheForTests();
      process.env.AQUA_SEMANTIC_RECALL = 'on';
      const units = R.collectUnits({ userId: 'fb', conversationId: 'none', conversations: conv });
      units.slice(0, 5).forEach(u => upsert(SR.recallNamespace('user:fb'), u.key, fakeVec(u.text), DE.dedicatedContentHash(u.text)));
      const kw = R.selectRecall(units, 'Are we relocating the company?', {}).excerpts.map(e => e.key);
      const r = await R.recallForTurn({ ownerId: 'user:fb', userId: 'fb', conversationId: 'none', query: 'Are we relocating the company?', conversations: conv, includeFiles: false, semanticTimeoutMs: 200 });
      fb.push({ failure: label, sameAsKeyword: JSON.stringify(r.excerpts.map(e => e.key)) === JSON.stringify(kw) });
    }
    delete process.env.AQUA_SEMANTIC_RECALL;
  }
  result.fallback = fb;
  result.perQuestion = grade(DS, cosOf, { R, SR });
  result.evaluation = evaluate(result.perQuestion, { fallbackOk: fb.filter(f => f.sameAsKeyword).length });
}
result.finishedAt = new Date().toISOString();
result.requestCount = requests.length;

// ── Report ────────────────────────────────────────────────────────────────────
console.log(`${ORACLE ? 'ORACLE DRY RUN (concept vectors — harness self-check; says nothing about Gemini)' : DRY ? 'DRY RUN (hashed-word vectors, nothing sent)' : 'LIVE'} · ${EMBED_MODEL} dim ${EMBED_DIM} · requests ${requests.length}/${MAX_REQUESTS}${stoppedOn ? ` · STOPPED: ${stoppedOn}` : ''}`);
for (const r of requests) console.log(`  #${r.n} inputs=${r.inputs} ${r.ok ? 'ok' : 'FAIL'} ${r.ms}ms usage=${r.usage ? JSON.stringify(r.usage) : 'not returned'}`);
if (result.evaluation) {
  const e = result.evaluation;
  for (const [k, c] of Object.entries(CRITERIA)) console.log(`  ${k.padEnd(4)} ${e.pass[k] === null ? 'n/a ' : e.pass[k] ? 'PASS' : 'FAIL'}  ${JSON.stringify(e.metrics[k])}  — ${c.what}`);
  console.log(`  detail: ${JSON.stringify(e.detail)}`);
  console.log(`  informational: ${JSON.stringify(e.informational)}`);
  for (const q of result.perQuestion) console.log(`  ${q.id.padEnd(3)} ${q.kind.padEnd(27)} ${q.favours.padEnd(8)} selected ${q.selected.join(',').padEnd(12)} relevant ${q.relevantSelected.length}/${q.relevant.length}${q.excludedSelected.length ? ` EXCLUDED:${q.excludedSelected}` : ''}${q.otherSelected.length ? ` other:${q.otherSelected}` : ''} kw-sel ${q.keyword.selected.join(',') || '-'} pool=${q.pool}`);
}
if (result.singleLatencyMs) console.log(`  single-call latency ms (informational): ${result.singleLatencyMs.map(x => x.ms).join(', ')}`);
if (out) { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log(`\n→ ${path.relative(HERE, out)}/result.json`); }
process.exit(stoppedOn ? 1 : 0);
