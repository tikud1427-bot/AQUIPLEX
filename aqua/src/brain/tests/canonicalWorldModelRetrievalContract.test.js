/** E7 -> E8 canonical World Model retrieval contract.
 * Static boundary tests keep this runnable without pgvector/provider deps.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

describe('canonical World Model retrieval closure', () => {
  test('canonical commit creates an explicit claim-id retrieval bridge', () => {
    const src = read('core/worldModel/worldModelRepository.js');
    assert.match(src, /aqua_claim_retrieval_bridge/);
    assert.match(src, /retrieval_key\) VALUES \(\$1,\$2,\$3\)/);
    assert.match(src, /String\(claimId\)/);
  });

  test('dense E7 can admit canonical claims without a legacy fact row', () => {
    const src = read('brain/contextEngine/index.js');
    assert.match(src, /Canonical World Model candidate/);
    assert.match(src, /deps\.canonicalClaimsById/);
    assert.match(src, /canonical\.statementText/);
    assert.match(src, /canonical\.state === 'superseded'/);
  });

  test('small canonical corpora bypass the legacy 60-candidate dense gate', () => {
    const src = read('brain/contextEngine/index.js');
    assert.match(src, /canonicalClaimsById/);
    assert.match(src, /!canonicalClaimsById\?\.size && semanticScores\.size < 60/);
    assert.match(src, /!canonicalClaimsById\?\.size && margin < 0\.15/);
  });

  test('Brain hydrates canonical claims at the async retrieval seam', () => {
    const src = read('brain/index.js');
    assert.match(src, /claimWithEvidence/);
    assert.match(src, /canonicalClaimsById/);
    assert.match(src, /Object\.defineProperty\(scores, 'canonicalClaimsById'/);
  });
});
