/**
 * Artifact intent detector — table-driven regression suite.
 * Positives cover the spec's own examples; negatives enforce the
 * edit-branch-style conservatism (questions/how-tos/inline requests never
 * trigger a file).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectArtifactIntent, MIN_ARTIFACT_CONFIDENCE } from '../artifactIntent.js';

const POSITIVE = [
  // [message, expectedFormat]
  ['Create a pitch deck for my startup',                       'pptx'],
  ['Generate an investor pitch deck',                          'pptx'],
  ['Make me a presentation about Q3 results',                  'pptx'],
  ['Generate invoice for client Acme',                         'pdf'],
  ['Write my resume',                                          'pdf'],
  ['Create a whitepaper on vector databases',                  'pdf'],
  ['Write my study notes as a markdown file',                  'md'],
  ['Generate a README for this repo',                          'md'],
  ['Create documentation for the API',                         'md'],
  ['Build a landing page for the product',                     'html'],
  ['Draft a docker compose for postgres and redis',            'yaml'],
  ['Generate a Dockerfile for a node app',                     'dockerfile'],
  ['Create kubernetes manifests for the service',              'k8s'],
  ['Write a terraform config for an S3 bucket',                'terraform'],
  ['Generate an OpenAPI spec for the users API',               'openapi'],
  ['Create a postman collection for these endpoints',          'postman'],
  ['Generate a SQL schema for a blog',                         'sql'],
  ['Write a bash script to back up the db',                    'sh'],
  ['Make a batch file that cleans temp folders',               'bat'],
  ['Export the data as a .csv file',                           'csv'],
  ['Create a csv of the monthly totals',                       'csv'],
  ['Generate a spreadsheet with a financial model',            'xlsx'],
  ['Draw an architecture diagram of the system',               'mermaid'],
  ['Design a mindmap of the course topics',                    'mermaid'],
  ['Create an svg logo for AQUA',                              'svg'],
  ['Build me an Airbnb clone',                                 'project'],
  ['Generate a full SaaS boilerplate',                         'project'],
  ['Build a react app for todo tracking',                      'project'],
  ['Create a node backend with express',                       'project'],
  ['Generate a python project for scraping',                   'project'],
  ['Make a flutter app skeleton',                              'project'],
  ['Write a report on EV adoption I can download as a .pdf',   'pdf'],
  ['Create notes.md summarizing the meeting',                  'md'],
];

const POSITIVE_NO_FORMAT = [
  'Write this up as a file I can download',
  'Generate the summary as a downloadable file',
];

const NEGATIVE = [
  'How do I make a pptx in python?',
  'What is a Dockerfile?',
  'Can you explain how to create a pitch deck?',
  'Should I write my resume in LaTeX?',
  'Explain the report to me',
  'Tell me about kubernetes manifests',
  'Create a pitch deck?',                       // trailing question mark
  'Write a poem about the sea',                 // no file signal → chat
  'Fix the bug in auth.js',                     // edit-branch territory
  'Generate ideas for the launch',              // brainstorm, no file signal
  "Write a summary but don't generate a file, just show it inline",
  'Make a csv but no download, just explain the columns',
  'hello there',
  '',
];

test('positive: spec examples map to their true formats', () => {
  for (const [msg, fmt] of POSITIVE) {
    const r = detectArtifactIntent(msg);
    assert.equal(r.wants, true, `should want artifact: "${msg}" (got: ${r.reason})`);
    assert.equal(r.format, fmt, `"${msg}" → expected ${fmt}, got ${r.format}`);
    assert.ok(r.confidence >= MIN_ARTIFACT_CONFIDENCE, `"${msg}" confidence ${r.confidence} below floor`);
  }
});

test('positive without explicit format: planner resolves', () => {
  for (const msg of POSITIVE_NO_FORMAT) {
    const r = detectArtifactIntent(msg);
    assert.equal(r.wants, true, `"${msg}"`);
    assert.equal(r.format, null);
    assert.ok(r.confidence >= MIN_ARTIFACT_CONFIDENCE);
  }
});

test('negative: questions, how-tos, inline requests, no-signal messages', () => {
  for (const msg of NEGATIVE) {
    const r = detectArtifactIntent(msg);
    assert.equal(r.wants, false, `should NOT want artifact: "${msg}" (matched: ${r.matched ?? '-'}, reason: ${r.reason})`);
  }
});

test('detector is pure — same input, same output', () => {
  const a = detectArtifactIntent('Create a pitch deck for my startup');
  const b = detectArtifactIntent('Create a pitch deck for my startup');
  assert.deepEqual(a, b);
});
