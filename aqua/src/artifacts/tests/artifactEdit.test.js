/**
 * P5 — edit engine + version-append store semantics. Offline: injected
 * `generate` stubs play the provider. The invariants that matter:
 *   • v1 stays byte-identical after any edit (immutable snapshots)
 *   • a FAILED edit leaves version/manifest untouched (atomicity)
 *   • untouched files in a file-edit are byte-identical copies in vN+1
 *   • binary edits go through the persisted MODEL and re-render
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-artifact-p5-'));
process.env.AQUA_ARTIFACTS_DIR = TMP;

const store  = await import('../artifactStore.js');
const engine = await import('../engine.js');
const { editArtifact, regenerateArtifact } = await import('../editEngine.js');
const { matchTargetsByName } = await import('../editEngine.js');
const { detectArtifactEditIntent } = await import('../artifactIntent.js');

before(() => store._resetForTests());
after(() => {
  store._resetForTests();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

async function makeProjectArtifact() {
  return store.createArtifact({
    ownerId: 'user:u1', conversationId: 'c-p5', requestId: 'r-p5a',
    format: 'project', title: 'Todo API', packaging: 'zip',
    spec: {
      format: 'project', title: 'Todo API', packaging: 'zip',
      files: [
        { path: 'src/index.js', role: 'primary', description: 'entry' },
        { path: 'README.md',    role: 'doc',     description: 'readme' },
      ],
    },
    files: [
      { path: 'src/index.js', buffer: Buffer.from('const app = 1;\n'), mime: 'text/javascript' },
      { path: 'README.md',    buffer: Buffer.from('# Todo API\nOld intro.\n'), mime: 'text/markdown' },
    ],
  });
}

const SLIDES_MODEL = {
  title: 'AQUA Deck', subtitle: 'sub', theme: 'light',
  slides: [
    { title: 'Problem',  bullets: ['old bullet'], notes: '' },
    { title: 'Solution', bullets: ['routing'],    notes: '' },
  ],
};

async function makePptxArtifact() {
  const px = (await import('../exporters/registry.js')).getExporter('pptx');
  const spec = { format: 'pptx', title: 'AQUA Deck', packaging: 'raw', files: [{ path: 'deck.pptx', role: 'primary' }] };
  const model = await px.build({ spec, helpers: { generateJson: async () => SLIDES_MODEL } });
  const { files } = await px.export(model, { spec });
  return store.createArtifact({
    ownerId: 'user:u1', conversationId: 'c-p5', requestId: 'r-p5b',
    format: 'pptx', title: 'AQUA Deck', packaging: 'raw', spec, files, model,
  });
}

// ── detect ────────────────────────────────────────────────────────────────────

test('detectArtifactEditIntent: edits yes, questions/creations no', () => {
  assert.equal(detectArtifactEditIntent('Change slide 5 to focus on pricing').wants, true);
  assert.equal(detectArtifactEditIntent('fix the heading in the README').wants, true);
  assert.equal(detectArtifactEditIntent('remove the second row from the sheet').wants, true);
  assert.equal(detectArtifactEditIntent('How do I change slide 5?').wants, false);
  assert.equal(detectArtifactEditIntent('Create a pitch deck for my startup').wants, false); // create verb, no edit verb
  assert.equal(detectArtifactEditIntent('change my mind about lunch').wants, false);          // no artifact part
});

test('matchTargetsByName: path and basename mentions', () => {
  const paths = ['src/index.js', 'README.md', 'src/routes.js'];
  assert.deepEqual(matchTargetsByName('fix the bug in src/index.js', paths), ['src/index.js']);
  assert.deepEqual(matchTargetsByName('rewrite the readme.md intro', paths), ['README.md']);
  assert.deepEqual(matchTargetsByName('make everything faster', paths), []);
});

// ── FILE edit path ────────────────────────────────────────────────────────────

test('file edit: targeted file rewritten, untouched file byte-identical, v1 immutable', async () => {
  const art = await makeProjectArtifact();
  const v1Index = fs.readFileSync(path.join(TMP, art.id, 'v1', 'src', 'index.js'));

  const updated = await (async () => {
    const r = await editArtifact({
      artifactId: art.id,
      instruction: 'In README.md, replace the intro line with "New intro."',
      requestId: 'r-edit1', conversationId: 'c-p5',
      generate: async (_u, sys) => {
        assert.ok(!sys.includes('select which files'), 'name match must skip LLM selection');
        return { text: '# Todo API\nNew intro.\n', provider: 'stub-edit' };
      },
    });
    return r;
  })();

  assert.equal(updated.manifest.version, 2);
  assert.deepEqual(updated.changed, ['README.md']);
  assert.equal(updated.manifest.versions.length, 2);
  assert.ok(updated.manifest.versions[0].files, 'v1 entry carries per-version metas');

  // v2 contents
  const v2Readme = fs.readFileSync(path.join(TMP, art.id, 'v2', 'README.md'), 'utf8');
  assert.match(v2Readme, /New intro/);
  const v2Index = fs.readFileSync(path.join(TMP, art.id, 'v2', 'src', 'index.js'));
  assert.deepEqual(v2Index, v1Index, 'untouched file is a byte-identical copy');

  // v1 untouched on disk
  assert.equal(fs.readFileSync(path.join(TMP, art.id, 'v1', 'README.md'), 'utf8'), '# Todo API\nOld intro.\n');

  // old-version metas resolve
  const full = await store.getArtifact(art.id);
  const v1Metas = store.getVersionFileMetas(full, 1);
  assert.equal(v1Metas.find(f => f.path === 'README.md').size, Buffer.from('# Todo API\nOld intro.\n').length);
});

test('file edit: LLM selection path when no filename is named', async () => {
  const art = await makeProjectArtifact();
  let selectionCalls = 0;
  const r = await editArtifact({
    artifactId: art.id,
    instruction: 'Make the entry point export the app instead of a number',
    requestId: 'r-edit2', conversationId: 'c-p5',
    generate: async (_u, sys) => {
      if (sys.includes('select which files')) {
        selectionCalls += 1;
        return { text: '["src/index.js"]', provider: 'stub-sel' };
      }
      return { text: 'export const app = {};\n', provider: 'stub-edit' };
    },
  });
  assert.equal(selectionCalls, 1);
  assert.deepEqual(r.changed, ['src/index.js']);
  assert.match(fs.readFileSync(path.join(TMP, art.id, 'v2', 'src', 'index.js'), 'utf8'), /export const app/);
});

test('file edit: failure (empty rewrite) leaves version + files untouched', async () => {
  const art = await makeProjectArtifact();
  await assert.rejects(() => editArtifact({
    artifactId: art.id,
    instruction: 'rewrite README.md',
    requestId: 'r-edit3', conversationId: 'c-p5',
    generate: async () => ({ text: '   ', provider: 'stub' }),
  }));
  const lite = store.getArtifactLite(art.id);
  assert.equal(lite.version, 1, 'no version appended on failure');
  assert.ok(!fs.existsSync(path.join(TMP, art.id, 'v2')), 'no v2 dir left behind');
});

// ── MODEL edit path (pptx) ────────────────────────────────────────────────────

test('model edit: pptx "change slide" edits the persisted model and re-renders', async () => {
  const art = await makePptxArtifact();
  assert.ok(art.model, 'binary create persisted the content model');

  const edited = { ...SLIDES_MODEL, slides: [
    { title: 'Pricing', bullets: ['₹499/month'], notes: '' },
    SLIDES_MODEL.slides[1],
  ] };

  const r = await editArtifact({
    artifactId: art.id,
    instruction: 'Change slide 1 to be about pricing at 499 per month',
    requestId: 'r-edit4', conversationId: 'c-p5',
    generate: async (_u, sys) => {
      assert.ok(sys.includes('CONTENT MODEL'), 'model-edit prompt used');
      assert.ok(sys.includes('"slides"'), 'schemaHint included');
      return { text: JSON.stringify(edited), provider: 'stub-model' };
    },
  });

  assert.equal(r.manifest.version, 2);
  assert.deepEqual(r.changed, ['model']);
  assert.deepEqual(r.manifest.model.slides[0].title, 'Pricing', 'updated model persisted');

  const buf = fs.readFileSync(path.join(TMP, art.id, 'v2', 'deck.pptx'));
  const xml = new AdmZip(buf).getEntries()
    .filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .map(e => e.getData().toString('utf8')).join('');
  assert.ok(xml.includes('Pricing'), 'new binary reflects the edit');
  // v1 binary untouched
  const v1xml = new AdmZip(fs.readFileSync(path.join(TMP, art.id, 'v1', 'deck.pptx'))).getEntries()
    .filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .map(e => e.getData().toString('utf8')).join('');
  assert.ok(v1xml.includes('Problem') && !v1xml.includes('Pricing'));
});

test('model edit: garbage model JSON twice → throws, version unchanged', async () => {
  const art = await makePptxArtifact();
  await assert.rejects(
    () => editArtifact({
      artifactId: art.id, instruction: 'change slide 1',
      requestId: 'r-edit5', conversationId: 'c-p5',
      generate: async () => ({ text: 'not json at all', provider: 'stub' }),
    }),
    (err) => err.code === 'ARTIFACT_EDIT_INVALID',
  );
  assert.equal(store.getArtifactLite(art.id).version, 1);
});

// ── Regenerate ────────────────────────────────────────────────────────────────

test('regenerate single file: fresh target, byte-identical siblings, v3 chain', async () => {
  const art = await makeProjectArtifact();
  // one edit first → v2
  await editArtifact({
    artifactId: art.id, instruction: 'update README.md intro',
    requestId: 'r-r1', conversationId: 'c-p5',
    generate: async () => ({ text: '# Todo API\nv2 intro\n', provider: 's' }),
  });
  const r = await regenerateArtifact({
    artifactId: art.id, path: 'src/index.js',
    requestId: 'r-r2', conversationId: 'c-p5',
    generate: async () => ({ text: 'const app = "fresh";\n', provider: 's' }),
  });
  assert.equal(r.manifest.version, 3);
  assert.deepEqual(r.changed, ['src/index.js']);
  assert.match(fs.readFileSync(path.join(TMP, art.id, 'v3', 'src', 'index.js'), 'utf8'), /fresh/);
  assert.equal(fs.readFileSync(path.join(TMP, art.id, 'v3', 'README.md'), 'utf8'), '# Todo API\nv2 intro');
});

test('regenerate: single-file scope rejected for binary formats', async () => {
  const art = await makePptxArtifact();
  await assert.rejects(
    () => regenerateArtifact({ artifactId: art.id, path: 'deck.pptx', requestId: 'r-r3' }),
    (err) => err.code === 'ARTIFACT_REGEN_SCOPE',
  );
});

// ── public manifest contract ──────────────────────────────────────────────────

test('publicManifest exposes version history but never the spec/model/file hashes', async () => {
  const { publicManifest } = await import('../engine.js');
  const art = await makeProjectArtifact();
  await editArtifact({
    artifactId: art.id, instruction: 'update README.md intro',
    requestId: 'r-pm', conversationId: 'c-p5',
    generate: async () => ({ text: '# Todo API\npm intro\n', provider: 's' }),
  });
  const full = await store.getArtifact(art.id);
  const pub  = publicManifest(full);

  assert.equal(pub.version, 2);
  assert.deepEqual(pub.versions.map(v => v.v), [1, 2], 'clients can offer old versions');
  assert.equal(pub.versions[1].reason, 'update README.md intro');
  assert.ok(typeof pub.versions[0].bytes === 'number');
  assert.ok(!('files' in pub.versions[0]), 'per-version file metas stay server-side');
  assert.equal(pub.spec, undefined, 'spec never leaks');
  assert.equal(pub.model, undefined, 'model never leaks');
  assert.ok(!('sha256' in pub.files[0]), 'file hashes stay server-side');
});

// ── diskBytes quota accounting ────────────────────────────────────────────────

test('lite.diskBytes sums every version', async () => {
  const art = await makeProjectArtifact();
  const before = store.getArtifactLite(art.id).diskBytes;
  await editArtifact({
    artifactId: art.id, instruction: 'update README.md',
    requestId: 'r-q1', conversationId: 'c-p5',
    generate: async () => ({ text: '# Todo API\nquota intro\n', provider: 's' }),
  });
  const lite = store.getArtifactLite(art.id);
  assert.ok(lite.diskBytes > before, 'disk accounting grew with the new version');
  assert.ok(lite.diskBytes > lite.totalBytes, 'diskBytes counts all versions, totalBytes only the latest');
});
