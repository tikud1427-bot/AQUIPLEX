import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
test('supersession transition verifies successor owner and rejects self-supersession', () => {
  const src = fs.readFileSync(path.join(ROOT, '../../core/worldModel/worldModelRepository.js'), 'utf8');
  assert.match(src, /assertOwned\(client, 'aqua_claims', 'claim_id', successor, ownerId\)/);
  assert.match(src, /successor === targetId/);
});
