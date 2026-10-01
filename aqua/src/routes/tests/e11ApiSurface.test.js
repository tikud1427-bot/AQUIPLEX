import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AQUA = path.resolve(HERE, '../../..');
const ROOT = path.resolve(AQUA, '..');

const platform = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
const router = fs.readFileSync(path.join(AQUA, 'router.js'), 'utf8');
const envelope = fs.readFileSync(path.join(AQUA, 'src/routes/envelope.js'), 'utf8');

/**
 * E11 foundation contract.
 *
 * This test intentionally inspects the wiring instead of importing the whole
 * HTTP application: the full server imports the provider stack and is not the
 * right unit boundary for a route-alias invariant.
 */
test('E11 — /v1 is an alias over the existing AQUA route tree', () => {
  assert.match(platform, /app\.use\("\/v1", \.\.\.aquaAccess\)/,
    'the blueprint /v1 surface must be mounted');
  const alias = platform.indexOf('aquaEngine.use("/v1", m.default)');
  const legacy = platform.indexOf('aquaEngine.use(m.default)');
  assert.ok(alias >= 0, 'engine-level /v1 alias is missing');
  assert.ok(legacy >= 0, 'legacy AQUA mount is missing');
  assert.ok(alias < legacy, 'the engine-level alias must mount before the terminal legacy 404 tree');

  assert.match(platform, /const routePath = req\.path\.replace\(\/\^\\\/v1/,
    'usage metering must normalize the /v1 prefix');
  assert.match(platform, /console\.log\("✅ AQUA engine mounted at \/api\/aqua \+ \/v1 \(single route tree\)"\)/);
});

test('E11 — legacy and v1 errors use one closed taxonomy', () => {
  assert.match(router, /import \{ fail, ErrorCodes \} from "\.\/src\/routes\/envelope\.js"/);
  assert.match(router, /return fail\(res, ErrorCodes\.NOT_FOUND/);
  assert.match(router, /PAYLOAD_TOO_LARGE/);
  assert.match(envelope, /PAYLOAD_TOO_LARGE: 'payload_too_large'/);
  assert.match(envelope, /\[ErrorCodes\.PAYLOAD_TOO_LARGE\]: 413/);
});

test('E11 — the shared router is the only route implementation', () => {
  const mounts = [...platform.matchAll(/aquaEngine\.use\((?:"\/v1", )?m\.default\)/g)];
  assert.equal(mounts.length, 2, 'expected exactly the v1 alias + legacy mount');
  assert.equal((platform.match(/import\("\.\/aqua\/router\.js"\)/g) || []).length, 1,
    'the platform must load one AQUA route tree, not two copies');
});
