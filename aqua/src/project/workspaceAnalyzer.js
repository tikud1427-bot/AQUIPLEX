/**
 * AQUA Workspace Analyzer
 *
 * Runs ONCE, immediately after indexing, on the same in-memory `enriched`
 * file array the upload route already produced — zero duplicate scans, no
 * LLM calls, fully synchronous. Output is cached on the workspace record
 * (workspace.overview) so it is generated exactly once per upload.
 *
 * Every section is isolated in try/catch: a failing detector degrades to
 * a partial overview + a warning entry — analysis NEVER throws upward and
 * NEVER fails an upload.
 *
 * Consumers:
 *   routes/project.js  → POST /workspace/:id/files (generate + cache)
 *                        GET  /workspace/:id/overview (serve cache)
 *   projectRetriever   → condensed block injected into repository chat
 */
import path from 'path';

// ── Detection tables (dependency name → human label) ─────────────────────────

const FRAMEWORK_DEPS = {
  next: 'Next.js', react: 'React', 'react-dom': 'React', vue: 'Vue', nuxt: 'Nuxt',
  svelte: 'Svelte', '@sveltejs/kit': 'SvelteKit', angular: 'Angular', '@angular/core': 'Angular',
  express: 'Express', fastify: 'Fastify', koa: 'Koa', '@nestjs/core': 'NestJS', hono: 'Hono',
  django: 'Django', flask: 'Flask', fastapi: 'FastAPI',
  'solid-js': 'SolidJS', astro: 'Astro', remix: 'Remix', '@remix-run/react': 'Remix',
};

const FRONTEND_DEPS = {
  react: 'React', 'react-dom': 'React DOM', 'react-router-dom': 'React Router',
  vue: 'Vue', svelte: 'Svelte', next: 'Next.js', tailwindcss: 'Tailwind CSS',
  '@mui/material': 'Material UI', antd: 'Ant Design', bootstrap: 'Bootstrap',
  zustand: 'Zustand', redux: 'Redux', '@reduxjs/toolkit': 'Redux Toolkit',
  'framer-motion': 'Framer Motion', 'lucide-react': 'Lucide icons',
  '@tanstack/react-query': 'React Query', axios: 'Axios', ejs: 'EJS templates',
};

const BACKEND_DEPS = {
  express: 'Express', fastify: 'Fastify', koa: 'Koa', '@nestjs/core': 'NestJS',
  'socket.io': 'Socket.IO', ws: 'WebSockets (ws)', graphql: 'GraphQL',
  'apollo-server': 'Apollo Server', cors: 'CORS middleware', helmet: 'Helmet security',
  multer: 'Multer uploads', 'body-parser': 'body-parser', nodemailer: 'Nodemailer',
  bullmq: 'BullMQ job queue', bull: 'Bull job queue', agenda: 'Agenda jobs',
  'node-cron': 'node-cron scheduler',
};

const DB_DEPS = {
  mongoose: 'MongoDB (Mongoose)', mongodb: 'MongoDB (native driver)',
  pg: 'PostgreSQL', mysql: 'MySQL', mysql2: 'MySQL', sqlite3: 'SQLite',
  'better-sqlite3': 'SQLite', prisma: 'Prisma ORM', '@prisma/client': 'Prisma ORM',
  sequelize: 'Sequelize ORM', typeorm: 'TypeORM', knex: 'Knex query builder',
  redis: 'Redis', ioredis: 'Redis (ioredis)', '@supabase/supabase-js': 'Supabase',
  firebase: 'Firebase', 'firebase-admin': 'Firebase Admin',
};

const AUTH_DEPS = {
  jsonwebtoken: 'JWT (jsonwebtoken)', passport: 'Passport.js', bcrypt: 'bcrypt password hashing',
  bcryptjs: 'bcrypt password hashing', 'express-session': 'Session-based auth',
  'next-auth': 'NextAuth.js', '@auth0/auth0-react': 'Auth0', jose: 'JWT (jose)',
  'cookie-parser': 'Cookie handling', oauth: 'OAuth', 'passport-google-oauth20': 'Google OAuth',
};

const INTEGRATION_DEPS = {
  stripe: 'Stripe payments', razorpay: 'Razorpay payments', cashfree: 'Cashfree payments',
  openai: 'OpenAI API', '@anthropic-ai/sdk': 'Anthropic API', '@google/generative-ai': 'Google Gemini',
  'groq-sdk': 'Groq API', twilio: 'Twilio', '@sendgrid/mail': 'SendGrid', 'aws-sdk': 'AWS SDK',
  '@aws-sdk/client-s3': 'AWS S3', cloudinary: 'Cloudinary', 'firebase-admin': 'Firebase',
  '@octokit/rest': 'GitHub API', nodemailer: 'SMTP email',
};

const BUILD_TOOL_FILES = {
  'vite.config.js': 'Vite', 'vite.config.ts': 'Vite',
  'webpack.config.js': 'Webpack', 'rollup.config.js': 'Rollup',
  'next.config.js': 'Next.js build', 'next.config.mjs': 'Next.js build',
  'tsconfig.json': 'TypeScript compiler', 'babel.config.js': 'Babel', '.babelrc': 'Babel',
  makefile: 'Make', dockerfile: 'Docker', 'docker-compose.yml': 'Docker Compose',
  'esbuild.config.js': 'esbuild', 'tailwind.config.js': 'Tailwind CLI',
  'tailwind.config.ts': 'Tailwind CLI', 'gulpfile.js': 'Gulp',
};

const CONFIG_BASENAMES = /^(\.env|\.eslintrc|eslint\.config|\.prettierrc|prettier\.config|tsconfig|jsconfig|vite\.config|webpack\.config|next\.config|nuxt\.config|babel\.config|jest\.config|vitest\.config|tailwind\.config|postcss\.config|rollup\.config|docker-compose|dockerfile|makefile|procfile|nodemon\.json|\.nvmrc|\.editorconfig|renovate\.json|netlify\.toml|vercel\.json|fly\.toml|pyproject\.toml|setup\.py|setup\.cfg|requirements.*\.txt|go\.mod|cargo\.toml|pom\.xml|build\.gradle|composer\.json|gemfile)/i;

// Route extraction: Express/Koa/Fastify + Python decorators + Next.js API dirs
const JS_ROUTE_RE = /(?:router|app|api|server|fastify)\s*\.\s*(get|post|put|patch|delete|all|use)\s*\(\s*['"`]([^'"`]+)['"`]/g;
const PY_ROUTE_RE = /@(?:app|router|api|bp|blueprint)\.\s*(?:route\s*\(\s*['"]([^'"]+)['"](?:.*methods\s*=\s*\[([^\]]+)\])?|(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"])/g;
const ENV_JS_RE   = /process\.env\.([A-Z][A-Z0-9_]{1,60})|import\.meta\.env\.([A-Z][A-Z0-9_]{1,60})/g;
const ENV_PY_RE   = /os\.(?:environ(?:\.get)?|getenv)\s*[[(]\s*['"]([A-Z][A-Z0-9_]{1,60})['"]/g;
const TODO_RE     = /(?:\/\/|#|\/\*|\*|<!--)\s*(TODO|FIXME|HACK|XXX)\b[:\s]?(.{0,100})/g;

// ── Main entry ────────────────────────────────────────────────────────────────

/**
 * Analyze a workspace from already-ingested + enriched files.
 * Pure function of its inputs — no index re-reads, no filesystem access.
 *
 * @param {object} args
 * @param {string} args.workspaceName    from workspace.meta.name (may be empty)
 * @param {string} args.projectType     from detectProjectType()
 * @param {Array}  args.files           enriched ingested files [{path, content, lang, size, functions, classes, exports, imports, comments, dependencies, summary}]
 * @param {object} [args.graph]         serialized dependency graph { nodes, edges } (optional)
 * @param {Array}  [args.cycles]        dependency cycles (optional)
 * @returns {{ overview: object, warnings: string[] }}
 */
export function analyzeWorkspace({ workspaceName, projectType, files, graph, cycles }) {
  const warnings = [];
  const overview = {
    generatedAt: Date.now(),
    partial:     false,
  };

  const run = (section, fn) => {
    try {
      Object.assign(overview, fn());
    } catch (err) {
      overview.partial = true;
      warnings.push(`${section}: ${err.message}`);
      console.warn(`[ANALYZER] Section '${section}' failed:`, err.message);
    }
  };

  const manifests = _readManifests(files);

  run('identity',     () => _identity(workspaceName, projectType, files, manifests));
  run('stack',        () => _stack(files, manifests, projectType));
  run('structure',    () => _structure(files));
  run('envConfig',    () => _envAndConfig(files));
  run('entryPoints',  () => _entryAndCore(files, graph));
  run('apiRoutes',    () => ({ apiRoutes: _extractRoutes(files) }));
  run('integrations', () => _integrations(manifests));
  run('statistics',   () => _statistics(files, graph));
  run('todos',        () => _todos(files));
  run('techDebt',     () => _techDebt(files, cycles, overview));
  run('architecture', () => ({ architecture: _architecture(files, manifests, overview) }));
  run('improvements', () => ({ suggestedImprovements: _improvements(files, overview) }));
  run('questions',    () => ({ suggestedQuestions: _questions(overview) }));

  overview.warnings = warnings;
  return { overview, warnings };
}

// ── Manifest reading (package.json / requirements / etc.) ─────────────────────

function _readManifests(files) {
  const out = { pkg: null, pkgAll: [], pyDeps: [], goMod: false, cargo: false };
  for (const f of files) {
    const base = path.basename(f.path).toLowerCase();
    if (base === 'package.json') {
      try {
        const pkg = JSON.parse(f.content);
        out.pkgAll.push({ path: f.path, pkg });
        // Root package.json wins (shortest path depth)
        if (!out.pkg || f.path.split('/').length < out.pkg.depth) {
          out.pkg = { ...pkg, depth: f.path.split('/').length };
        }
      } catch { /* malformed */ }
    }
    if (base === 'requirements.txt') {
      out.pyDeps.push(...f.content.split('\n')
        .map(l => l.trim().split(/[=<>!~;\[]/)[0])
        .filter(l => l && !l.startsWith('#')));
    }
    if (base === 'pyproject.toml') out.pyProject = true;
    if (base === 'go.mod')         out.goMod = true;
    if (base === 'cargo.toml')     out.cargo = true;
  }
  // Merge dependencies from ALL package.json files (monorepos)
  out.allDeps = {};
  for (const { pkg } of out.pkgAll) {
    Object.assign(out.allDeps, pkg.dependencies ?? {}, pkg.devDependencies ?? {});
  }
  return out;
}

// ── Identity ──────────────────────────────────────────────────────────────────

function _identity(workspaceName, projectType, files, manifests) {
  const pkg = manifests.pkg;
  const name = workspaceName || pkg?.name || 'Untitled project';

  // Purpose: package.json description > README first meaningful paragraph
  let purpose = pkg?.description ?? null;
  if (!purpose) {
    const readme = files.find(f => /^readme\.mdx?$/i.test(path.basename(f.path)));
    if (readme) {
      const para = readme.content
        .split('\n')
        .map(l => l.trim())
        .find(l => l.length > 30 && !l.startsWith('#') && !l.startsWith('!') && !l.startsWith('['));
      if (para) purpose = para.slice(0, 240);
    }
  }

  const langs = _langCounts(files);
  const topLangs = Object.keys(langs).slice(0, 3).join(', ');
  const summary = `${name} is a ${_typeLabel(projectType)} project with ${files.length} source files, primarily ${topLangs || 'mixed languages'}.`;

  return { name, purpose: purpose ?? 'No description found in package.json or README.', summary, projectType };
}

function _typeLabel(t) {
  return ({
    'nodejs-next': 'Next.js', 'nodejs-react': 'React', 'nodejs-express': 'Node.js/Express',
    'nodejs-vue': 'Vue', nodejs: 'Node.js', python: 'Python', go: 'Go', rust: 'Rust',
    java: 'Java', php: 'PHP', ruby: 'Ruby', csharp: 'C#', cpp: 'C++',
  })[t] ?? (t || 'software');
}

function _langCounts(files) {
  const counts = {};
  for (const f of files) if (f.lang && f.lang !== 'unknown') counts[f.lang] = (counts[f.lang] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

// ── Tech stack ────────────────────────────────────────────────────────────────

function _stack(files, manifests, projectType) {
  const deps = { ...manifests.allDeps };
  for (const d of manifests.pyDeps) deps[d.toLowerCase()] = '*';

  const pick = (table) => {
    const hits = new Set();
    for (const [dep, label] of Object.entries(table)) if (deps[dep]) hits.add(label);
    return [...hits];
  };

  const frameworks = pick(FRAMEWORK_DEPS);
  if (deps.django) frameworks.push('Django');
  if (deps.flask) frameworks.push('Flask');
  if (deps.fastapi) frameworks.push('FastAPI');

  // Runtime
  const runtimes = [];
  if (manifests.pkg || projectType?.startsWith('nodejs')) {
    const engine = manifests.pkg?.engines?.node;
    runtimes.push(engine ? `Node.js ${engine}` : 'Node.js');
    if (manifests.pkg?.type === 'module') runtimes.push('ESM modules');
  }
  if (manifests.pyDeps.length || manifests.pyProject || projectType === 'python') runtimes.push('Python');
  if (manifests.goMod)  runtimes.push('Go');
  if (manifests.cargo)  runtimes.push('Rust');
  if (files.some(f => f.lang === 'typescript')) runtimes.push('TypeScript');

  // Package managers — lockfiles are filtered at ingest, so infer from manifests
  const packageManagers = [];
  if (manifests.pkg)             packageManagers.push('npm / yarn / pnpm');
  if (manifests.pyDeps.length)   packageManagers.push('pip');
  if (manifests.pyProject)       packageManagers.push('poetry / pip');
  if (manifests.goMod)           packageManagers.push('go modules');
  if (manifests.cargo)           packageManagers.push('cargo');

  // Build tools from config file presence
  const buildTools = new Set();
  for (const f of files) {
    const base = path.basename(f.path).toLowerCase();
    if (BUILD_TOOL_FILES[base]) buildTools.add(BUILD_TOOL_FILES[base]);
  }

  // Major dependencies — top runtime deps by name from root pkg
  const majorDependencies = Object.keys(manifests.pkg?.dependencies ?? {}).slice(0, 15);
  if (!majorDependencies.length && manifests.pyDeps.length) majorDependencies.push(...manifests.pyDeps.slice(0, 15));

  return {
    languages:       _langCounts(files),
    frameworks:      [...new Set(frameworks)],
    runtime:         runtimes,
    packageManagers,
    buildTools:      [...buildTools],
    frontendTech:    pick(FRONTEND_DEPS),
    backendTech:     pick(BACKEND_DEPS),
    databaseTech:    pick(DB_DEPS),
    authMethods:     _authMethods(files, deps),
    majorDependencies,
    dependencyCount: Object.keys(manifests.allDeps).length + manifests.pyDeps.length,
  };
}

function _authMethods(files, deps) {
  const methods = new Set();
  for (const [dep, label] of Object.entries(AUTH_DEPS)) if (deps[dep]) methods.add(label);
  // Path-based signals for hand-rolled auth
  const authFiles = files.filter(f => /auth|login|session|jwt/i.test(f.path));
  if (authFiles.length && !methods.size) methods.add(`Custom auth (${authFiles.length} auth-related files)`);
  return [...methods];
}

// ── Structure ─────────────────────────────────────────────────────────────────

function _structure(files) {
  const dirCounts = {};
  const dirSizes  = {};
  for (const f of files) {
    const parts = f.path.replace(/\\/g, '/').split('/');
    // Count at up to 2 levels deep
    for (const depth of [1, 2]) {
      if (parts.length > depth) {
        const dir = parts.slice(0, depth).join('/');
        dirCounts[dir] = (dirCounts[dir] ?? 0) + 1;
        dirSizes[dir]  = (dirSizes[dir] ?? 0) + (f.size ?? 0);
      }
    }
  }
  const folderStructure = Object.entries(dirCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 14)
    .map(([dir, count]) => ({ dir, files: count, bytes: dirSizes[dir] ?? 0 }));

  const largestFolders = Object.entries(dirSizes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([dir, bytes]) => ({ dir, bytes }));

  return { folderStructure, largestFolders };
}

// ── Env vars + config files ───────────────────────────────────────────────────

function _envAndConfig(files) {
  const envVars = new Set();
  const configFiles = [];

  for (const f of files) {
    const base = path.basename(f.path);
    if (CONFIG_BASENAMES.test(base)) configFiles.push(f.path);

    if (f.lang === 'env') {
      for (const line of f.content.split('\n')) {
        const m = line.match(/^([A-Z][A-Z0-9_]+)\s*=/);
        if (m) envVars.add(m[1]);
      }
      continue;
    }
    if (['javascript', 'typescript'].includes(f.lang)) {
      for (const m of f.content.matchAll(ENV_JS_RE)) envVars.add(m[1] ?? m[2]);
    } else if (f.lang === 'python') {
      for (const m of f.content.matchAll(ENV_PY_RE)) envVars.add(m[1]);
    }
  }
  return {
    envVars: [...envVars].sort().slice(0, 40),
    configFiles: configFiles.sort().slice(0, 25),
  };
}

// ── Entry points + core modules + services ────────────────────────────────────

const ENTRY_BASENAMES = new Set([
  'index.js', 'index.ts', 'index.jsx', 'index.tsx', 'main.js', 'main.ts', 'main.jsx',
  'main.tsx', 'app.js', 'app.ts', 'app.jsx', 'app.tsx', 'server.js', 'server.ts',
  'main.py', 'app.py', '__main__.py', 'main.go', 'main.rs', 'index.html',
]);

function _entryAndCore(files, graph) {
  const entryPoints = files
    .filter(f => ENTRY_BASENAMES.has(path.basename(f.path).toLowerCase()))
    .map(f => f.path)
    .sort((a, b) => a.split('/').length - b.split('/').length)
    .slice(0, 6);

  // Core modules = most-imported files (in-degree in dependency graph).
  // serializeGraph() returns an adjacency map { file: [localDeps] } —
  // in-degree = how many files list a given file as a dependency.
  // Fallback when the graph is empty: files exporting the most symbols.
  let coreModules = [];
  if (graph && typeof graph === 'object') {
    const inDegree = {};
    for (const deps of Object.values(graph)) {
      for (const dep of deps ?? []) inDegree[dep] = (inDegree[dep] ?? 0) + 1;
    }
    coreModules = Object.entries(inDegree)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([file, importedBy]) => ({ file, importedBy }));
  }
  if (!coreModules.length) {
    coreModules = files
      .map(f => ({ file: f.path, exports: (f.exports ?? []).length }))
      .filter(x => x.exports > 0)
      .sort((a, b) => b.exports - a.exports)
      .slice(0, 8)
      .map(({ file, exports: n }) => ({ file, importedBy: 0, exports: n }));
  }

  const services = files
    .filter(f => /service|provider|client|engine|manager|store|repository/i.test(path.basename(f.path)) && !/test|spec/i.test(f.path))
    .map(f => ({ file: f.path, summary: (f.summary ?? '').split('|')[0]?.trim().slice(0, 100) }))
    .slice(0, 10);

  return { entryPoints, coreModules, importantServices: services };
}

// ── API route extraction ──────────────────────────────────────────────────────

function _extractRoutes(files) {
  const routes = [];
  for (const f of files) {
    if (['javascript', 'typescript'].includes(f.lang)) {
      for (const m of f.content.matchAll(JS_ROUTE_RE)) {
        const method = m[1].toUpperCase();
        if (method === 'USE' && !m[2].startsWith('/')) continue;
        routes.push({ method: method === 'USE' ? 'MOUNT' : method, path: m[2], file: f.path });
      }
      // Next.js file-system API routes
      if (/(?:^|\/)(?:pages|app)\/api\//.test(f.path)) {
        routes.push({ method: 'FS', path: '/' + f.path.replace(/^.*?(?:pages|app)\//, '').replace(/\.(js|ts)x?$/, '').replace(/\/route$/, ''), file: f.path });
      }
    } else if (f.lang === 'python') {
      for (const m of f.content.matchAll(PY_ROUTE_RE)) {
        const p = m[1] ?? m[4];
        const method = m[3] ? m[3].toUpperCase() : (m[2] ? m[2].replace(/['"\s]/g, '').toUpperCase() : 'GET');
        if (p) routes.push({ method, path: p, file: f.path });
      }
    }
  }
  // Dedupe, cap
  const seen = new Set();
  return routes.filter(r => {
    const k = `${r.method} ${r.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 60);
}

// ── Integrations ──────────────────────────────────────────────────────────────

function _integrations(manifests) {
  const deps = manifests.allDeps;
  const hits = new Set();
  for (const [dep, label] of Object.entries(INTEGRATION_DEPS)) if (deps[dep]) hits.add(label);
  for (const d of manifests.pyDeps) {
    const l = d.toLowerCase();
    if (l === 'openai') hits.add('OpenAI API');
    if (l === 'anthropic') hits.add('Anthropic API');
    if (l === 'stripe') hits.add('Stripe payments');
    if (l === 'boto3') hits.add('AWS SDK');
    if (l === 'groq') hits.add('Groq API');
  }
  return { externalIntegrations: [...hits] };
}

// ── Statistics ────────────────────────────────────────────────────────────────

function _statistics(files, graph) {
  let totalBytes = 0, functions = 0, classes = 0, components = 0, interfaces = 0;
  for (const f of files) {
    totalBytes += f.size ?? 0;
    functions  += (f.functions ?? []).length;
    classes    += (f.classes ?? []).length;
    interfaces += (f.interfaces ?? []).length;
    if (/\.(jsx|tsx)$/.test(f.path) || /component/i.test(f.path)) components++;
  }
  return {
    stats: {
      fileCount:      files.length,
      totalBytes,
      totalKB:        Math.round(totalBytes / 1024),
      functions,
      classes,
      interfaces,
      components,
      dependencyEdges: graph && typeof graph === 'object'
        ? Object.values(graph).reduce((n, deps) => n + (deps?.length ?? 0), 0)
        : 0,
      configFileCount: files.filter(f => CONFIG_BASENAMES.test(path.basename(f.path))).length,
    },
  };
}

// ── TODO / FIXME ──────────────────────────────────────────────────────────────

function _todos(files) {
  const items = [];
  let count = 0;
  for (const f of files) {
    if (['json', 'markdown', 'env'].includes(f.lang)) continue;
    for (const m of f.content.matchAll(TODO_RE)) {
      count++;
      if (items.length < 20) {
        items.push({ tag: m[1].toUpperCase(), text: m[2].trim().slice(0, 90), file: f.path });
      }
    }
  }
  return { todoCount: count, todos: items };
}

// ── Technical debt heuristics ─────────────────────────────────────────────────

function _techDebt(files, cycles, overview) {
  const debt = [];
  const large = files.filter(f => (f.size ?? 0) > 40_000);
  if (large.length) debt.push(`${large.length} very large files (>40KB) — candidates for splitting: ${large.slice(0, 3).map(f => f.path).join(', ')}`);

  const truncated = files.filter(f => f.truncated);
  if (truncated.length) debt.push(`${truncated.length} files exceeded the 100KB ingest cap and were truncated during indexing.`);

  if (cycles?.length) debt.push(`${cycles.length} circular dependency chain${cycles.length > 1 ? 's' : ''} detected — e.g. ${cycles[0].slice(0, 3).join(' → ')}.`);

  if ((overview.todoCount ?? 0) > 15) debt.push(`High TODO/FIXME density (${overview.todoCount} markers) suggests deferred work accumulating.`);

  const hasTests = files.some(f => /\.(test|spec)\.[jt]sx?$|test_.*\.py|_test\.go/i.test(f.path));
  if (!hasTests) debt.push('No test files detected — the project has no automated test coverage.');

  const dupNames = _duplicateBasenames(files);
  if (dupNames.length > 5) debt.push(`${dupNames.length} duplicated file basenames across folders (e.g. ${dupNames.slice(0, 3).join(', ')}) — possible copy-paste drift.`);

  return { potentialTechDebt: debt };
}

function _duplicateBasenames(files) {
  const seen = {};
  for (const f of files) {
    const b = path.basename(f.path);
    if (b === 'index.js' || b === 'index.ts' || b === '__init__.py') continue;
    seen[b] = (seen[b] ?? 0) + 1;
  }
  return Object.entries(seen).filter(([, n]) => n > 1).map(([b]) => b);
}

// ── Architecture summary ──────────────────────────────────────────────────────

function _architecture(files, manifests, overview) {
  const has = (re) => files.some(f => re.test(f.path));
  const s = {};

  s.frontend = overview.frontendTech?.length
    ? `Built with ${overview.frontendTech.slice(0, 4).join(', ')}${has(/components?\//i) ? '; UI lives in component directories' : ''}.`
    : (has(/\.(jsx|tsx|vue|svelte)$/) ? 'Component-based frontend detected from file types.' : 'No dedicated frontend layer detected.');

  s.backend = overview.backendTech?.length
    ? `${overview.backendTech.slice(0, 4).join(', ')} power the server side${has(/routes?\//i) ? ', organized around route modules' : ''}.`
    : (has(/server|api|backend/i) ? 'Server-side code present; framework not identified from dependencies.' : 'No dedicated backend layer detected.');

  const routeCount = overview.apiRoutes?.length ?? 0;
  s.apiLayer = routeCount
    ? `${routeCount} HTTP endpoints detected${overview.apiRoutes.some(r => r.method === 'MOUNT') ? ', composed via mounted routers' : ''}.`
    : 'No HTTP endpoints detected in source.';

  s.dataLayer = overview.databaseTech?.length
    ? `Persistence via ${overview.databaseTech.join(', ')}.`
    : (has(/model|schema|store|memory|db/i) ? 'Custom data/persistence modules present (file- or memory-backed); no database driver dependency found.' : 'No data layer detected.');

  s.authFlow = overview.authMethods?.length
    ? overview.authMethods.join(', ') + '.'
    : 'No authentication mechanism detected.';

  s.storage = has(/upload|storage|s3|bucket|file/i)
    ? 'File/storage handling modules present.'
    : 'No dedicated storage layer detected.';

  s.backgroundJobs = (manifests.allDeps.bullmq || manifests.allDeps.bull || manifests.allDeps['node-cron'] || manifests.allDeps.agenda || has(/worker|queue|cron|job/i))
    ? 'Background job / scheduler code detected.'
    : 'No background job system detected.';

  // Service relationships + dependency flow from graph-derived core modules
  const core = overview.coreModules ?? [];
  s.serviceRelationships = core.length
    ? `Most depended-upon modules: ${core.slice(0, 4).map(c => `${path.basename(c.file)} (${c.importedBy || c.exports || 0})`).join(', ')}.`
    : 'Module relationships could not be derived.';

  const entries = overview.entryPoints ?? [];
  s.dependencyFlow = entries.length
    ? `Execution starts at ${entries[0]}; dependencies flow toward core modules like ${core[0]?.file ?? 'shared utilities'}.`
    : 'Entry point not identified.';

  return s;
}

// ── Suggested improvements ────────────────────────────────────────────────────

function _improvements(files, overview) {
  const out = [];
  const debt = overview.potentialTechDebt ?? [];
  if (debt.some(d => d.includes('No test files'))) out.push('Add a test suite — start with the core modules and API routes identified above.');
  if (debt.some(d => d.includes('circular')))       out.push('Break circular dependencies by extracting shared logic into a leaf module.');
  if (debt.some(d => d.includes('very large')))     out.push('Split the largest files into focused modules to improve maintainability.');
  if ((overview.todoCount ?? 0) > 0)                out.push(`Triage the ${overview.todoCount} TODO/FIXME markers — convert stale ones into tracked issues.`);
  if (!(overview.configFiles ?? []).some(c => /docker/i.test(c))) out.push('Add a Dockerfile for reproducible builds and deployment.');
  if (!(overview.envVars ?? []).length && (overview.apiRoutes ?? []).length) out.push('Externalize configuration into environment variables instead of hardcoded values.');
  if (!files.some(f => /^readme/i.test(path.basename(f.path)))) out.push('Add a README documenting setup, architecture, and entry points.');
  if ((overview.authMethods ?? []).length === 0 && (overview.apiRoutes ?? []).length > 5) out.push('API endpoints appear unauthenticated — consider adding an auth layer.');
  return out.slice(0, 6);
}

// ── Suggested questions ───────────────────────────────────────────────────────

function _questions(overview) {
  const qs = ['Explain the architecture of this project.', 'Walk me through the folder structure and what each part does.'];
  if (overview.authMethods?.length)          qs.push('How does authentication work in this codebase?');
  if (overview.apiRoutes?.length)            qs.push('Show me every API endpoint and what it does.');
  if (overview.databaseTech?.length)         qs.push(`How is data stored and accessed via ${overview.databaseTech[0]}?`);
  if (overview.entryPoints?.length)          qs.push(`Trace what happens when ${overview.entryPoints[0]} starts up.`);
  if (overview.coreModules?.length)          qs.push(`Explain what ${overview.coreModules[0].file} does and what depends on it.`);
  if (overview.externalIntegrations?.length) qs.push(`How is the ${overview.externalIntegrations[0]} integration implemented?`);
  if (overview.todoCount > 0)                qs.push('Which TODO items should I prioritize first?');
  qs.push('Where should I start if I want to add a new feature?');
  return qs.slice(0, 8);
}

// ── Condensed prompt block (for repository chat) ──────────────────────────────

/**
 * Format the cached overview into a compact block for system-prompt injection.
 * Kept small (~short paragraph scale) — detail comes from per-file retrieval.
 */
export function formatOverviewForPrompt(overview) {
  if (!overview) return '';
  const l = [];
  l.push(`Project: ${overview.name ?? 'unknown'} (${overview.projectType ?? 'unknown'})`);
  if (overview.purpose)                    l.push(`Purpose: ${overview.purpose}`);
  if (overview.frameworks?.length)         l.push(`Frameworks: ${overview.frameworks.join(', ')}`);
  if (overview.databaseTech?.length)       l.push(`Database: ${overview.databaseTech.join(', ')}`);
  if (overview.authMethods?.length)        l.push(`Auth: ${overview.authMethods.join(', ')}`);
  if (overview.entryPoints?.length)        l.push(`Entry points: ${overview.entryPoints.slice(0, 3).join(', ')}`);
  if (overview.coreModules?.length)        l.push(`Core modules: ${overview.coreModules.slice(0, 5).map(c => c.file).join(', ')}`);
  if (overview.apiRoutes?.length)          l.push(`API endpoints (${overview.apiRoutes.length}): ${overview.apiRoutes.slice(0, 12).map(r => `${r.method} ${r.path}`).join('; ')}`);
  if (overview.externalIntegrations?.length) l.push(`Integrations: ${overview.externalIntegrations.join(', ')}`);
  if (overview.stats)                      l.push(`Size: ${overview.stats.fileCount} files, ${overview.stats.totalKB}KB, ${overview.stats.functions} functions, ${overview.stats.classes} classes`);
  return l.join('\n');
}
