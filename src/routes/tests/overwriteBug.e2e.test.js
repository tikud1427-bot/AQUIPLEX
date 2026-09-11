/**
 * Phase 0 — THE overwrite-bug end-to-end regression (audit §1, F1/F3/F5).
 *
 * Reproduces the production failure at the exact seam it lived in, for every
 * attachment kind, with the REAL pipeline pieces the bug flowed through:
 *
 *   attachmentStore.attachToConversation()   (real — what upload.js writes
 *                                             after Gemini analysis)
 *   formatAttachmentsForPrompt()             (real — what grounded the draft)
 *   composeEvidenceContext()                 (real — Phase 0 grounding contract)
 *   runVerification() / runDebate()          (real — with a HOSTILE injected
 *                                             `generate` playing the exact
 *                                             malfunction observed in prod:
 *                                             "I cannot watch videos")
 *
 * Only the model call is faked (same injection seam every intelligence test
 * uses) — everything else is the shipping code path. The provider analysis
 * itself was never the bug: uploads worked, Gemini worked, the draft was
 * correct; the overwrite happened downstream. That downstream is what these
 * tests pin shut, per kind:
 *
 *   video · image · audio · document(PDF) · source · repository(workspace)
 *
 * Pass criterion for every kind: the grounded draft survives VERBATIM, the
 * malfunction is counted as a suppression (not a revision — the ledger
 * stays clean, audit F2), and the reviewer demonstrably SAW the evidence.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-overwrite-e2e-'));
process.env.AQUA_DATA_DIR = TMP;

const { attachToConversation, clearAttachments, formatAttachmentsForPrompt } =
  await import('../../upload/attachmentStore.js');
const { composeEvidenceContext } = await import('../../intelligence/evidenceContext.js');
const { runVerification }        = await import('../../intelligence/verificationAgent.js');
const { runDebate }              = await import('../../intelligence/debateAgent.js');

// ── The observed malfunction, verbatim class ─────────────────────────────────
const HOSTILE_REVISIONS = {
  video:      "I cannot watch videos. As an AI language model I don't have the ability to view video content.",
  image:      "As an AI, I can't see images, so I'm unable to describe this picture.",
  audio:      "I'm unable to listen to audio recordings or transcribe them.",
  document:   "I cannot open PDFs or read documents that are uploaded.",
  source:     "I don't have access to the uploaded files, so I can't review this code.",
  repository: "I do not have access to your files or repository, so I cannot analyze the codebase.",
};

function hostileGenerate(refusal) {
  const calls = [];
  const fn = async (userMessage, systemPrompt, messages, ctx, preTaskType, plan, budget) => {
    calls.push({ userMessage, systemPrompt, messages });
    return { text: refusal, provider: 'mock-hostile' };
  };
  fn.calls = calls;
  return fn;
}

/** upload.js's post-analysis write, per kind — the normalized shape mediaPipeline/documentPipeline return. */
function attach(conv, kind, name, content) {
  attachToConversation(conv, {
    name, kind,
    normalized: {
      format: { video: 'mp4', image: 'png', audio: 'mp3', document: 'pdf', source: 'js' }[kind] ?? 'txt',
      title: name, content, metadata: { analyzed: true, model: 'gemini-test' },
      sections: [], pages: null, language: null, truncated: false,
    },
  });
}

const KIND_CASES = [
  {
    kind: 'video', name: 'meeting.mp4',
    analysis: 'SUMMARY: A person in a red jacket enters the conference room and places a backpack on the table.\nSCENES: 0:05 person enters; 0:12 backpack placed.',
    question: 'What happens in this video?',
    draft: 'In the video, a person in a red jacket enters the conference room and places a backpack on the table at 0:12.',
    evidenceMarker: /red jacket enters the conference room/,
  },
  {
    kind: 'image', name: 'whiteboard.png',
    analysis: 'CAPTION: Whiteboard with a system diagram.\nTEXT (OCR): "AQUA v5 — router → providers → verification"',
    question: 'What does this image show?',
    draft: 'The image shows a whiteboard with a system diagram reading "AQUA v5 — router → providers → verification".',
    evidenceMarker: /AQUA v5 — router/,
  },
  {
    kind: 'audio', name: 'standup.mp3',
    analysis: 'SUMMARY: Two speakers discuss the Q3 launch.\nTRANSCRIPT: "We ship the artifact engine on Friday."',
    question: 'What was said in this recording?',
    draft: 'In the recording, two speakers discuss the Q3 launch and confirm the artifact engine ships on Friday.',
    evidenceMarker: /artifact engine on Friday/,
  },
  {
    kind: 'document', name: 'contract.pdf',
    analysis: 'Page 3: The licensee shall pay ₹40,00,000 annually, renewable each April.',
    question: 'What does the contract say about payment?',
    draft: 'The contract requires the licensee to pay ₹40,00,000 annually, renewable each April (page 3).',
    evidenceMarker: /₹40,00,000 annually/,
  },
  {
    kind: 'source', name: 'router.js',
    analysis: 'export function rankProviders(taskType) { /* scores gemini, groq, openrouter */ }',
    question: 'What does the uploaded file do?',
    draft: 'The uploaded router.js exports rankProviders(), which scores gemini, groq, and openrouter per task type.',
    evidenceMarker: /rankProviders/,
  },
];

let convSeq = 0;
let conv;
beforeEach(() => { conv = `e2e-conv-${++convSeq}`; clearAttachments(conv); });

// ── Per-kind regression: upload → grounding → hostile verification ───────────

for (const c of KIND_CASES) {
  test(`E2E [${c.kind}]: grounded answer survives a hostile "capability refusal" verification verbatim`, async () => {
    // 1) Upload-time write (what upload.js persists after analysis).
    attach(conv, c.kind, c.name, c.analysis);

    // 2) Chat-time grounding (real formatter → real composer) — exactly
    //    what prepareTurn() now hands the reviewer.
    const attachmentContext = formatAttachmentsForPrompt(conv);
    assert.match(attachmentContext, c.evidenceMarker, 'sanity: analysis reached the prompt block');
    const evidenceContext = composeEvidenceContext({ attachmentContext });

    // 3) Verification with the observed malfunction as the reviser output.
    const generate = hostileGenerate(HOSTILE_REVISIONS[c.kind]);
    const result = await runVerification({
      userMessage: c.question,
      draftAnswer: c.draft,
      taskType: 'file_analysis',
      evidenceContext,
      maxPasses: 2,
      generate,
    });

    // THE assertion this phase exists for:
    assert.equal(result.finalAnswer, c.draft, 'the correct grounded answer must remain the final answer');
    assert.equal(result.revised, false, 'malfunction is a suppression, not a revision — ledger stays clean');
    assert.equal(result.suppressedRefusals, 1);
    assert.equal(result.grounded, true);
    // Grounding contract held: the reviewer SAW the drafter's evidence.
    assert.match(generate.calls[0].messages[0].content, c.evidenceMarker);
    assert.match(generate.calls[0].messages[0].content, /Evidence context available to the drafter/);
  });
}

// ── Repository/ZIP path: grounds via projectContext, same contract ───────────

test('E2E [repository]: workspace-grounded answer survives hostile verification (projectContext lane)', async () => {
  const projectContext = [
    'PROJECT CONTEXT — workspace ws-42 (uploaded repo.zip, 128 files):',
    'src/providers/router.js — rankProviders() scores gemini/groq/openrouter per taskType.',
    'src/routes/chat.js — prepareTurn() grounds every turn before generation.',
  ].join('\n');
  const evidenceContext = composeEvidenceContext({ projectContext });

  const generate = hostileGenerate(HOSTILE_REVISIONS.repository);
  const result = await runVerification({
    userMessage: 'How does provider ranking work in my uploaded repo?',
    draftAnswer: 'In your repo, src/providers/router.js ranks providers via rankProviders(), scoring gemini, groq, and openrouter per task type.',
    taskType: 'project_query',
    evidenceContext,
    generate,
  });

  assert.equal(result.revised, false);
  assert.equal(result.suppressedRefusals, 1);
  assert.match(generate.calls[0].messages[0].content, /rankProviders\(\) scores gemini/);
});

// ── Deep-review lane: the debate panel under the same malfunction ────────────

test('E2E [video, debate lane]: escalating panel + hostile revision — grounded draft ships, objection preserved', async () => {
  const c = KIND_CASES[0];
  attach(conv, c.kind, c.name, c.analysis);
  const evidenceContext = composeEvidenceContext({ attachmentContext: formatAttachmentsForPrompt(conv) });

  const calls = [];
  const seq = [
    JSON.stringify({ findings: [
      { persona: 'skeptic', verdict: 'issue', severity: 'high', issue: 'video claims unverifiable', suggestion: 'remove them' },
      { persona: 'analyst', verdict: 'pass' },
      { persona: 'architect', verdict: 'pass' },
    ]}),
    HOSTILE_REVISIONS.video,
  ];
  const generate = async (...args) => { calls.push(args); return { text: seq[calls.length - 1], provider: 'mock' }; };

  const result = await runDebate({
    userMessage: c.question,
    draftAnswer: c.draft,
    taskType: 'analysis',
    evidenceContext,
    maxPasses: 2,
    generate,
  });

  assert.equal(result.finalAnswer, c.draft);
  assert.equal(result.revised, false);
  assert.equal(result.disagreements.length, 1, "panel's objection preserved on the record");
});

// ── Control: the guard never blocks legitimate factual corrections ───────────

test('E2E control: a real factual correction on a grounded video turn is still adopted', async () => {
  const c = KIND_CASES[0];
  attach(conv, c.kind, c.name, c.analysis);
  const evidenceContext = composeEvidenceContext({ attachmentContext: formatAttachmentsForPrompt(conv) });

  const corrected = 'In the video, the backpack is placed on the table at 0:12 — the draft said 0:20, which contradicts the scene timeline.';
  const generate = hostileGenerate(corrected); // not hostile — a genuine fix

  const result = await runVerification({
    userMessage: 'When is the backpack placed?',
    draftAnswer: 'The backpack is placed at 0:20.',
    taskType: 'file_analysis',
    evidenceContext,
    generate,
  });

  assert.equal(result.revised, true);
  assert.equal(result.finalAnswer, corrected);
  assert.equal(result.suppressedRefusals, 0);
});
