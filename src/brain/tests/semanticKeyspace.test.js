/**
 * Embedding key must equal retrieval identity — blueprint §10.
 *
 * 🔴 THE DEFECT THIS PINS
 * -----------------------
 * `semanticFactScores` embeds LONG-TERM MEMORY facts. `factText()` builds
 * `"key: value"` strings and the vectors are keyed by the LTM mind fact key —
 * `workplace`, `cofounder`, `custom_biggest_constraint`.
 *
 * The Context Engine ranks EVIDENCE-STORE facts and reads the score with
 * `ctx.semanticScores.get(candidate.semanticId)`, where `semanticId` is an
 * evidence-store fact id. Two stores, two namespaces, no overlap by
 * construction — every lookup missed, on every turn, since the dimension was
 * added.
 *
 * It survived because a miss falls through to token Jaccard, so
 * `semantic_similarity` — weighted 0.20, second-heaviest of eleven — has been
 * reporting lexical overlap under an embedding's name. Nothing failed. Nothing
 * measured it. Nothing compared the two keyspaces, which is the only check that
 * could have caught it.
 *
 * BITE, MEASURED (revert the named change → count failures):
 *   chat.js passes null to the Context Engine   → 2 fail
 *   the LTM consumer keeps its correct map      → 1 fail
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scoreCandidate } from '../contextEngine/scorer.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHAT = readFileSync(path.join(HERE, '../../routes/chat.js'), 'utf8');
const SEMANTIC = readFileSync(path.join(HERE, '../../embeddings/semanticMemory.js'), 'utf8');

describe('the two keyspaces are different, and the seam knows it', () => {
  test('embeddings are keyed by the LTM fact key, not an evidence-store id', () => {
    // `f.key` comes from `getFacts(ownerId)` — longTermMemory mind facts.
    assert.match(SEMANTIC, /upsert\(ownerId, t\.key, vecs\[i\], t\.hash\)/,
      'the vector key is no longer the LTM fact key — re-read this whole file');
    assert.match(SEMANTIC, /`\$\{key\}: \$\{String\(val \?\? ''\)\.trim\(\)\}`/,
      'factText no longer embeds "key: value" — the corpus may have changed');
  });

  test('the Context Engine looks up by evidence-store fact id', () => {
    const scorer = readFileSync(path.join(HERE, '../contextEngine/scorer.js'), 'utf8');
    assert.match(scorer, /ctx\.semanticScores\.get\(candidate\.semanticId\)/);
    const ce = readFileSync(path.join(HERE, '../contextEngine/index.js'), 'utf8');
    assert.match(ce, /semanticId: it\.id/, 'floor lane no longer keys on the fact id');
  });

  test('chat.js does NOT hand the LTM map to the Context Engine', () => {
    // The fix. Not a behaviour change — a map whose every lookup misses and no
    // map at all reach the same fallback — but the code now states the truth
    // instead of implying a dense signal that cannot exist.
    const ceCall = CHAT.slice(CHAT.indexOf('Brain.assembleContext'), CHAT.indexOf('activeProjectId: workspaceId'));
    assert.match(ceCall, /semanticScores: null/,
      'the Context Engine is being fed a map keyed for a different store');
    assert.ok(!/semanticScores: await semanticScoresP/.test(ceCall),
      'the LTM-keyed map must not reach the Context Engine');
  });

  test('the LTM consumer still gets its map — it was never the broken half', () => {
    // memoryRetrieve ranks LTM facts by LTM key. That pairing is correct and
    // must not be collateral damage of fixing the other one.
    assert.match(CHAT, /semanticScores: await semanticScoresP,\s*\/\/ Phase 2/,
      'the correct consumer lost its scores');
  });
});

describe('passing null changes nothing today, and that is the point', () => {
  const cand = (over = {}) => ({
    kind: 'fact', id: 'f001', text: 'I run product at Nummo.', confidence: 0.6,
    sourceType: 'conversation', entityIds: [], hops: null, timestamp: null,
    semanticId: 'f001', relevance: null, ...over,
  });
  const ctx = (semanticScores) => ({
    queryTokens: new Set(['run', 'product']), priorEntityIds: new Set(),
    focusEntityIds: new Set(), semanticScores,
  });

  test('a map that never hits scores identically to no map at all', () => {
    // The evidence that this fix is safe. The old behaviour was already the
    // fallback; only the honesty of the code changed.
    const wrongKeyspace = new Map([['workplace', 0.93], ['cofounder', 0.81]]);
    const withMap = scoreCandidate(cand(), ctx(wrongKeyspace)).dimensions.semantic_similarity;
    const withNull = scoreCandidate(cand(), ctx(null)).dimensions.semantic_similarity;
    assert.equal(withMap, withNull);
  });

  test('a CORRECTLY keyed map does change the score — the dimension works', () => {
    // Guards against concluding the dimension is broken rather than unfed.
    // E7/PR-3 supplies claim-keyed vectors; this proves they will land.
    const rightKeyspace = new Map([['f001', 0.93]]);
    const withRight = scoreCandidate(cand(), ctx(rightKeyspace)).dimensions.semantic_similarity;
    const withNull = scoreCandidate(cand(), ctx(null)).dimensions.semantic_similarity;
    assert.equal(withRight, 0.93);
    assert.notEqual(withRight, withNull);
  });
});
