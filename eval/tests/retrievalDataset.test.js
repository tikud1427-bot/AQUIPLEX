/**
 * AQUA Eval — retrieval dataset integrity
 * Blueprint E2/PR-4
 *
 * Same reasoning as the extraction dataset: this is the measuring stick, and a
 * metric that improved because three hard queries were quietly deleted is
 * worse than no metric. Shape, census and the adversarial thresholds are all
 * pinned.
 *
 * The adversarial categories are pinned hardest, because they are the ones a
 * future rebalance would be tempted to trim — they are the queries that make
 * the engine look worst, and they are the queries derived from failures this
 * codebase has actually shipped.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateRetrievalDataset, retrievalCensus, RetrievalDatasetError,
  QUERY_CATEGORIES, ANSWER_KINDS,
} from '../datasets/retrievalSchema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DS = JSON.parse(readFileSync(path.join(HERE, '../datasets/retrieval-core.v1.json'), 'utf8'));
const byCat = cat => DS.queries.filter(q => q.cat === cat);

// ── Shape ────────────────────────────────────────────────────────────────────

describe('retrieval dataset — shape', () => {
  test('validates against its own schema', () => {
    assert.equal(validateRetrievalDataset(DS), true);
  });

  test('is 60 corpus facts and 200 queries', () => {
    assert.equal(DS.corpus.length, 60);
    assert.equal(DS.queries.length, 200);
  });

  test('the category census is pinned', () => {
    assert.deepEqual(retrievalCensus(DS), {
      direct: 55, category: 32, multi: 28, temporal: 25, superseded: 10,
      negation: 10, selfword: 15, stopword: 10, unknown: 15,
    });
  });

  test('every relevance judgment points at a real fact', () => {
    const ids = new Set(DS.corpus.map(f => f.id));
    for (const q of DS.queries) {
      for (const fid of [...q.relevant, ...q.acceptable]) {
        assert.ok(ids.has(fid), `${q.id} references missing fact ${fid}`);
      }
    }
  });

  test('ids and texts are unique on both sides', () => {
    assert.equal(new Set(DS.corpus.map(f => f.id)).size, 60);
    assert.equal(new Set(DS.corpus.map(f => f.statement)).size, 60);
    assert.equal(new Set(DS.queries.map(q => q.id)).size, 200);
    assert.equal(new Set(DS.queries.map(q => q.q.toLowerCase())).size, 200);
  });

  test('every declared category and answer kind is used', () => {
    const cats = new Set(DS.queries.map(q => q.cat));
    for (const c of QUERY_CATEGORIES) assert.ok(cats.has(c), `category "${c}" declared but unused`);
    const kinds = new Set(DS.queries.map(q => q.kind));
    for (const k of ANSWER_KINDS) assert.ok(kinds.has(k), `answer kind "${k}" declared but unused`);
  });
});

// ── The adversarial set — this project's own scar tissue ────────────────────

describe('retrieval dataset — the adversarial set stays hard', () => {
  test('silence is expected on a sixth of the queries', () => {
    // Without silence-expecting queries, an engine that always returns
    // something scores perfectly and cannot be told apart from one that knows.
    const silent = DS.queries.filter(q => q.relevant.length === 0);
    assert.ok(silent.length >= 30, `only ${silent.length} silence-expecting queries`);
    assert.ok(silent.every(q => q.kind === 'none' && q.acceptable.length === 0));
  });

  test('the selfword category carries the exact query that produced 7 noise lines', () => {
    // The self entity is labelled with the literal word "You", so a request
    // merely CONTAINING "you" matched it. Seven of nine noise lines in the
    // rollout harness came from this one query.
    const q = byCat('selfword').find(x => x.q === 'Can you write me a python script?');
    assert.ok(q, 'the canonical selfword query is missing');
    assert.equal(q.relevant.length, 0, 'it must expect silence');
    assert.match(q.note ?? '', /noise/i);
  });

  test('selfword queries are split between answerable and silence', () => {
    // Both halves matter: suppressing noise is easy if you also suppress the
    // genuine "what do you know about me" answers, and that trade is exactly
    // what the self-label fix had to avoid.
    const sw = byCat('selfword');
    assert.ok(sw.filter(q => q.relevant.length === 0).length >= 5, 'no silent selfword queries');
    assert.ok(sw.filter(q => q.relevant.length > 0).length >= 5, 'no answerable selfword queries');
  });

  test('stopword queries share only stopwords with the corpus', () => {
    const STOP = new Set(['what', 'is', 'the', 'of', 'a', 'in', 'are', 'do', 'how', 'who', 'to',
      'and', 'on', 'this', 'be', 'going', 'between', 'won', 'best', 'rules', 'year', 'good']);
    const corpusWords = new Set(DS.corpus.flatMap(f =>
      f.statement.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean)));
    for (const q of byCat('stopword')) {
      const overlap = q.q.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/)
        .filter(w => w && corpusWords.has(w) && !STOP.has(w));
      assert.deepEqual(overlap, [], `${q.id} shares content words with the corpus: ${overlap}`);
      assert.equal(q.relevant.length, 0);
    }
  });

  test('the superseded trap exists in the corpus and is never the answer', () => {
    const outdated = DS.corpus.filter(f => f.supersededBy);
    assert.ok(outdated.length >= 1, 'no superseded fact — the temporal trap is absent');
    for (const q of byCat('superseded')) {
      for (const fid of q.relevant) {
        const fact = DS.corpus.find(f => f.id === fid);
        assert.ok(!fact.supersededBy, `${q.id} marks the OUTDATED fact ${fid} as the answer`);
      }
    }
  });

  test('category queries have no lexical shortcut to their answer', () => {
    // The category/instance gap: "what is my job" against "I run product at
    // Nummo". If a content word overlapped, lexical matching would find it and
    // the category would measure nothing.
    const STOP = new Set(['what', 'is', 'my', 'the', 'i', 'do', 'am', 'which', 'who', 'where',
      'a', 'of', 'in', 'to', 'at', 'and', 'me', 'we', 'our', 'like', 'go', 'does', 'kind', 'how', 'all', 'day']);
    let shortcutFree = 0;
    for (const q of byCat('category')) {
      const qw = new Set(q.q.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w)));
      const overlaps = q.relevant.some(fid => {
        const fw = DS.corpus.find(f => f.id === fid).statement.toLowerCase()
          .replace(/[^a-z\s]/g, ' ').split(/\s+/);
        return fw.some(w => qw.has(w));
      });
      if (!overlaps) shortcutFree++;
    }
    assert.ok(shortcutFree >= byCat('category').length * 0.6,
      `only ${shortcutFree}/${byCat('category').length} category queries lack a lexical shortcut`);
  });

  test('multi queries really need more than one fact', () => {
    for (const q of byCat('multi')) {
      assert.ok(q.relevant.length >= 2, `${q.id} is labelled multi but has one relevant fact`);
    }
  });
});

// ── Corpus realism ───────────────────────────────────────────────────────────

describe('retrieval dataset — the corpus resembles a real world model', () => {
  test('both source tiers are present — ranking uses them', () => {
    const conv = DS.corpus.filter(f => f.sourceType === 'conversation').length;
    const doc = DS.corpus.filter(f => f.sourceType === 'document').length;
    assert.ok(conv >= 30 && doc >= 10, `conversation ${conv}, document ${doc}`);
  });

  test('document facts carry higher confidence than chat facts', () => {
    // The trust tier the engine actually applies: file 0.9 > chat 0.6.
    const maxConv = Math.max(...DS.corpus.filter(f => f.sourceType === 'conversation').map(f => f.confidence));
    const minDoc = Math.min(...DS.corpus.filter(f => f.sourceType === 'document').map(f => f.confidence));
    assert.ok(minDoc >= maxConv, 'a chat fact outranks a document fact — the trust tiers are inverted');
  });

  test('the self entity appears under the label the engine actually uses', () => {
    // "You" is load-bearing: `about` edges key off it, and it is why the
    // selfword category exists at all. The corpus has to carry it or the
    // adversarial set is testing a world that does not match production.
    const selfFacts = DS.corpus.filter(f => f.entities.includes('You'));
    assert.ok(selfFacts.length >= 20, `only ${selfFacts.length} facts carry the self entity`);
  });

  test('facts without entities are absent — the lane cannot store them', () => {
    for (const f of DS.corpus) {
      assert.ok(f.entities.length > 0, `${f.id} has no entities and could never have been written`);
    }
  });
});

// ── Honesty ──────────────────────────────────────────────────────────────────

describe('retrieval dataset — states its own limitations', () => {
  test('it admits it is synthetic and small', () => {
    const text = DS.limitations.join(' ');
    assert.match(text, /SYNTHETIC/);
    assert.match(text, /SMALL corpus/);
    assert.match(text, /upper bound/);
  });

  test('it names RETRIEVE-SCALE as the missing companion', () => {
    // Every retrieval number in this project has been measured on a tiny
    // corpus. Saying so in the dataset is what stops the figure being quoted
    // as if it held at 5,000 facts.
    assert.match(DS.limitations.join(' '), /RETRIEVE-SCALE/);
  });

  test('it admits one annotator and single-turn scope', () => {
    const text = DS.limitations.join(' ');
    assert.match(text, /One annotator/);
    assert.match(text, /single-turn/);
  });
});

// ── The validator bites ──────────────────────────────────────────────────────

describe('retrieval dataset — the validator refuses bad labels', () => {
  const clone = () => JSON.parse(JSON.stringify(DS));

  test('a query with no relevant facts but a real answer kind is refused', () => {
    const ds = clone();
    ds.queries[0] = { ...ds.queries[0], relevant: [], acceptable: [], kind: 'org' };
    assert.throws(() => validateRetrievalDataset(ds), /asks for no kind/);
  });

  test('an unknown query with a relevant fact is refused', () => {
    const ds = clone();
    const u = ds.queries.find(q => q.cat === 'unknown');
    u.relevant = ['f001'];
    assert.throws(() => validateRetrievalDataset(ds), /must have NO relevant facts/);
  });

  test('a superseded query answered by the outdated fact is refused', () => {
    const ds = clone();
    const s = ds.queries.find(q => q.cat === 'superseded');
    s.relevant = ['f003'];
    assert.throws(() => validateRetrievalDataset(ds), /CURRENT fact/);
  });

  test('a dangling fact reference is refused', () => {
    const ds = clone();
    ds.queries[0].relevant = ['f999'];
    assert.throws(() => validateRetrievalDataset(ds), RetrievalDatasetError);
  });

  test('a fact listed as both relevant and acceptable is refused', () => {
    const ds = clone();
    ds.queries[0] = { ...ds.queries[0], relevant: ['f001'], acceptable: ['f001'] };
    assert.throws(() => validateRetrievalDataset(ds), /both relevant and acceptable/);
  });
});
