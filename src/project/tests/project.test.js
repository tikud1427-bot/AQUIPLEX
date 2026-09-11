/**
 * AQUA Project Intelligence Engine — Tests
 *
 * Run: node --test src/project/tests/project.test.js
 *
 * Covers:
 *   - file ingestion (ignore rules, language detection, binary filter)
 *   - file parsing (JS/TS/Python symbol extraction)
 *   - project index (build, symbol lookup, keyword lookup)
 *   - dependency graph (local resolution, reverse lookup, cycle detection)
 *   - project summarizer (file summary, project summary)
 *   - project retriever (relevance scoring)
 *   - patch generator (diff formatting)
 *   - incremental: re-index updates index without mixing old entries
 */

import { test, describe } from 'node:test';
import assert              from 'node:assert/strict';

import { detectLanguage, shouldIgnore, detectProjectType, ingestFiles, buildStructure } from '../fileIngester.js';
import { parseFile }       from '../fileParser.js';
import { buildIndex, getIndex, queryIndex, getIndexStats } from '../projectIndex.js';
import { buildDependencyGraph, whoImports, whatImports, detectCycles, serializeGraph } from '../dependencyGraph.js';
import { summarizeFile, summarizeProject, enrichWithSummaries } from '../projectSummarizer.js';
import { retrieveProjectContext, formatProjectContext } from '../projectRetriever.js';
import { createWorkspace, updateWorkspace, getWorkspace, deleteWorkspace } from '../workspaceManager.js';
import { formatPatch } from '../patchGenerator.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function freshWsId() {
  return 'test-ws-' + Math.random().toString(36).slice(2);
}

const SAMPLE_JS = `
import express from 'express';
import { helper } from './utils/helper.js';

/**
 * Main application module.
 */
export class App {
  constructor() {}
  start() {}
}

export function createApp() {
  return new App();
}

export const handler = async (req, res) => res.json({ ok: true });
`.trim();

const SAMPLE_PY = `
from flask import Flask
import json

class UserService:
    def get_user(self, id):
        pass

def create_app():
    return Flask(__name__)
`.trim();

const SAMPLE_TS = `
import { Router } from 'express';
import { AuthService } from './auth.service';

export interface UserPayload {
  id: string;
  role: string;
}

export type JwtToken = string;

export function authenticate(token: string): UserPayload {
  return {} as UserPayload;
}
`.trim();

/** Minimal valid single-page PDF, base64-encoded — for the base64-document
 *  ingestFiles() integration tests below. Full builder + broader format
 *  coverage lives in documentParser.test.js; this is just enough to prove
 *  the ingestFiles() routing/plumbing, not re-test extraction correctness. */
function tinyPdfBase64(text) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 1000 200] /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 24 Tf 72 100 Td (${text}) Tj ET`;
  const streamObj = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  offsets.push(pdf.length);
  pdf += `5 0 obj\n${streamObj}\nendobj\n`;
  const xrefStart = pdf.length;
  let xref = `xref\n0 ${objects.length + 2}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  xref += `${String(offsets[objects.length + 1]).padStart(10, '0')} 00000 n \n`;
  pdf += xref;
  pdf += `trailer\n<< /Size ${objects.length + 2} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'binary').toString('base64');
}

// ── Language detection ────────────────────────────────────────────────────────

describe('detectLanguage', () => {
  test('js extension', () => assert.equal(detectLanguage('src/app.js'), 'javascript'));
  test('ts extension', () => assert.equal(detectLanguage('lib/server.ts'), 'typescript'));
  test('tsx extension', () => assert.equal(detectLanguage('components/Card.tsx'), 'typescript'));
  test('py extension',  () => assert.equal(detectLanguage('main.py'), 'python'));
  test('go extension',  () => assert.equal(detectLanguage('main.go'), 'go'));
  test('rs extension',  () => assert.equal(detectLanguage('src/lib.rs'), 'rust'));
  test('json extension',() => assert.equal(detectLanguage('package.json'), 'json'));
  test('Dockerfile',    () => assert.equal(detectLanguage('Dockerfile'), 'dockerfile'));
  test('unknown ext',   () => assert.equal(detectLanguage('weird.xyz'), 'unknown'));
});

// ── Ignore rules ──────────────────────────────────────────────────────────────

describe('shouldIgnore', () => {
  test('node_modules', () => assert.ok(shouldIgnore('node_modules/express/index.js')));
  test('.git',         () => assert.ok(shouldIgnore('.git/config')));
  test('dist',         () => assert.ok(shouldIgnore('dist/bundle.js')));
  test('lock file',    () => assert.ok(shouldIgnore('package-lock.json')));
  test('png file',     () => assert.ok(shouldIgnore('logo.png')));
  test('src/app.js',   () => assert.ok(!shouldIgnore('src/app.js')));
  // SECURITY (Phase 1): .env now MUST be ignored — it was previously ingested
  // and its secrets leaked into the index + into third-party LLM prompts.
  // Template files carry no real values and stay ingestable.
  test('.env file (secret — ignored)',  () => assert.ok(shouldIgnore('.env')));
  test('.env.example (template — kept)', () => assert.ok(!shouldIgnore('.env.example')));
  test('readme',       () => assert.ok(!shouldIgnore('README.md')));
});

// ── File ingestion ────────────────────────────────────────────────────────────

describe('ingestFiles', () => {
  test('filters node_modules', async () => {
    const raw = [
      { path: 'src/app.js', content: 'const x = 1;' },
      { path: 'node_modules/express/index.js', content: '// express' },
    ];
    const result = await ingestFiles(raw);
    assert.equal(result.length, 1);
    assert.equal(result[0].path, 'src/app.js');
  });

  test('attaches language', async () => {
    const raw = [{ path: 'server.ts', content: 'export {}' }];
    const result = await ingestFiles(raw);
    assert.equal(result[0].lang, 'typescript');
  });

  test('truncates huge files', async () => {
    const big = 'x'.repeat(200_000);
    const result = await ingestFiles([{ path: 'big.js', content: big }]);
    assert.ok(result[0].truncated);
    assert.ok(result[0].content.length < big.length);
  });

  test('skips empty content', async () => {
    const raw = [
      { path: 'a.js', content: '' },
      { path: 'b.js', content: 'const x = 1;' },
    ];
    const result = await ingestFiles(raw);
    assert.equal(result.length, 1);
  });

  test('extracts a base64-tagged PDF into real text with lang=pdf', async () => {
    const raw = [{ path: 'report.pdf', content: tinyPdfBase64('Ingested PDF Content'), encoding: 'base64' }];
    const result = await ingestFiles(raw);
    assert.equal(result.length, 1);
    assert.equal(result[0].lang, 'pdf');
    assert.ok(result[0].content.includes('Ingested PDF Content'), result[0].content);
  });

  test('a PDF sent without encoding:"base64" is skipped, not mangled (unchanged behavior for non-conforming callers)', async () => {
    const raw = [{ path: 'old-style.pdf', content: '%PDF-1.4 raw text, no encoding flag' }];
    const result = await ingestFiles(raw);
    assert.equal(result.length, 0);
  });

  test('a corrupt base64-tagged document is skipped, not thrown (fails open per-file)', async () => {
    const raw = [
      { path: 'good.js',    content: 'const x = 1;' },
      { path: 'corrupt.pdf', content: Buffer.from('not a real pdf').toString('base64'), encoding: 'base64' },
    ];
    const result = await ingestFiles(raw);
    assert.equal(result.length, 1, 'corrupt document skipped, good file still ingested');
    assert.equal(result[0].path, 'good.js');
  });
});

// ── buildStructure ────────────────────────────────────────────────────────────

describe('buildStructure', () => {
  test('nests directories correctly', () => {
    const files = [
      { path: 'src/routes/chat.js', lang: 'javascript', size: 100 },
      { path: 'src/core/classifier.js', lang: 'javascript', size: 200 },
    ];
    const tree = buildStructure(files);
    assert.ok(tree.src);
    assert.ok(tree.src.routes);
    assert.ok(tree.src.core);
    assert.ok(tree.src.routes['chat.js']._file);
  });
});

// ── detectProjectType ─────────────────────────────────────────────────────────

describe('detectProjectType', () => {
  test('nodejs from package.json', async () => {
    const files = [{ path: 'package.json', content: '{"dependencies":{}}' }];
    assert.equal(detectProjectType(await ingestFiles(files)), 'nodejs');
  });

  test('python from requirements.txt', async () => {
    const files = [{ path: 'requirements.txt', content: 'flask==2.0' }];
    assert.equal(detectProjectType(await ingestFiles(files)), 'python');
  });

  test('go from go.mod', async () => {
    const files = [{ path: 'go.mod', content: 'module example.com/app\n\ngo 1.21' }];
    assert.equal(detectProjectType(await ingestFiles(files)), 'go');
  });
});

// ── JavaScript parser ─────────────────────────────────────────────────────────

describe('parseFile — JavaScript', () => {
  test('extracts functions', () => {
    const parsed = parseFile('app.js', SAMPLE_JS, 'javascript');
    assert.ok(parsed.functions.includes('createApp'), 'createApp function');
    assert.ok(parsed.functions.includes('handler'),   'handler arrow fn');
  });

  test('extracts classes', () => {
    const parsed = parseFile('app.js', SAMPLE_JS, 'javascript');
    const classNames = parsed.classes.map(c => typeof c === 'string' ? c : c.name);
    assert.ok(classNames.includes('App'), 'App class');
  });

  test('extracts exports', () => {
    const parsed = parseFile('app.js', SAMPLE_JS, 'javascript');
    assert.ok(parsed.exports.length > 0, 'should have exports');
  });

  test('extracts imports', () => {
    const parsed = parseFile('app.js', SAMPLE_JS, 'javascript');
    assert.ok(parsed.imports.includes('express'), 'express import');
    assert.ok(parsed.imports.includes('./utils/helper.js'), 'local import');
  });
});

// ── TypeScript parser ─────────────────────────────────────────────────────────

describe('parseFile — TypeScript', () => {
  test('extracts interfaces', () => {
    const parsed = parseFile('types.ts', SAMPLE_TS, 'typescript');
    assert.ok(parsed.interfaces.includes('UserPayload'), 'UserPayload interface');
  });

  test('extracts type aliases', () => {
    const parsed = parseFile('types.ts', SAMPLE_TS, 'typescript');
    assert.ok(parsed.interfaces.includes('JwtToken'), 'JwtToken type');
  });

  test('extracts functions', () => {
    const parsed = parseFile('types.ts', SAMPLE_TS, 'typescript');
    assert.ok(parsed.functions.includes('authenticate'), 'authenticate fn');
  });
});

// ── Python parser ─────────────────────────────────────────────────────────────

describe('parseFile — Python', () => {
  test('extracts classes', () => {
    const parsed = parseFile('app.py', SAMPLE_PY, 'python');
    const names  = parsed.classes.map(c => c.name);
    assert.ok(names.includes('UserService'), 'UserService class');
  });

  test('extracts functions', () => {
    const parsed = parseFile('app.py', SAMPLE_PY, 'python');
    assert.ok(parsed.functions.includes('create_app'), 'create_app fn');
  });

  test('extracts imports', () => {
    const parsed = parseFile('app.py', SAMPLE_PY, 'python');
    assert.ok(parsed.imports.includes('flask'), 'flask import');
  });
});

// ── Project Index ─────────────────────────────────────────────────────────────

describe('buildIndex + queryIndex', () => {
  test('indexes symbols correctly', () => {
    const wsId = freshWsId();
    const files = [
      { path: 'src/app.js',   content: SAMPLE_JS, lang: 'javascript', size: SAMPLE_JS.length },
      { path: 'src/types.ts', content: SAMPLE_TS, lang: 'typescript', size: SAMPLE_TS.length },
    ];
    buildIndex(wsId, files);
    const stats = getIndexStats(wsId);
    assert.ok(stats.files  >= 2, 'at least 2 files');
    assert.ok(stats.symbols >= 2, 'has symbols');
  });

  test('queryIndex by symbol', () => {
    const wsId = freshWsId();
    buildIndex(wsId, [{ path: 'app.js', content: SAMPLE_JS, lang: 'javascript', size: SAMPLE_JS.length }]);
    const result = queryIndex(wsId, { symbol: 'createApp' });
    assert.ok(result.files.length > 0, 'should find file with createApp');
    assert.equal(result.files[0].path, 'app.js');
  });

  test('queryIndex by keyword', () => {
    const wsId = freshWsId();
    buildIndex(wsId, [{ path: 'src/auth/authService.js', content: '// auth', lang: 'javascript', size: 10 }]);
    const result = queryIndex(wsId, { keyword: 'auth' });
    assert.ok(result.files.length > 0, 'keyword auth should match path');
  });
});

// ── Dependency Graph ──────────────────────────────────────────────────────────

describe('buildDependencyGraph', () => {
  const FILES = [
    {
      path: 'src/app.js', lang: 'javascript', size: 100,
      imports: ['./routes/chat', './core/classifier'],
      functions: [], classes: [], exports: [],
    },
    {
      path: 'src/routes/chat.js', lang: 'javascript', size: 100,
      imports: ['../core/classifier'],
      functions: [], classes: [], exports: [],
    },
    {
      path: 'src/core/classifier.js', lang: 'javascript', size: 100,
      imports: [],
      functions: ['classifyTask'], classes: [], exports: ['classifyTask'],
    },
  ];

  test('whoImports finds reverse deps', () => {
    const wsId = freshWsId();
    buildDependencyGraph(wsId, FILES);
    const importers = whoImports(wsId, 'src/core/classifier.js');
    // app.js and routes/chat.js both import classifier
    assert.ok(importers.length >= 1, 'classifier should be imported by at least one file');
  });

  test('whatImports finds forward deps', () => {
    const wsId = freshWsId();
    buildDependencyGraph(wsId, FILES);
    const deps = whatImports(wsId, 'src/routes/chat.js');
    assert.ok(deps.includes('src/core/classifier.js'), 'chat imports classifier');
  });

  test('serializeGraph produces adjacency list', () => {
    const wsId = freshWsId();
    buildDependencyGraph(wsId, FILES);
    const graph = serializeGraph(wsId);
    assert.ok(typeof graph === 'object', 'should be object');
    // app.js should have entries
    assert.ok(Object.keys(graph).length >= 1, 'should have at least one entry');
  });

  test('detectCycles — no cycle in acyclic graph', () => {
    const wsId = freshWsId();
    buildDependencyGraph(wsId, FILES);
    const cycles = detectCycles(wsId);
    assert.equal(cycles.length, 0, 'no cycles in acyclic graph');
  });

  test('detectCycles — finds cycle', () => {
    const wsId = freshWsId();
    const cyclic = [
      { path: 'a.js', imports: ['./b'], functions: [], classes: [], exports: [] },
      { path: 'b.js', imports: ['./a'], functions: [], classes: [], exports: [] },
    ];
    buildDependencyGraph(wsId, cyclic);
    const cycles = detectCycles(wsId);
    assert.ok(cycles.length >= 1, 'should detect cycle between a and b');
  });
});

// ── Summarizer ────────────────────────────────────────────────────────────────

describe('summarizeFile', () => {
  test('includes filename', () => {
    const parsed = parseFile('src/app.js', SAMPLE_JS, 'javascript');
    const summary = summarizeFile(parsed);
    assert.ok(summary.includes('app.js'), 'should include filename');
  });

  test('includes language', () => {
    const parsed = parseFile('server.ts', SAMPLE_TS, 'typescript');
    const summary = summarizeFile(parsed);
    assert.ok(summary.toLowerCase().includes('typescript'), 'should include lang');
  });

  test('includes class names', () => {
    const parsed = parseFile('app.js', SAMPLE_JS, 'javascript');
    const summary = summarizeFile(parsed);
    assert.ok(summary.includes('App'), 'should include App class');
  });
});

describe('summarizeProject', () => {
  test('includes project type', async () => {
    const files = enrichWithSummaries(
      await ingestFiles([{ path: 'package.json', content: '{"dependencies":{}}' }])
    );
    const summary = summarizeProject({ projectType: 'nodejs' }, files);
    assert.ok(summary.includes('nodejs'), 'should include project type');
  });
});

// ── Project Retriever ─────────────────────────────────────────────────────────

describe('retrieveProjectContext', () => {
  test('returns null for unknown workspace', () => {
    const ctx = retrieveProjectContext('nonexistent-ws', 'how does auth work');
    assert.equal(ctx, null, 'should return null for unknown ws');
  });

  test('scores auth-related files higher for auth query', () => {
    const wsId = freshWsId();
    const ws = createWorkspace({ name: 'test' });
    const wsDynId = ws.id;

    const files = [
      { path: 'src/auth/authService.js',    content: 'export function login() {}', lang: 'javascript', size: 30, summary: 'auth service' },
      { path: 'src/utils/stringHelper.js',  content: 'export function trim() {}',   lang: 'javascript', size: 20, summary: 'string utilities' },
    ];
    buildIndex(wsDynId, files);
    updateWorkspace(wsDynId, { projectType: 'nodejs', summary: 'test project' });

    const ctx = retrieveProjectContext(wsDynId, 'how does authentication work?');
    assert.ok(ctx !== null, 'should return context');
    assert.ok(ctx.files.length > 0, 'should return files');
    // auth file should rank first
    assert.ok(ctx.files[0].path.includes('auth'), 'auth file should rank higher');
  });
});

describe('formatProjectContext', () => {
  test('returns empty string for null', () => {
    assert.equal(formatProjectContext(null), '');
  });

  test('returns empty string for empty files', () => {
    assert.equal(formatProjectContext({ files: [], projectSummary: '', projectType: 'nodejs', totalFiles: 0 }), '');
  });

  test('formats context block correctly', () => {
    const ctx = {
      files: [{ path: 'src/app.js', lang: 'javascript', summary: 'main app', functions: ['start'], classes: [], exports: [], localImports: [], contentSnippet: '' }],
      projectSummary: 'test project',
      projectType: 'nodejs',
      relevantSymbols: [],
      totalFiles: 5,
    };
    const formatted = formatProjectContext(ctx);
    assert.ok(formatted.includes('PROJECT CONTEXT'), 'should have header');
    assert.ok(formatted.includes('src/app.js'), 'should include file path');
    assert.ok(formatted.includes('nodejs'), 'should include project type');
  });
});

// ── Patch Generator ───────────────────────────────────────────────────────────

describe('formatPatch', () => {
  test('includes all required fields', () => {
    const result = formatPatch({
      description: 'Add null check',
      reasoning:   'Prevent crash on undefined user',
      changes: [{
        file:        'src/auth.js',
        original:    'function login(user) {\n  return user.id;\n}',
        modified:    'function login(user) {\n  if (!user) return null;\n  return user.id;\n}',
        explanation: 'Add guard clause before accessing user.id',
      }],
    });

    assert.equal(result.description, 'Add null check');
    assert.ok(result.filesAffected.includes('src/auth.js'), 'should list affected file');
    assert.ok(result.patches.length === 1, 'should have one patch');
    assert.ok(result.patches[0].diff.includes('---'), 'diff should have --- header');
    assert.ok(result.patches[0].diff.includes('+++'), 'diff should have +++ header');
  });

  test('handles new file (no original)', () => {
    const result = formatPatch({
      description: 'Create new utility',
      reasoning:   'Needed for shared logic',
      changes: [{
        file:     'src/utils/new.js',
        original: '',
        modified: 'export function helper() {}',
      }],
    });
    assert.ok(result.patches[0].diff.includes('/dev/null'), 'new file diff uses /dev/null');
  });

  test('note field present', () => {
    const result = formatPatch({ description: 'x', reasoning: 'y', changes: [] });
    assert.ok(result.note, 'should include review note');
  });
});

// ── Workspace Manager ─────────────────────────────────────────────────────────

describe('workspaceManager', () => {
  test('create + get workspace', () => {
    const ws = createWorkspace({ name: 'my-project' });
    assert.ok(ws.id, 'should have id');
    assert.equal(ws.indexStatus, 'pending');

    const fetched = getWorkspace(ws.id);
    assert.ok(fetched, 'should be retrievable');
    assert.equal(fetched.id, ws.id);
  });

  test('updateWorkspace persists changes', () => {
    const ws = createWorkspace({});
    updateWorkspace(ws.id, { indexStatus: 'indexed', projectType: 'python' });
    const updated = getWorkspace(ws.id);
    assert.equal(updated.indexStatus, 'indexed');
    assert.equal(updated.projectType, 'python');
  });

  test('deleteWorkspace removes it', () => {
    const ws = createWorkspace({});
    const id = ws.id;
    deleteWorkspace(id);
    assert.equal(getWorkspace(id), null);
  });
});

// ── Incremental: re-index does not bleed old data ─────────────────────────────

describe('incremental reindex', () => {
  test('re-indexing workspace replaces old index', () => {
    const wsId = freshWsId();

    // First ingest: one file
    buildIndex(wsId, [{
      path: 'src/old.js', content: 'export function oldFn() {}', lang: 'javascript', size: 40,
    }]);

    let result = queryIndex(wsId, { symbol: 'oldFn' });
    assert.ok(result.files.length > 0, 'oldFn should be found');

    // Second ingest: different file
    buildIndex(wsId, [{
      path: 'src/new.js', content: 'export function newFn() {}', lang: 'javascript', size: 40,
    }]);

    result = queryIndex(wsId, { symbol: 'oldFn' });
    assert.equal(result.files.length, 0, 'oldFn should be gone after reindex');

    result = queryIndex(wsId, { symbol: 'newFn' });
    assert.ok(result.files.length > 0, 'newFn should be present');
  });
});
