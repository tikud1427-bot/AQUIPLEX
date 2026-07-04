/**
 * AQUA File Parser
 *
 * Language-specific extraction using regex (no AST — zero extra dependencies).
 * Extracts: functions, classes, methods, imports, exports, interfaces, doc comments.
 * Config files produce: dependencies, scripts, keywords.
 *
 * Supported: JavaScript, TypeScript, Python, Java, Kotlin, Go, Rust, C#, PHP, JSON, Markdown.
 * Also PDF, DOCX, PPTX, XLSX — text already extracted by project/documentParser.js
 * by the time it reaches here; this just pulls a short preview into `comments`,
 * same role parseMarkdown() plays for # / ## headers.
 */
import path from 'path';

// ── Dispatcher ────────────────────────────────────────────────────────────────

/**
 * Parse a single file into structured metadata.
 *
 * @param {string} filePath
 * @param {string} content
 * @param {string} lang
 * @returns {ParsedFile}
 */
export function parseFile(filePath, content, lang) {
  const base = {
    path:         filePath,
    lang,
    size:         content.length,
    functions:    [],
    classes:      [],
    imports:      [],
    exports:      [],
    interfaces:   [],
    comments:     [],
    dependencies: [],
    keywords:     [],
  };

  try {
    switch (lang) {
      case 'javascript':
      case 'typescript':
        return { ...base, ...parseJS(content) };
      case 'python':
        return { ...base, ...parsePython(content) };
      case 'java':
      case 'kotlin':
        return { ...base, ...parseJava(content) };
      case 'go':
        return { ...base, ...parseGo(content) };
      case 'rust':
        return { ...base, ...parseRust(content) };
      case 'csharp':
        return { ...base, ...parseCSharp(content) };
      case 'php':
        return { ...base, ...parsePHP(content) };
      case 'json':
        return { ...base, ...parseJSON(filePath, content) };
      case 'markdown':
        return { ...base, ...parseMarkdown(content) };
      case 'pdf':
      case 'docx':
      case 'pptx':
      case 'xlsx':
        return { ...base, ...parseDocumentText(content) };
      default:
        return { ...base, ...parseGeneric(content) };
    }
  } catch {
    return base; // never crash on malformed file
  }
}

// ── JavaScript / TypeScript ───────────────────────────────────────────────────

function parseJS(content) {
  const functions  = [];
  const classes    = [];
  const imports    = [];
  const exports    = [];
  const interfaces = [];
  const comments   = [];
  let m;

  // ES6 imports
  const importRe = /^import\s+(?:(?:type\s+)?(?:{[^}]*}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(?:{[^}]*}|\w+))?\s+from\s+)?['"]([^'"]+)['"]/gm;
  while ((m = importRe.exec(content)) !== null) push(imports, m[1]);

  // require()
  const requireRe = /require\(['"]([^'"]+)['"]\)/g;
  while ((m = requireRe.exec(content)) !== null) push(imports, m[1]);

  // Named exports
  const exportNamedRe = /^export\s+(?:default\s+)?(?:async\s+)?(?:function\s+(\w+)|class\s+(\w+)|const\s+(\w+)|let\s+(\w+)|var\s+(\w+))/gm;
  while ((m = exportNamedRe.exec(content)) !== null) {
    const name = m[1] || m[2] || m[3] || m[4] || m[5];
    if (name) push(exports, name);
  }

  // export { a, b as c }
  const exportBlockRe = /^export\s+\{([^}]+)\}/gm;
  while ((m = exportBlockRe.exec(content)) !== null) {
    m[1].split(',')
      .map(s => s.trim().replace(/\s+as\s+\w+/, '').trim())
      .filter(Boolean)
      .forEach(n => push(exports, n));
  }

  // Function declarations
  const funcDeclRe = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/gm;
  while ((m = funcDeclRe.exec(content)) !== null) push(functions, m[1]);

  // Arrow / method functions: const foo = () =>
  const arrowRe = /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w]+)\s*=>/gm;
  while ((m = arrowRe.exec(content)) !== null) push(functions, m[1]);

  // Class declarations
  const classRe = /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+([\w.]+))?/gm;
  while ((m = classRe.exec(content)) !== null) {
    classes.push({ name: m[1], extends: m[2] || null });
  }

  // TypeScript interfaces + type aliases
  const ifaceRe = /^(?:export\s+)?interface\s+(\w+)/gm;
  while ((m = ifaceRe.exec(content)) !== null) push(interfaces, m[1]);
  const typeRe  = /^(?:export\s+)?type\s+(\w+)\s*=/gm;
  while ((m = typeRe.exec(content)) !== null) push(interfaces, m[1]);

  // JSDoc first lines
  const docRe = /\/\*\*\s*\n\s*\*\s*([^\n]+)/g;
  while ((m = docRe.exec(content)) !== null) comments.push(m[1].trim().slice(0, 150));

  return { functions, classes, imports, exports, interfaces, comments };
}

// ── Python ────────────────────────────────────────────────────────────────────

function parsePython(content) {
  const functions = [];
  const classes   = [];
  const imports   = [];
  const exports   = [];
  const comments  = [];
  let m;

  const importRe = /^(?:from\s+([\w.]+)\s+import\s+[\w*, ()]+|import\s+([\w., ]+))/gm;
  while ((m = importRe.exec(content)) !== null) {
    const mod = m[1] ?? m[2]?.split(',')[0]?.trim();
    if (mod) push(imports, mod);
  }

  const funcRe = /^(?:    )*(?:async\s+)?def\s+(\w+)\s*\(/gm;
  while ((m = funcRe.exec(content)) !== null) push(functions, m[1]);

  const classRe = /^class\s+(\w+)(?:\s*\(([^)]*)\))?/gm;
  while ((m = classRe.exec(content)) !== null) {
    classes.push({ name: m[1], extends: m[2]?.trim() || null });
  }

  const allMatch = content.match(/__all__\s*=\s*\[([^\]]+)\]/);
  if (allMatch) {
    const names = allMatch[1].match(/['"](\w+)['"]/g) || [];
    names.map(n => n.replace(/['"]/g, '')).forEach(n => push(exports, n));
  }

  const docRe = /"""([^"]{0,200})/g;
  while ((m = docRe.exec(content)) !== null) {
    const first = m[1].trim().split('\n')[0].trim();
    if (first) comments.push(first.slice(0, 150));
  }

  return { functions, classes, imports, exports, comments };
}

// ── Java / Kotlin ─────────────────────────────────────────────────────────────

function parseJava(content) {
  const functions  = [];
  const classes    = [];
  const imports    = [];
  const interfaces = [];
  let m;

  const importRe = /^import\s+(?:static\s+)?([\w.]+)(?:\.\*)?;/gm;
  while ((m = importRe.exec(content)) !== null) push(imports, m[1].split('.').slice(-2).join('.'));

  const classRe = /(?:public|private|protected|abstract|final|\s)+class\s+(\w+)/g;
  while ((m = classRe.exec(content)) !== null) classes.push({ name: m[1], extends: null });

  const ifaceRe = /(?:public|private)?\s+interface\s+(\w+)/g;
  while ((m = ifaceRe.exec(content)) !== null) push(interfaces, m[1]);

  const methodRe = /(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?(?:[\w<>[\],\s]+)\s+(\w+)\s*\([^)]*\)\s*(?:throws\s+[\w,\s]+)?\s*\{/g;
  while ((m = methodRe.exec(content)) !== null) {
    const name = m[1];
    if (!['if', 'while', 'for', 'switch', 'catch', 'return'].includes(name)) push(functions, name);
  }

  return { functions, classes, imports, interfaces };
}

// ── Go ────────────────────────────────────────────────────────────────────────

function parseGo(content) {
  const functions = [];
  const imports   = [];
  let m;

  const singleImport = /^import\s+"([^"]+)"/gm;
  while ((m = singleImport.exec(content)) !== null) push(imports, m[1]);

  const blockImport = /import\s*\(([^)]+)\)/;
  const block = content.match(blockImport);
  if (block) {
    const lineRe = /"([^"]+)"/g;
    while ((m = lineRe.exec(block[1])) !== null) push(imports, m[1]);
  }

  const funcRe = /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/gm;
  while ((m = funcRe.exec(content)) !== null) push(functions, m[1]);

  return { functions, imports };
}

// ── Rust ──────────────────────────────────────────────────────────────────────

function parseRust(content) {
  const functions = [];
  const imports   = [];
  let m;

  const useRe = /^use\s+([\w::{},\s*]+);/gm;
  while ((m = useRe.exec(content)) !== null) {
    const top = m[1].split('::')[0].trim();
    if (top) push(imports, top);
  }

  const fnRe = /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/gm;
  while ((m = fnRe.exec(content)) !== null) push(functions, m[1]);

  return { functions, imports };
}

// ── C# ───────────────────────────────────────────────────────────────────────

function parseCSharp(content) {
  const functions  = [];
  const classes    = [];
  const interfaces = [];
  const imports    = [];
  let m;

  const usingRe = /^using\s+([\w.]+);/gm;
  while ((m = usingRe.exec(content)) !== null) push(imports, m[1]);

  const classRe = /(?:public|private|internal|protected|abstract|sealed|\s)+class\s+(\w+)/g;
  while ((m = classRe.exec(content)) !== null) classes.push({ name: m[1], extends: null });

  const ifaceRe = /interface\s+(\w+)/g;
  while ((m = ifaceRe.exec(content)) !== null) push(interfaces, m[1]);

  const methodRe = /(?:public|private|protected|internal|static|virtual|override|async)\s+(?:[\w<>[\]?,\s]+)\s+(\w+)\s*\([^)]*\)/g;
  while ((m = methodRe.exec(content)) !== null) {
    if (!['if', 'while', 'for', 'foreach', 'switch'].includes(m[1])) push(functions, m[1]);
  }

  return { functions, classes, interfaces, imports };
}

// ── PHP ───────────────────────────────────────────────────────────────────────

function parsePHP(content) {
  const functions = [];
  const classes   = [];
  const imports   = [];
  let m;

  const useRe = /^use\s+([\w\\]+)(?:\s+as\s+\w+)?;/gm;
  while ((m = useRe.exec(content)) !== null) push(imports, m[1].split('\\').pop());

  const requireRe = /(?:require|include)(?:_once)?\s*\(?['"]([^'"]+)['"]/g;
  while ((m = requireRe.exec(content)) !== null) push(imports, m[1]);

  const classRe = /(?:abstract\s+)?class\s+(\w+)/g;
  while ((m = classRe.exec(content)) !== null) classes.push({ name: m[1], extends: null });

  const funcRe = /function\s+(\w+)\s*\(/g;
  while ((m = funcRe.exec(content)) !== null) push(functions, m[1]);

  return { functions, classes, imports };
}

// ── JSON ──────────────────────────────────────────────────────────────────────

function parseJSON(filePath, content) {
  const dependencies = [];
  const keywords     = [];

  try {
    const data = JSON.parse(content);
    const base = path.basename(filePath).toLowerCase();

    if (base === 'package.json') {
      Object.keys({ ...data.dependencies, ...data.devDependencies, ...data.peerDependencies })
        .forEach(k => push(dependencies, k));
      if (data.name)        keywords.push(data.name);
      if (data.description) keywords.push(data.description);
    }
  } catch { /* malformed JSON */ }

  return { dependencies, keywords };
}

// ── Markdown ──────────────────────────────────────────────────────────────────

function parseMarkdown(content) {
  const comments = [];
  let m;
  const h1 = /^#\s+(.+)$/gm;
  const h2 = /^##\s+(.+)$/gm;
  while ((m = h1.exec(content)) !== null) comments.push(m[1]);
  while ((m = h2.exec(content)) !== null) comments.push(m[1]);
  return { comments };
}

// ── Documents (PDF/DOCX/PPTX/XLSX — text pre-extracted by documentParser.js) ──

function parseDocumentText(content) {
  const comments = [];

  // PPTX/XLSX arrive pre-sectioned into "-- Slide N --" / "-- Sheet: name --"
  // blocks (see project/documentParser.js) — surface those headers the same
  // way parseMarkdown() surfaces # / ## headers, giving a slide/sheet outline.
  const sectionRe = /^-- (Slide \d+|Sheet: .+) --$/gm;
  let m;
  while ((m = sectionRe.exec(content)) !== null) comments.push(m[1]);

  // PDF/DOCX have no such structure — fall back to a short first-line preview.
  if (!comments.length) {
    const firstLine = content.split('\n').map(l => l.trim()).find(Boolean);
    if (firstLine) comments.push(firstLine.slice(0, 150));
  }

  return { comments: comments.slice(0, 20) }; // cap: a 200-slide deck shouldn't dominate the summary
}

// ── Generic ───────────────────────────────────────────────────────────────────

function parseGeneric(content) {
  const comments = [];
  const tagRe = /(?:\/\/|#)\s*(TODO|FIXME|HACK|NOTE|XXX):?\s*(.+)/gi;
  let m;
  while ((m = tagRe.exec(content)) !== null) {
    comments.push(`${m[1]}: ${m[2].trim().slice(0, 100)}`);
  }
  return { comments };
}

// ── Helper ────────────────────────────────────────────────────────────────────

function push(arr, value) {
  if (value && !arr.includes(value)) arr.push(value);
}
