/**
 * P6.1 — regression suite for the reported failure:
 *   "Create a 15-slide Series A pitch deck… Export as PPTX" fell back to chat.
 *
 * Root cause was NOT the detector (it fired correctly, conf 0.9). It was the
 * planner's 1,500-token budget: the model outlined all 15 slides into
 * `structure`, hit maxTokens, and returned truncated JSON that the strict
 * parser rejected — twice — before giving up.
 *
 * These tests pin the four fixes so it cannot regress.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { extractJson, repairTruncatedJson, planArtifact } = await import('../planner.js');
const { detectArtifactIntent, MIN_ARTIFACT_CONFIDENCE } = await import('../artifactIntent.js');
await import('../engine.js'); // register exporters so planArtifact knows pptx

const REPORTED_PROMPT =
  'Create a 15-slide Series A pitch deck for my startup AQUA covering problem, solution, market, traction, team, and ask. Export as PPTX.';

// ── 1. Detection (was never broken — pinned so the claim stays testable) ──────

test('the reported prompt detects as a pptx artifact, above the confidence floor', () => {
  const r = detectArtifactIntent(REPORTED_PROMPT);
  assert.equal(r.wants, true);
  assert.equal(r.format, 'pptx');
  assert.ok(r.confidence >= MIN_ARTIFACT_CONFIDENCE);
});

// ── 2. Explicit format statements outrank deliverable nouns ──────────────────

test('an explicitly stated format beats the noun that implies another format', () => {
  // "report" alone → pdf; with "Export as PPTX" the stated format must win.
  assert.equal(detectArtifactIntent('Create a report. Export as PPTX').format, 'pptx');
  assert.equal(detectArtifactIntent('Write up the notes and save as DOCX').format, 'docx');
  assert.equal(detectArtifactIntent('Generate a budget summary, export as XLSX').format, 'xlsx');
  assert.equal(detectArtifactIntent('Create an invoice, save as PDF').format, 'pdf');
  assert.equal(detectArtifactIntent('Build a Series A deck and export as PPTX').format, 'pptx');
  assert.equal(detectArtifactIntent('Draft the agreement as a Word document').format, 'docx');
  // Without the export context, a bare mention must NOT hijack the format.
  assert.equal(detectArtifactIntent('Create a pitch deck about PDF tooling').format, 'pptx');
});

// ── 3. Tolerant JSON: truncated plans are recovered, not discarded ────────────

test('extractJson recovers the exact truncated 15-slide plan Gemini returned', () => {
  const truncated = [
    '```json',
    '{',
    '  "format": "pptx",',
    '  "title": "AQUA Series A Pitch Deck",',
    '  "files": [{ "path": "aqua-deck.pptx", "role": "primary", "description": "The deck" }],',
    '  "packaging": "auto",',
    '  "constraints": { "slideCount": 15 },',
    '  "structure": { "slides": ["Title", "Problem", "Solution", "Market Size and the enormous oppo',
  ].join('\n');

  const spec = extractJson(truncated);
  assert.ok(spec, 'a truncated plan must be recovered, not thrown away');
  assert.equal(spec.format, 'pptx');
  assert.equal(spec.files.length, 1);
  assert.equal(spec.constraints.slideCount, 15);
  assert.deepEqual(spec.structure.slides.slice(0, 3), ['Title', 'Problem', 'Solution']);
});

test('extractJson tolerates prose/markdown wrappers and odd truncation points', () => {
  assert.deepEqual(
    extractJson('Sure! Here is the plan:\n```json\n{"format":"md","title":"X"}\n```\nHope that helps!'),
    { format: 'md', title: 'X' },
  );
  // dangling key with no value
  assert.deepEqual(
    extractJson('{"format":"pptx","title":"T","structure":{"a":1,"b"'),
    { format: 'pptx', title: 'T', structure: { a: 1 } },
  );
  // cut mid-number / mid-array
  assert.deepEqual(extractJson('{"format":"csv","n":12'), { format: 'csv', n: 12 });
  assert.deepEqual(extractJson('{"a":[1,2,3'), { a: [1, 2, 3] });
  // valid JSON must pass through byte-identical in meaning
  assert.deepEqual(extractJson('{"a":[1,2,{"b":"c"}]}'), { a: [1, 2, { b: 'c' }] });
  // genuinely unsalvageable
  assert.equal(extractJson('total nonsense, no braces'), null);
  assert.equal(extractJson(''), null);
  assert.equal(extractJson(null), null);
});

test('repairTruncatedJson never invents content — it only closes structure', () => {
  assert.equal(repairTruncatedJson('{"a":1'), '{"a":1}');
  assert.equal(repairTruncatedJson('{"a":"unterminated'), '{"a":"unterminated"}');
  assert.equal(repairTruncatedJson('{"a":[1,2,'), '{"a":[1,2]}');
  assert.equal(repairTruncatedJson('{"a":1,'), '{"a":1}');
  // Braces inside strings must not be counted as structure.
  assert.equal(repairTruncatedJson('{"a":"}{"'), '{"a":"}{"}');
});

// ── 4. Planner survives a truncated first reply end-to-end ───────────────────

test('planArtifact succeeds on a truncated reply WITHOUT burning a repair call', async () => {
  let calls = 0;
  const generate = async () => {
    calls += 1;
    return {
      // Truncated mid-structure, exactly like the reported Gemini reply.
      text: '{"format":"pptx","title":"AQUA Series A","files":[{"path":"deck.pptx","role":"primary"}],"packaging":"auto","constraints":{"slideCount":15},"structure":{"slides":["Title","Problem","Sol',
      provider: 'gemini',
      truncated: true,
      finishReason: 'length',
    };
  };

  const { spec, repaired } = await planArtifact({
    userMessage: REPORTED_PROMPT,
    intent: { wants: true, format: 'pptx', confidence: 0.9 },
    requestId: 'req-trunc', conversationId: 'c1',
    generate,
  });

  assert.equal(spec.format, 'pptx');
  assert.equal(spec.files[0].path, 'deck.pptx');
  assert.equal(spec.constraints.slideCount, 15);
  assert.equal(repaired, false, 'recovery happens in-parser — no second model call');
  assert.equal(calls, 1, 'one call, not the two truncated calls the bug report describes');
});

test('planner budget is large enough for a 15-slide plan', async () => {
  // The old 1,500-token budget is what truncated the plan. Pin the headroom:
  // capture the budget the planner actually passes to the router.
  let budget = null;
  const generate = async (_u, _s, _m, _c, _t, _e, responseBudget) => {
    budget = responseBudget;
    return { text: '{"format":"md","title":"X","files":[{"path":"x.md"}],"packaging":"auto"}', provider: 'stub' };
  };
  await planArtifact({
    userMessage: 'Write my notes as a markdown file',
    intent: { wants: true, format: 'md', confidence: 0.9 },
    requestId: 'req-budget', generate,
  });
  assert.ok(budget.maxResponseTokens >= 4_000, `planner budget too small: ${budget.maxResponseTokens}`);
});

test('a truncated AND unsalvageable reply still gets exactly one terser retry', async () => {
  const seen = [];
  let calls = 0;
  // Router signature: generateText(userMessage, systemPrompt, messages, ctx, ...)
  // — the planner passes its repair content in `messages`, not arg 1.
  const generate = async (_userMessage, _systemPrompt, messages) => {
    calls += 1;
    seen.push(messages.map(m => m.content).join('\n'));
    if (calls === 1) return { text: 'I would love to help you build this deck!', provider: 'gemini', truncated: true, finishReason: 'length' };
    return { text: '{"format":"pptx","title":"AQUA","files":[{"path":"deck.pptx","role":"primary"}],"packaging":"auto"}', provider: 'gemini' };
  };
  const { spec, repaired } = await planArtifact({
    userMessage: REPORTED_PROMPT,
    intent: { wants: true, format: 'pptx', confidence: 0.9 },
    requestId: 'req-retry', generate,
  });
  assert.equal(calls, 2);
  assert.equal(repaired, true);
  assert.equal(spec.format, 'pptx');
  // The retry must ask for a SHORTER plan — repeating the same prompt just
  // truncates again (the original bug's second failure).
  assert.match(seen[1], /CUT OFF|SHORTER/i);
});
