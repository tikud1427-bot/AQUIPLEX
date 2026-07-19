/**
 * Evidence Context — Phase 0 regression tests (audit F1/F3/F5).
 *
 * Guards the two invariants the overwrite-bug fix rests on:
 *   1. composeEvidenceContext() assembles exactly the grounding the drafter
 *      had, labeled and ordered, and is '' when nothing was grounded (so
 *      ungrounded turns stay byte-identical to pre-Phase-0 behavior).
 *   2. isCapabilityRefusal() catches every observed "I cannot watch videos"
 *      formulation while NEVER matching ordinary grounded answers — a false
 *      positive here would silently disable legitimate revisions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  composeEvidenceContext,
  hasGroundedEvidence,
  isCapabilityRefusal,
} from './evidenceContext.js';

// ── composeEvidenceContext ───────────────────────────────────────────────────

test('empty parts compose to empty string (ungrounded turn unchanged)', () => {
  assert.equal(composeEvidenceContext(), '');
  assert.equal(composeEvidenceContext({}), '');
  assert.equal(composeEvidenceContext({ attachmentContext: '', searchContext: '   ' }), '');
  assert.equal(hasGroundedEvidence(''), false);
  assert.equal(hasGroundedEvidence('   '), false);
});

test('single part composes with its label', () => {
  const out = composeEvidenceContext({ attachmentContext: 'VIDEO analysis: cat jumps.' });
  assert.match(out, /── UPLOADED FILE ANALYSES ──\nVIDEO analysis: cat jumps\./);
  assert.equal(hasGroundedEvidence(out), true);
});

test('all parts compose in fixed order: attachments, project, search, memory', () => {
  const out = composeEvidenceContext({
    memoryBlock:       'M',
    searchContext:     'S',
    projectContext:    'P',
    attachmentContext: 'A',
  });
  const idx = [
    out.indexOf('UPLOADED FILE ANALYSES'),
    out.indexOf('PROJECT / WORKSPACE CONTEXT'),
    out.indexOf('WEB SEARCH RESULTS'),
    out.indexOf('MEMORY CONTEXT'),
  ];
  assert.ok(idx.every(i => i !== -1), 'every label present');
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b), 'labels in contract order');
});

test('non-string parts are ignored, never throw', () => {
  const out = composeEvidenceContext({ attachmentContext: null, projectContext: 42, searchContext: undefined, memoryBlock: 'M' });
  assert.match(out, /MEMORY CONTEXT/);
  assert.doesNotMatch(out, /UPLOADED FILE ANALYSES|PROJECT|SEARCH/);
});

// ── isCapabilityRefusal — must catch ─────────────────────────────────────────

const REFUSALS = [
  "I cannot watch videos.",
  "I can't watch videos, but I can help if you describe it.",
  "I'm unable to view images or videos directly.",
  "I am not able to access the video you uploaded.",
  "Unfortunately, I cannot actually watch video files.",
  "As an AI language model, I cannot view videos.",
  "As an AI, I can't see images.",
  "I don't have the ability to listen to audio recordings.",
  "I do not have the capability to process video content.",
  "I don't have access to the uploaded files.",
  "I do not have direct access to any attachments.",
  "I lack the ability to analyze images.",
  "There is no way to watch the video from here.",
  "I cannot open PDFs or documents.",
  "I can’t read the attached document.", // curly apostrophe
  "I'm unable to transcribe audio files.",
];

for (const text of REFUSALS) {
  test(`catches capability refusal: "${text.slice(0, 50)}"`, () => {
    assert.equal(isCapabilityRefusal(text), true);
  });
}

// ── isCapabilityRefusal — must NOT match ─────────────────────────────────────

const LEGITIMATE = [
  '', null, undefined,
  "The video shows a person entering the room, then the door closes.",
  "In the video, the red backpack is visible at 0:42.",
  "Based on the transcript, the meeting covered Q3 revenue.",
  "The audio contains two speakers discussing the contract.",
  "I can't verify this specific claim without more data.",              // inability, no media noun
  "I cannot confirm the exact date mentioned in the report.",           // 'report' guarded by verb set
  "The video cannot be compressed further without quality loss.",       // inability not first-person
  "You cannot upload files larger than 20 MB.",                         // second person
  "The image classifier failed to converge during training.",           // technical prose
  "I watched for null pointers throughout the code and found none.",    // 'watched' non-media
  "The document describes how videos are encoded.",
  "I can see the chart shows revenue rising in Q3.",                    // positive capability
];

for (const text of LEGITIMATE) {
  test(`never matches legitimate text: "${String(text).slice(0, 50)}"`, () => {
    assert.equal(isCapabilityRefusal(text), false);
  });
}
