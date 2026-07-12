/**
 * Phase 1 security — secretGuard unit tests.
 * Run: node src/project/tests/secretGuard.test.js
 */
import assert from 'node:assert';
import { isSecretFile, redactSecrets } from '../secretGuard.js';
import { shouldIgnore, ingestFiles } from '../fileIngester.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  \u2713 ${name}`); }
  catch (e) { failed++; console.error(`  \u2717 ${name}\n    ${e.message}`); }
}

console.log('secretGuard.isSecretFile');

test('rejects root .env', () => assert.equal(isSecretFile('.env'), true));
test('rejects nested .env', () => assert.equal(isSecretFile('backend/.env'), true));
test('rejects .env.production', () => assert.equal(isSecretFile('.env.production'), true));
test('rejects .env.local', () => assert.equal(isSecretFile('config/.env.local'), true));
test('rejects service.env', () => assert.equal(isSecretFile('service.env'), true));
test('ALLOWS .env.example', () => assert.equal(isSecretFile('.env.example'), false));
test('ALLOWS .env.sample', () => assert.equal(isSecretFile('.env.sample'), false));
test('ALLOWS .env.template', () => assert.equal(isSecretFile('.env.template'), false));
test('rejects *.pem', () => assert.equal(isSecretFile('certs/server.pem'), true));
test('rejects *.key', () => assert.equal(isSecretFile('tls/private.key'), true));
test('rejects id_rsa', () => assert.equal(isSecretFile('.ssh/id_rsa'), true));
test('rejects id_ed25519', () => assert.equal(isSecretFile('id_ed25519'), true));
test('rejects .npmrc', () => assert.equal(isSecretFile('.npmrc'), true));
test('rejects service-account json', () => assert.equal(isSecretFile('gcp-service-account.json'), true));
test('ALLOWS normal source .js', () => assert.equal(isSecretFile('src/index.js'), false));
test('ALLOWS package.json', () => assert.equal(isSecretFile('package.json'), false));
test('ALLOWS environment.ts (not an env file)', () => assert.equal(isSecretFile('src/environment.ts'), false));
test('handles backslash paths', () => assert.equal(isSecretFile('backend\\.env'), true));

console.log('fileIngester.shouldIgnore now rejects secrets');
test('shouldIgnore(.env) === true', () => assert.equal(shouldIgnore('.env'), true));
test('shouldIgnore(backend/.env) === true', () => assert.equal(shouldIgnore('backend/.env'), true));
test('shouldIgnore(.env.example) === false', () => assert.equal(shouldIgnore('.env.example'), false));

console.log('secretGuard.redactSecrets — high confidence');

test('redacts PEM private key block', () => {
  const src = 'const k = `-----BEGIN RSA PRIVATE KEY-----\nMIIEabc123\nDEF456\n-----END RSA PRIVATE KEY-----`;';
  const { content, redactions } = redactSecrets(src);
  assert.equal(redactions, 1);
  assert.ok(!content.includes('MIIEabc123'));
  assert.ok(content.includes('[REDACTED-SECRET]'));
});
test('redacts OPENSSH private key block', () => {
  const src = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----';
  assert.equal(redactSecrets(src).redactions, 1);
});
test('redacts AWS access key id', () => {
  const { content, redactions } = redactSecrets('aws_key = "AKIAIOSFODNN7EXAMPLE"');
  assert.equal(redactions, 1);
  assert.ok(!content.includes('AKIAIOSFODNN7EXAMPLE'));
});
test('redacts GitHub token', () => {
  assert.equal(redactSecrets('token ghp_' + 'a'.repeat(36)).redactions, 1);
});
test('redacts Google API key', () => {
  assert.equal(redactSecrets('AIza' + 'B'.repeat(35)).redactions, 1);
});
test('redacts OpenRouter sk-or key', () => {
  assert.equal(redactSecrets('key: sk-or-' + 'c'.repeat(24)).redactions, 1);
});
test('redacts Stripe live key', () => {
  assert.equal(redactSecrets('sk_live_' + 'd'.repeat(24)).redactions, 1);
});

console.log('secretGuard.redactSecrets — assignment + placeholder guards');

test('redacts value of API_KEY assignment, keeps key name', () => {
  const { content, redactions } = redactSecrets('API_KEY=sup3rSecretV4lue1234');
  assert.equal(redactions, 1);
  assert.ok(content.startsWith('API_KEY='));
  assert.ok(!content.includes('sup3rSecretV4lue1234'));
});
test('redacts DATABASE_PASSWORD assignment', () => {
  assert.equal(redactSecrets("DATABASE_PASSWORD: 'hunter2hunter2hunter2'").redactions, 1);
});
test('does NOT redact placeholder your_api_key_here', () => {
  assert.equal(redactSecrets('API_KEY=your_api_key_here').redactions, 0);
});
test('does NOT redact process.env reference', () => {
  assert.equal(redactSecrets('API_KEY = process.env.API_KEY').redactions, 0);
});
test('does NOT redact ${VAR} reference', () => {
  assert.equal(redactSecrets('CLIENT_SECRET=${CLIENT_SECRET}').redactions, 0);
});
test('does NOT redact short values', () => {
  assert.equal(redactSecrets('TOKEN=abc').redactions, 0);
});
test('does NOT touch ordinary code', () => {
  const src = 'function add(a, b) { return a + b; } // computes a sum, no secrets here at all';
  assert.equal(redactSecrets(src).redactions, 0);
});
test('does NOT redact a variable literally named apiKey with short value', () => {
  assert.equal(redactSecrets('const apiKey = "test";').redactions, 0);
});

console.log('end-to-end: ingestFiles drops .env, redacts inline secret');
await (async () => {
  const out = await ingestFiles([
    { path: '.env', content: 'DB_PASSWORD=realproductionpassword123' },
    { path: '.env.example', content: 'DB_PASSWORD=your_password_here' },
    { path: 'src/config.js', content: 'export const AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY";' },
    { path: 'src/app.js', content: 'export const port = 3000;' },
  ]);
  const byPath = Object.fromEntries(out.map(f => [f.path, f]));
  test('.env was NOT ingested', () => assert.ok(!byPath['.env']));
  test('.env.example WAS ingested (template)', () => assert.ok(byPath['.env.example']));
  test('config.js ingested but secret redacted', () => {
    assert.ok(byPath['src/config.js']);
    assert.ok(!byPath['src/config.js'].content.includes('wJalrXUtnFEMIK'));
    assert.ok(byPath['src/config.js'].content.includes('[REDACTED-SECRET]'));
  });
  test('clean source untouched', () => assert.ok(byPath['src/app.js'].content.includes('port = 3000')));
})();

console.log(`\nsecretGuard: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
