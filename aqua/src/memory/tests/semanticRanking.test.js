/**
 * Semantic recall ranking on REAL embedding geometry (2026-11-05).
 *
 * The live gemini-embedding-001 run (eval/semantic-recall-live/runs/live-2026-11-05)
 * showed cosines compressed into ~0.43–0.74 and the first hybrid formula failing:
 * a lone keyword hit was normalised to a perfect 1.0 (worth 0.50), the semantic
 * term could reach only ~0.14, and the 30% relative floor then dropped every
 * meaning-only match — 9 of 18 relevant memories reached the prompt.
 *
 * Fixture: the real cosines, extracted unchanged (fixtures/semanticRecallLive.cosines.v1.json,
 * source SHA-256 pinned). Pure: no embedder, no network.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-semantic-ranking-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
delete process.env.DATABASE_URL;

const R = await import('../episodicRecall.js');
const SR = await import('../semanticRecall.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FX = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/semanticRecallLive.cosines.v1.json'), 'utf8'));
const DAY = 86_400_000, T0 = Date.UTC(2026, 0, 1);

function world(passages) {
  const conv = new Map([['s', { meta: { userId: 'x', title: 's' }, messages: passages.map((p, i) => ({ role: 'user', content: p.text, ts: T0 + p.day * DAY + i })) }]]);
  R.__clearCacheForTests();
  return R.collectUnits({ userId: 'x', conversationId: 'none', conversations: conv });
}
const UNITS = world(FX.passages);
const idOf = u => FX.passages.find(p => p.text === u.text)?.id;
const semFor = (q, units = UNITS) => new Map(units.map(u => [u.key, q.cosine[idOf(u)]]));
const Q = id => FX.queries.find(q => q.id === id);
const ranked = q => SR.rankHybrid(UNITS, q.text, semFor(q)).map(x => idOf(x.unit));
const selected = q => R.selectRecall(UNITS, q.text, { allUnderChars: 0, semantic: semFor(q) }).excerpts.map(idOf);

describe('the real-run failures (production config cosines)', () => {
  for (const [id, wrong] of [['Q2', 'h4'], ['Q3', 'u6'], ['Q4', 'p1'], ['Q7', 'k1']]) {
    test(`${id} "${Q(id).text}": the relevant memory ranks first and is quoted; ${wrong} (weak keyword hit) is not`, () => {
      const q = Q(id);
      const r = ranked(q), s = selected(q);
      assert.ok(q.relevant.includes(r[0]), `first: ${r[0]} (ranking ${r.slice(0, 4)})`);
      assert.ok(q.relevant.every(x => r.indexOf(x) < r.indexOf(wrong) || r.indexOf(wrong) < 0), `${wrong} below every relevant one`);
      assert.deepEqual(q.relevant.filter(x => !s.includes(x)), [], `all relevant quoted (selected ${s})`);
      assert.ok(!s.includes(wrong), `${wrong} not quoted`);
    });
  }
  test('Q4: the launch passages that matched "planes"→"plan" are not quoted', () => {
    const s = selected(Q('Q4'));
    assert.ok(!s.includes('p1') && !s.includes('p2'), `selected ${s}`);
  });
  test('Q8 "What is my blood pressure?": nothing is quoted', () => {
    assert.deepEqual(selected(Q('Q8')), []);
  });
  test('quoted memories keep their wording and chronology', () => {
    const ex = R.selectRecall(UNITS, Q('Q7').text, { allUnderChars: 0, semantic: semFor(Q('Q7')) }).excerpts;
    assert.deepEqual(ex.map(e => e.text), ['The product launch is planned for May 12.', 'The launch slipped to June 2 because of a supplier delay.']);
    assert.ok(ex[0].ts < ex[1].ts, 'oldest first, the newer word last');
  });
});

describe('offline regression replay of the frozen real-run cosines', () => {
  test('the fixture is the frozen live result, unchanged', (t) => {
    const src = path.join(HERE, '../../..', FX.source);
    if (!fs.existsSync(src)) return t.skip('live result not present in this checkout');
    const sha = crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex');
    assert.equal(sha, FX.sourceSha256);
    const live = JSON.parse(fs.readFileSync(src, 'utf8'));
    for (const q of FX.queries) assert.deepEqual(q.cosine, live.production.perQuery.find(x => x.id === q.id).cosine, q.id);
  });
  test('all 10 questions: MRR 1.000, right memory first 9/9, 18/18 relevant quoted, ≤1 irrelevant, nothing for Q8', () => {
    let mrr = 0, n = 0, hit1 = 0, rel = 0, relTotal = 0;
    const irrelevant = [];
    for (const q of FX.queries) {
      const r = ranked(q), s = selected(q);
      if (!q.relevant.length) { assert.deepEqual(s, [], q.id); continue; }
      n++;
      const f = r.findIndex(x => q.relevant.includes(x));
      mrr += f < 0 ? 0 : 1 / (f + 1);
      if (q.relevant.includes(r[0])) hit1++;
      rel += q.relevant.filter(x => s.includes(x)).length; relTotal += q.relevant.length;
      irrelevant.push(...s.filter(x => !q.relevant.includes(x)).map(x => `${q.id}:${x}`));
    }
    assert.equal(+(mrr / n).toFixed(3), 1);
    assert.equal(hit1, 9);
    assert.equal(`${rel}/${relTotal}`, '18/18');
    assert.ok(irrelevant.length <= 1, `irrelevant quoted: ${irrelevant}`);
    // The one tolerated extra is Q2's Series A passage (arguably about investment).
    assert.ok(irrelevant.every(x => x === 'Q2:f3'), irrelevant.join(','));
  });
});

describe('formula properties (synthetic cosines, real-like spread)', () => {
  // 12 passages so the per-question pool is "large" (≥ 8 vectors).
  const pass = [
    { id: 'kw', day: 1, text: 'The train timetable changed.' },                 // keyword "train", low meaning
    { id: 'sem', day: 2, text: 'I crossed the finish line in under two hours.' }, // meaning, no keyword
    { id: 'both', day: 3, text: 'My marathon training went well this spring.' },   // keyword + meaning
    ...Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, day: 4 + i, text: `Unremarkable note number ${i} about the garden fence.` })),
  ];
  const units = world(pass);
  const id = u => pass.find(p => p.text === u.text).id;
  const sem = cos => new Map(units.map(u => [u.key, cos[id(u)] ?? 0.48]));
  const query = 'How did my marathon training go?';

  test('a weak keyword hit never outranks a strong semantic match, and is not quoted', () => {
    const s = sem({ kw: 0.45, sem: 0.80, both: 0.50 });
    const r = SR.rankHybrid(units, 'Did I complete the race I was training for?', s).map(x => id(x.unit));
    assert.equal(r[0], 'sem');
    const quoted = R.selectRecall(units, 'Did I complete the race I was training for?', { allUnderChars: 0, semantic: s }).excerpts.map(id);
    assert.ok(quoted.includes('sem') && !quoted.includes('kw'), `quoted ${quoted}`);
  });

  test('keyword and meaning agreeing ranks first', () => {
    const r = SR.rankHybrid(units, query, sem({ kw: 0.47, sem: 0.72, both: 0.71 })).map(x => id(x.unit));
    assert.equal(r[0], 'both');
    assert.ok(r.indexOf('kw') < 0 || r.indexOf('kw') > r.indexOf('sem'));
  });

  test('a strong keyword match still counts when meaning supports it', () => {
    const r = SR.rankHybrid(units, query, sem({ both: 0.66, sem: 0.62, kw: 0.47 })).map(x => id(x.unit));
    assert.equal(r[0], 'both');
  });

  test('score parts are reported and add up', () => {
    for (const x of SR.rankHybrid(units, query, sem({ both: 0.7, sem: 0.65 }))) {
      assert.ok(x.parts && Math.abs(x.parts.keyword + x.parts.semantic + x.parts.recency - x.score) < 1e-9);
    }
  });

  test('small pool (< 8 vectors): absolute scale instead of the per-question median', () => {
    const few = units.slice(0, 5);
    const s = new Map(few.map(u => [u.key, { kw: 0.40, sem: 0.75, both: 0.50 }[id(u)] ?? 0.46]));
    const r = SR.rankHybrid(few, 'Did I complete the race?', s);
    const top = r.find(x => id(x.unit) === 'sem');
    assert.ok(top, 'admitted on the absolute floor');
    assert.equal(top.pool, 'small');
    assert.ok(Math.abs(top.z - (0.75 - SR.SEMANTIC_DEFAULTS.minCosine) / (1 - SR.SEMANTIC_DEFAULTS.minCosine)) < 1e-9, `z ${top.z}`);
    const none = SR.rankHybrid(few, 'Did I complete the race?', new Map(few.map(u => [u.key, 0.5])));
    assert.ok(!none.some(x => x.why === 'semantic'), 'nothing below the absolute floor is admitted by meaning');
  });

  test('missing vectors: the keyword path is byte-identical', () => {
    for (const q of FX.queries) {
      const plain = R.selectRecall(UNITS, q.text, { allUnderChars: 0 });
      for (const semantic of [null, undefined, new Map()]) {
        assert.equal(JSON.stringify(R.selectRecall(UNITS, q.text, { allUnderChars: 0, semantic })), JSON.stringify(plain), q.id);
      }
    }
  });

  test('a repeated sentence is quoted once (the later occurrence)', () => {
    const dup = world([{ day: 1, text: 'We closed the seed round.' }, ...Array.from({ length: 9 }, (_, i) => ({ day: 2 + i, text: `Filler ${i} on the fence.` })), { day: 30, text: 'We closed the seed round.' }]);
    const s = new Map(dup.map(u => [u.key, /seed/.test(u.text) ? 0.74 : 0.48]));
    const r = SR.rankHybrid(dup, 'How is fundraising going?', s).filter(x => /seed/.test(x.unit.text));
    assert.equal(r.length, 1);
    assert.equal(r[0].unit.ts, Math.max(...dup.filter(u => /seed/.test(u.text)).map(u => u.ts)));
  });
});
