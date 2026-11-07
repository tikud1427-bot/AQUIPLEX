/**
 * C9 semantic relevance on REAL recorded vectors, replayed offline (2026-11-07).
 *
 * The vectors come only from eval/fixtures/c9-semantic-relevance.embeddings.v1.json,
 * written by one live run of scripts/record-c9-embeddings.mjs. Until that file
 * exists every vector test below is SKIPPED with the reason "C9 embedding
 * fixture UNAVAILABLE" — nothing is generated, simulated or substituted.
 *
 * PRE-REGISTERED (written before any vector existed; changing a threshold after
 * seeing the vectors must be stated as such):
 *   · per-case canonical question → its item ranks first among the owner's five
 *     items in ≥ 9 of 10 owners, for each of C1–C4 and C5-anchored;
 *   · paraphrase queries → relevant item first among the five in ≥ 80 %, a
 *     relevant statement in the owner's top 5 of the whole corpus in ≥ 80 %;
 *   · equivalent pairs beat the anchor's trap in ≥ 90 % of anchors, and on mean
 *     cosine beat distinct pairs, trap pairs and unrelated statements;
 *   · hard negatives: the trap query scores its look-alike item LOWER than the
 *     canonical question for that item does, in ≥ 90 %; its look-alike item is
 *     not first among the five in ≥ 90 %;
 *   · unrelated questions: no item cosine reaches the owner's median relevant
 *     cosine for paraphrase queries.
 * Margin statistics in the form of PIC Lane 6 (top − corpus median) are printed
 * as diagnostics only — C9 has not decided to use them.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadC9Fixture, loadDataset } from '../fixtures/c9EmbeddingFixture.mjs';

const fx = loadC9Fixture();
const skip = fx.available ? false : fx.reason;

test('availability is stated, never papered over: absent or invalid fixture → no vectors at all', () => {
  if (fx.available) {
    assert.equal(fx.meta.model, 'gemini-embedding-001');
    assert.equal(fx.meta.dim, 768);
    assert.equal(fx.meta.dataset.sha256, loadDataset().sha256);
    return;
  }
  assert.match(fx.reason, /UNAVAILABLE|stale|digest|unreadable|not gemini|dimension|no valid vector/);
  assert.equal(fx.vectorOf, undefined);
  assert.equal(fx.cos, undefined);
  const bad = loadC9Fixture({ fixturePath: 'does-not-exist.json' });
  assert.equal(bad.available, false);
});

const ITEMS = ['run', 'lang', 'career', 'ci', 'deadline'];
const share = (xs) => xs.filter(Boolean).length / xs.length;
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// Each test is skipped on its own, so the runner's skipped count shows the missing fixture.
const vtest = (name, fn) => test(name, { skip }, fn);
describe('C9 semantic relevance on recorded vectors', () => {
  const d = fx.available ? fx.dataset : { statements: [], queries: [], pairs: [] };
  const owners = [...new Set(d.statements.map(s => s.owner))];
  const anchor = (o, item) => d.statements.find(s => s.owner === o && s.role === 'anchor' && s.item === item).id;
  const anchors = o => ITEMS.map(item => ({ item, id: anchor(o, item) }));
  const corpus = o => d.statements.filter(s => s.owner === o);
  const rankAmong = (qid, ids) => ids.map(id => ({ id, c: fx.cos(qid, id) })).sort((a, b) => b.c - a.c);
  const firstItem = (q) => { const r = rankAmong(q.id, anchors(q.owner).map(a => a.id)); return anchors(q.owner).find(a => a.id === r[0].id).item; };

  vtest('integrity and determinism: every entry has a 768-dim vector; two loads give identical cosines', () => {
    const again = loadC9Fixture();
    assert.equal(again.available, true);
    for (const q of d.queries.slice(0, 50)) {
      const id = anchor(q.owner, 'run');
      assert.equal(fx.cos(q.id, id), again.cos(q.id, id));
    }
    for (const e of [...d.statements, ...d.queries]) assert.equal(fx.vectorOf(e.id).length, 768);
  });

  const CASES = [['C1', 'How far is a 21 km race?', 'run'], ['C2', 'Is Duolingo worth it?', 'lang'], ['C3', 'Why is CI failing?', 'ci'], ['C4', "How's my career?", 'career'], ['C5', 'What shoes should I buy for my race?', 'run']];
  for (const [cas, text, item] of CASES) {
    vtest(`${cas}: "${text}" reaches the ${item} item first in ≥ 9 of 10 owners`, (t) => {
      const qs = d.queries.filter(q => q.text === text);
      const hits = qs.map(q => firstItem(q) === item);
      t.diagnostic(`${cas}: ${hits.filter(Boolean).length}/${qs.length} owners`);
      assert.ok(hits.filter(Boolean).length >= 9, `${hits.filter(Boolean).length}/${qs.length}`);
    });
  }

  vtest('ranking: paraphrase queries find their item first (≥ 80 %) and a relevant statement in the top 5 (≥ 80 %)', (t) => {
    const qs = d.queries.filter(q => q.category === 'paraphrase' || q.category === 'planning_anchored');
    const first = qs.map(q => firstItem(q) === q.item);
    const top5 = qs.map(q => rankAmong(q.id, corpus(q.owner).map(s => s.id)).slice(0, 5).some(r => q.relevant.includes(r.id)));
    t.diagnostic(`item first ${share(first).toFixed(3)} · relevant in top 5 ${share(top5).toFixed(3)} · n=${qs.length}`);
    assert.ok(share(first) >= 0.8, `item first ${share(first)}`);
    assert.ok(share(top5) >= 0.8, `top 5 ${share(top5)}`);
  });

  vtest('similarity: equivalent pairs beat traps per anchor (≥ 90 %), and beat distinct, trap and unrelated pairs on mean cosine', (t) => {
    const by = rel => d.pairs.filter(p => p.relation === rel).map(p => fx.cos(p.a, p.b));
    const mean = xs => xs.reduce((s, x) => s + x, 0) / xs.length;
    const unrelated = owners.flatMap(o => anchors(o).slice(0, 4).flatMap(a => corpus(o).filter(s => s.role === 'filler').slice(0, 10).map(s => fx.cos(a.id, s.id))));
    const eq = mean(by('equivalent')), dist = mean(by('distinct')), trap = mean(by('trap')), unrel = mean(unrelated);
    t.diagnostic(`mean cosine — equivalent ${eq.toFixed(4)} · distinct ${dist.toFixed(4)} · trap ${trap.toFixed(4)} · unrelated ${unrel.toFixed(4)}`);
    assert.ok(eq > dist && eq > trap && eq > unrel);
    const perAnchor = owners.flatMap(o => ['run', 'lang', 'ci', 'career'].map(item => {
      const a = anchor(o, item);
      const best = Math.max(...d.pairs.filter(p => p.a === a && p.relation === 'equivalent').map(p => fx.cos(p.a, p.b)));
      const tr = d.pairs.find(p => p.a === a && p.relation === 'trap');
      return best > fx.cos(tr.a, tr.b);
    }));
    assert.ok(share(perAnchor) >= 0.9, `equivalent > trap for ${share(perAnchor)}`);
  });

  vtest('negatives: a look-alike question is not connected to the item it resembles (≥ 90 %)', (t) => {
    const canonical = { run: 'How far is a 21 km race?', lang: 'Is Duolingo worth it?', ci: 'Why is CI failing?', career: "How's my career?" };
    const traps = d.queries.filter(q => q.category === 'hard_negative');
    const lower = traps.map(q => {
      const a = anchor(q.owner, q.item);
      const canon = d.queries.find(x => x.owner === q.owner && x.text === canonical[q.item]);
      return fx.cos(q.id, a) < fx.cos(canon.id, a);
    });
    const notFirst = traps.map(q => firstItem(q) !== q.item);
    t.diagnostic(`trap scores below canonical ${share(lower).toFixed(3)} · look-alike item not first ${share(notFirst).toFixed(3)} · n=${traps.length}`);
    assert.ok(share(lower) >= 0.9, `lower ${share(lower)}`);
    assert.ok(share(notFirst) >= 0.9, `not first ${share(notFirst)}`);
  });

  vtest('negatives: unrelated questions never reach the cosine of a relevant paraphrase match', (t) => {
    const bad = [];
    for (const o of owners) {
      const rel = d.queries.filter(q => q.owner === o && q.category === 'paraphrase').map(q => fx.cos(q.id, anchor(o, q.item)));
      const bar = median(rel);
      for (const q of d.queries.filter(x => x.owner === o && x.category === 'unrelated')) {
        const top = Math.max(...anchors(o).map(a => fx.cos(q.id, a.id)));
        if (top >= bar) bad.push(`${q.id} ${top.toFixed(3)} ≥ ${bar.toFixed(3)}`);
      }
    }
    assert.deepEqual(bad, []);
  });

  vtest('diagnostic: Lane-6-style margin (top − owner corpus median) per category', (t) => {
    const rows = {};
    for (const q of d.queries) {
      const cs = corpus(q.owner).map(s => fx.cos(q.id, s.id)).sort((a, b) => b - a);
      (rows[q.category] ??= []).push(cs[0] - cs[Math.floor(cs.length / 2)]);
    }
    for (const [cat, ms] of Object.entries(rows)) t.diagnostic(`${cat}: margin median ${median(ms).toFixed(3)} · ≥0.15 in ${share(ms.map(m => m >= 0.15)).toFixed(3)} (n=${ms.length})`);
    assert.ok(true);
  });
});
