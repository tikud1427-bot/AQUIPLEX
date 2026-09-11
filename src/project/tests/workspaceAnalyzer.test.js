/**
 * Workspace Analyzer tests
 * Run: node --test src/project/tests/workspaceAnalyzer.test.js
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeWorkspace, formatOverviewForPrompt } from '../workspaceAnalyzer.js';

const F = (path, content, extra = {}) => ({
  path, content, lang: extra.lang ?? 'javascript', size: content.length,
  functions: extra.functions ?? [], classes: extra.classes ?? [],
  exports: extra.exports ?? [], imports: extra.imports ?? [],
  interfaces: [], comments: [], dependencies: [], keywords: [],
  summary: extra.summary ?? '', truncated: extra.truncated ?? false,
});

const NODE_PROJECT = [
  F('package.json', JSON.stringify({
    name: 'demo-app', description: 'A demo application', type: 'module',
    dependencies: { express: '^4', mongoose: '^8', jsonwebtoken: '^9', stripe: '^14', react: '^18' },
    devDependencies: { vite: '^5' },
  }), { lang: 'json' }),
  F('server.js', `import express from 'express';\nconst app = express();\napp.get('/health', h);\napp.post('/api/users', h);\nrouter.delete('/api/users/:id', h);\nconst key = process.env.STRIPE_KEY;\n// TODO: add rate limiting`, { functions: ['h'] }),
  F('src/auth/login.js', `export function login() {}\nconst secret = process.env.JWT_SECRET;`, { exports: ['login'], functions: ['login'] }),
  F('src/models/user.js', `export const User = {};`, { exports: ['User'] }),
  F('vite.config.ts', 'export default {}', { lang: 'typescript' }),
  F('README.md', '# Demo\n\nThis project demonstrates the analyzer with a realistic layout.', { lang: 'markdown' }),
];

describe('analyzeWorkspace', () => {
  test('detects identity from package.json', () => {
    const { overview } = analyzeWorkspace({ workspaceName: '', projectType: 'nodejs-express', files: NODE_PROJECT, graph: null, cycles: [] });
    assert.equal(overview.name, 'demo-app');
    assert.equal(overview.purpose, 'A demo application');
    assert.match(overview.summary, /demo-app/);
  });

  test('workspace name overrides package name', () => {
    const { overview } = analyzeWorkspace({ workspaceName: 'My Workspace', projectType: 'nodejs', files: NODE_PROJECT, graph: null, cycles: [] });
    assert.equal(overview.name, 'My Workspace');
  });

  test('detects stack from dependencies', () => {
    const { overview } = analyzeWorkspace({ workspaceName: 'x', projectType: 'nodejs-express', files: NODE_PROJECT, graph: null, cycles: [] });
    assert.ok(overview.frameworks.includes('Express'));
    assert.ok(overview.frameworks.includes('React'));
    assert.ok(overview.databaseTech.includes('MongoDB (Mongoose)'));
    assert.ok(overview.authMethods.some(m => m.includes('JWT')));
    assert.ok(overview.externalIntegrations.includes('Stripe payments'));
    assert.ok(overview.buildTools.includes('Vite'));
    assert.ok(overview.runtime.some(r => r.startsWith('Node.js')));
    assert.ok(overview.runtime.includes('ESM modules'));
  });

  test('extracts API routes and env vars', () => {
    const { overview } = analyzeWorkspace({ workspaceName: 'x', projectType: 'nodejs', files: NODE_PROJECT, graph: null, cycles: [] });
    const paths = overview.apiRoutes.map(r => `${r.method} ${r.path}`);
    assert.ok(paths.includes('GET /health'));
    assert.ok(paths.includes('POST /api/users'));
    assert.ok(paths.includes('DELETE /api/users/:id'));
    assert.ok(overview.envVars.includes('STRIPE_KEY'));
    assert.ok(overview.envVars.includes('JWT_SECRET'));
  });

  test('counts TODOs and derives improvements + questions', () => {
    const { overview } = analyzeWorkspace({ workspaceName: 'x', projectType: 'nodejs', files: NODE_PROJECT, graph: null, cycles: [] });
    assert.equal(overview.todoCount, 1);
    assert.equal(overview.todos[0].tag, 'TODO');
    assert.ok(overview.suggestedImprovements.length > 0);
    assert.ok(overview.suggestedQuestions.some(q => /authentication/i.test(q)));
    assert.ok(overview.suggestedQuestions.some(q => /endpoint/i.test(q)));
  });

  test('core modules from adjacency-map graph in-degree', () => {
    const graph = {
      'a.js': ['shared.js', 'util.js'],
      'b.js': ['shared.js'],
      'c.js': ['shared.js'],
    };
    const { overview } = analyzeWorkspace({ workspaceName: 'x', projectType: 'nodejs', files: NODE_PROJECT, graph, cycles: [] });
    assert.equal(overview.coreModules[0].file, 'shared.js');
    assert.equal(overview.coreModules[0].importedBy, 3);
    assert.equal(overview.stats.dependencyEdges, 4);
  });

  test('cycles surface as tech debt', () => {
    const { overview } = analyzeWorkspace({ workspaceName: 'x', projectType: 'nodejs', files: NODE_PROJECT, graph: null, cycles: [['a.js', 'b.js', 'a.js']] });
    assert.ok(overview.potentialTechDebt.some(d => /circular/i.test(d)));
  });

  test('python project: decorator routes + os.environ', () => {
    const py = [F('app.py', `@app.route('/items', methods=['GET'])\ndef items(): pass\nimport os\nk = os.environ.get('DB_URL')`, { lang: 'python', functions: ['items'] })];
    const { overview } = analyzeWorkspace({ workspaceName: 'py', projectType: 'python', files: py, graph: null, cycles: [] });
    assert.equal(overview.apiRoutes[0].path, '/items');
    assert.ok(overview.envVars.includes('DB_URL'));
  });

  test('empty file list never throws, still yields questions', () => {
    const { overview, warnings } = analyzeWorkspace({ workspaceName: null, projectType: null, files: [], graph: null, cycles: null });
    assert.equal(warnings.length, 0);
    assert.ok(overview.suggestedQuestions.length >= 2);
    assert.equal(overview.stats.fileCount, 0);
  });

  test('malformed package.json degrades gracefully', () => {
    const bad = [F('package.json', '{not json', { lang: 'json' }), ...NODE_PROJECT.slice(1)];
    const { overview } = analyzeWorkspace({ workspaceName: 'x', projectType: 'nodejs', files: bad, graph: null, cycles: [] });
    assert.ok(overview.name); // falls back, no throw
  });

  test('prompt block is compact and non-empty', () => {
    const { overview } = analyzeWorkspace({ workspaceName: 'x', projectType: 'nodejs-express', files: NODE_PROJECT, graph: null, cycles: [] });
    const block = formatOverviewForPrompt(overview);
    assert.ok(block.includes('Frameworks: '));
    assert.ok(block.length < 2500);
    assert.equal(formatOverviewForPrompt(null), '');
  });
});
