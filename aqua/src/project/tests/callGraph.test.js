/**
 * Call graph tests — node --test src/project/tests/callGraph.test.js
 *
 * Every assertion is measurable. Covers: caller attribution (innermost),
 * cross-file edges, string/comment masking, constructor calls, method-access
 * exclusion, module-scope calls, unknown-symbol exclusion, Python defs,
 * transitive impact/trace, and clear.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCallGraph, clearCallGraph, getCallGraph,
  whoCalls, whatCalls, impactOf, traceFrom, getDefinitions,
  serializeCallGraph, getCallGraphStats,
  maskCode, extractBraceFunctions, extractPythonFunctions,
} from '../callGraph.js';

// Helper: minimal parsed-file record (only fields buildCallGraph reads).
function f(path, content, extra = {}) {
  const lang = extra.lang ?? (path.endsWith('.py') ? 'python' : 'javascript');
  return {
    path, lang, content,
    functions: extra.functions ?? [],
    classes: extra.classes ?? [],
    exports: extra.exports ?? [],
  };
}

let ws = 0;
const nextWs = () => `cg-test-${++ws}`;

// ── maskCode ──────────────────────────────────────────────────────────────────

test('maskCode blanks strings + comments, preserves length and newlines', () => {
  const src = 'const a = "foo(bar)"; // call() here\nreal();';
  const masked = maskCode(src, 'javascript');
  assert.equal(masked.length, src.length, 'length preserved');
  assert.equal((masked.match(/\n/g) || []).length, 1, 'newlines preserved');
  assert.ok(!masked.includes('foo('), 'string content blanked');
  assert.ok(!masked.includes('call('), 'comment content blanked');
  assert.ok(masked.includes('real('), 'real code kept');
});

test('maskCode handles block comments and template literals', () => {
  const src = 'a(); /* danger() */ `tpl ${bad()}` end();';
  const masked = maskCode(src, 'javascript');
  assert.ok(!masked.includes('danger('), 'block comment blanked');
  assert.ok(!masked.includes('bad('), 'template literal blanked (documented)');
  assert.ok(masked.includes('a('), 'code before kept');
  assert.ok(masked.includes('end('), 'code after kept');
});

test('maskCode handles Python # comments and triple-quoted strings', () => {
  const src = 'x()  # hidden()\n"""\nblock() string\n"""\ny()';
  const masked = maskCode(src, 'python');
  assert.ok(!masked.includes('hidden('), 'py comment blanked');
  assert.ok(!masked.includes('block('), 'py triple string blanked');
  assert.ok(masked.includes('x('), 'code kept');
  assert.ok(masked.includes('y('), 'code after triple string kept');
});

// ── extractBraceFunctions ─────────────────────────────────────────────────────

test('extractBraceFunctions finds decl / arrow / method, skips control blocks', () => {
  const src = [
    'function alpha(a) { return a; }',
    'const beta = (x) => { return x; };',
    'class C {',
    '  gamma(y) { if (y) { return 1; } return 2; }',
    '}',
  ].join('\n');
  const funcs = extractBraceFunctions(maskCode(src, 'javascript'));
  const names = funcs.map(fn => fn.name).sort();
  assert.deepEqual(names, ['alpha', 'beta', 'gamma'], 'exactly the 3 named funcs (no if-block)');
});

test('extractBraceFunctions resolves TS return-type methods and object-property arrows', () => {
  const src = [
    'async function load(): Promise<void> { work(); }',
    'const api = { handler: (req) => { serve(req); } };',
  ].join('\n');
  const names = extractBraceFunctions(maskCode(src, 'javascript')).map(fn => fn.name).sort();
  assert.ok(names.includes('load'), 'TS return type method resolved');
  assert.ok(names.includes('handler'), 'object-property arrow resolved');
});

// ── caller attribution ────────────────────────────────────────────────────────

test('attributes calls to innermost enclosing named function', () => {
  const id = nextWs();
  const src = [
    'function outer() {',
    '  function inner() { target(); }',   // caller must be `inner`, not `outer`
    '  helper();',                         // caller `outer`
    '}',
  ].join('\n');
  buildCallGraph(id, [
    f('a.js', src, { functions: ['outer', 'inner', 'target', 'helper'] }),
  ]);

  const targetCallers = whoCalls(id, 'target');
  assert.equal(targetCallers.length, 1);
  assert.equal(targetCallers[0].caller, 'inner', 'innermost wins');

  const helperCallers = whoCalls(id, 'helper');
  assert.equal(helperCallers[0].caller, 'outer');
});

test('module-scope calls attribute to (module)', () => {
  const id = nextWs();
  buildCallGraph(id, [
    f('m.js', 'boot();\nfunction boot() {}', { functions: ['boot'] }),
  ]);
  const callers = whoCalls(id, 'boot');
  assert.equal(callers.length, 1);
  assert.equal(callers[0].caller, '(module)');
  assert.equal(callers[0].line, 1, 'line number correct');
});

test('cross-file edges: caller in one file, callee defined in another', () => {
  const id = nextWs();
  buildCallGraph(id, [
    f('util.js', 'export function fetchUser() { return 1; }', { functions: ['fetchUser'], exports: ['fetchUser'] }),
    f('svc.js', 'function loadProfile() { fetchUser(); }', { functions: ['loadProfile'] }),
  ]);
  const callers = whoCalls(id, 'fetchUser');
  assert.equal(callers.length, 1);
  assert.equal(callers[0].caller, 'loadProfile');
  assert.equal(callers[0].file, 'svc.js');
});

// ── masking correctness in the real pipeline ──────────────────────────────────

test('calls inside strings and comments are NOT recorded', () => {
  const id = nextWs();
  const src = [
    'function real() {',
    '  doThing();',
    '  const s = "doThing()";   // doThing()',
    '  /* doThing() */',
    '}',
  ].join('\n');
  buildCallGraph(id, [f('s.js', src, { functions: ['real', 'doThing'] })]);
  // exactly one real call to doThing, from real()
  const callers = whoCalls(id, 'doThing');
  assert.equal(callers.length, 1, 'string/comment occurrences ignored');
  assert.equal(callers[0].caller, 'real');
});

test('property/method access is excluded; constructor `new C()` is included', () => {
  const id = nextWs();
  const src = [
    'function run() {',
    '  arr.map();',       // NOT a call to a top-level `map` (has a `.`)
    '  const c = new Widget();',
    '}',
  ].join('\n');
  buildCallGraph(id, [
    f('r.js', src, { functions: ['run'], classes: [{ name: 'Widget' }] }),
    // define `map` as a repo symbol to prove the `.` guard (not knownSymbols) excludes it
    f('x.js', 'export function map() {}', { functions: ['map'], exports: ['map'] }),
  ]);
  assert.equal(whoCalls(id, 'map').length, 0, 'arr.map() excluded via . guard');
  const widget = whoCalls(id, 'Widget');
  assert.equal(widget.length, 1, 'constructor call recorded');
  assert.equal(widget[0].caller, 'run');
});

test('calls to unknown (non-repo) symbols are excluded', () => {
  const id = nextWs();
  buildCallGraph(id, [
    f('u.js', 'function go() { console.log(1); setTimeout(cb, 0); }', { functions: ['go'] }),
  ]);
  // console(/log) and setTimeout are not repo-defined → no edges besides none
  assert.equal(whoCalls(id, 'setTimeout').length, 0);
  assert.equal(whoCalls(id, 'log').length, 0);
  const stats = getCallGraphStats(id);
  assert.equal(stats.edges, 0, 'no spurious edges to builtins');
});

// ── transitive impact / trace ─────────────────────────────────────────────────

test('impactOf returns direct + transitive callers (a → b → c)', () => {
  const id = nextWs();
  const src = [
    'function a() { b(); }',
    'function b() { c(); }',
    'function c() { return 1; }',
  ].join('\n');
  buildCallGraph(id, [f('chain.js', src, { functions: ['a', 'b', 'c'] })]);

  const impact = impactOf(id, 'c');
  assert.deepEqual(impact.direct.sort(), ['b'], 'direct caller of c is b');
  assert.deepEqual(impact.transitive.sort(), ['a', 'b'], 'changing c impacts a and b');
});

test('traceFrom returns forward call chain', () => {
  const id = nextWs();
  const src = [
    'function handler() { validate(); persist(); }',
    'function validate() { normalize(); }',
    'function persist() {}',
    'function normalize() {}',
  ].join('\n');
  buildCallGraph(id, [f('flow.js', src, {
    functions: ['handler', 'validate', 'persist', 'normalize'],
  })]);

  const trace = traceFrom(id, 'handler');
  assert.deepEqual(trace.direct.sort(), ['persist', 'validate']);
  assert.deepEqual(trace.transitive.sort(), ['normalize', 'persist', 'validate']);
});

test('impact BFS is cycle-safe (recursive / mutual recursion does not hang)', () => {
  const id = nextWs();
  const src = [
    'function ping() { pong(); }',
    'function pong() { ping(); }',
  ].join('\n');
  buildCallGraph(id, [f('cyc.js', src, { functions: ['ping', 'pong'] })]);
  const impact = impactOf(id, 'ping');
  assert.ok(impact.transitive.includes('pong'), 'mutual caller found');
  // must terminate; presence of the assertion reaching here proves no hang
});

// ── whatCalls / defs / serialize ──────────────────────────────────────────────

test('whatCalls lists callees; getDefinitions lists def sites', () => {
  const id = nextWs();
  buildCallGraph(id, [
    f('d.js', 'function top() { one(); two(); }\nfunction one() {}\nfunction two() {}',
      { functions: ['top', 'one', 'two'] }),
  ]);
  assert.deepEqual(whatCalls(id, 'top').sort(), ['one', 'two']);
  const defs = getDefinitions(id, 'one');
  assert.equal(defs.length, 1);
  assert.equal(defs[0].file, 'd.js');
});

test('serializeCallGraph is JSON-safe and reflects edges', () => {
  const id = nextWs();
  buildCallGraph(id, [f('z.js', 'function p() { q(); }\nfunction q() {}', { functions: ['p', 'q'] })]);
  const s = serializeCallGraph(id);
  assert.ok(s && typeof s === 'object');
  assert.equal(s.edgeCount, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(s)).callers.q[0].caller, 'p');
});

// ── Python ────────────────────────────────────────────────────────────────────

test('extractPythonFunctions respects indentation blocks', () => {
  const src = [
    'def outer():',
    '    inner()',
    '    if x:',
    '        deep()',
    'def other():',
    '    pass',
  ].join('\n');
  const funcs = extractPythonFunctions(maskCode(src, 'python'));
  assert.deepEqual(funcs.map(fn => fn.name).sort(), ['other', 'outer']);
});

test('python call attribution + transitive impact', () => {
  const id = nextWs();
  const src = [
    'def a():',
    '    b()',
    'def b():',
    '    c()',
    'def c():',
    '    return 1',
  ].join('\n');
  buildCallGraph(id, [f('p.py', src, { functions: ['a', 'b', 'c'] })]);
  assert.equal(whoCalls(id, 'c')[0].caller, 'b', 'python caller attributed');
  assert.deepEqual(impactOf(id, 'c').transitive.sort(), ['a', 'b']);
});

// ── lifecycle ─────────────────────────────────────────────────────────────────

test('clearCallGraph removes state; queries degrade to empty', () => {
  const id = nextWs();
  buildCallGraph(id, [f('c.js', 'function a() { a(); }', { functions: ['a'] })]);
  assert.ok(getCallGraph(id));
  assert.equal(clearCallGraph(id), true);
  assert.equal(getCallGraph(id), null);
  assert.deepEqual(whoCalls(id, 'a'), []);
  assert.deepEqual(impactOf(id, 'a').transitive, []);
});

test('non-code files and missing content never crash the build', () => {
  const id = nextWs();
  buildCallGraph(id, [
    { path: 'readme.md', lang: 'markdown', content: '# hi call()' },
    { path: 'data.json', lang: 'json', content: '{"a":1}' },
    { path: 'nocontent.js', lang: 'javascript' },       // no content field
    f('ok.js', 'function a() {}', { functions: ['a'] }),
  ]);
  const stats = getCallGraphStats(id);
  assert.ok(stats, 'built despite junk inputs');
  assert.equal(stats.edges, 0);
});
