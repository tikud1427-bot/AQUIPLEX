import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { reciprocalRankFusion, rerankWithFusion, lanesFromCandidates } from '../contextEngine/retrievalV3.js';

describe('E7 retrieval V3 fusion', () => {
  test('RRF rewards candidates appearing in multiple lanes', () => {
    const fused = reciprocalRankFusion([
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      [{ id: 'c' }, { id: 'a' }, { id: 'd' }],
    ], { k: 1 });
    assert.equal(fused[0].id, 'a');
    assert.equal(fused[0].laneCount, 2);
    assert.equal(fused.find(x => x.id === 'c').laneCount, 2);
    assert.ok(fused.find(x => x.id === 'a').rrf > fused.find(x => x.id === 'b').rrf);
  });

  test('duplicate entries inside one lane count only once', () => {
    const fused = reciprocalRankFusion([[{ id: 'a' }, { id: 'a' }, { id: 'b' }]], { k: 60 });
    assert.equal(fused.find(x => x.id === 'a').laneCount, 1);
    assert.equal(fused.length, 2);
  });

  test('lane grouping is deterministic', () => {
    const rows = lanesFromCandidates([
      { id: 'a', score: .9, via: 'lexical' },
      { id: 'b', score: .8, via: 'dense: 0.9' },
      { id: 'c', score: .7, via: 'graph: about Nummo' },
    ]);
    assert.deepEqual(rows.map(x => x.name), ['lexical', 'dense', 'graph']);
    assert.equal(rows[1].rows[0].id, 'b');
  });

  test('rerank only breaks close score ties', () => {
    const fused = reciprocalRankFusion([[{ id: 'b' }, { id: 'a' }]], { k: 60 });
    const out = rerankWithFusion([
      { id: 'a', score: .800 },
      { id: 'b', score: .801 },
    ], fused, { tieEpsilon: .01, fusionWeight: .12 });
    assert.equal(out[0].id, 'b');

    const far = rerankWithFusion([
      { id: 'a', score: .90 },
      { id: 'b', score: .50 },
    ], fused, { tieEpsilon: .01, fusionWeight: .5 });
    assert.equal(far[0].id, 'a');
  });
});
