import { expect, test, type Page, type Route } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/**
 * UI leak + layout audit (2026-10-28). Runs the real app (vite dev) with every
 * API call answered by SYNTHETIC fixtures — no backend, no session, no real
 * person's data — so it can run anywhere:
 *
 *   npx playwright test e2e/ui-audit.spec.ts            # all viewport projects
 *   AUDIT_SHOTS=<dir> npx playwright test e2e/ui-audit.spec.ts   # + screenshots
 *
 * Per page and viewport it asserts: no sideways page scroll, nothing laid out
 * past the right edge (outside intentional scrollers), and none of the leak
 * strings the audit found. The fixtures deliberately carry the old leaks the
 * frontend guard must still stop (custom_ keys, intent ids, "Domain:", a
 * router error chain) plus long titles, a long URL, a table, code and maths.
 */

const SHOTS = process.env.AUDIT_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const now = Date.now();
const day = 86_400_000;
const LONG_URL = 'https://example.com/a/really/long/path/that/has/no/natural/break/points/whatsoever/and/keeps/going/until/it/overflows/a/phone/screen';

const belief = (dimension: string, key: string, value: unknown, extra: Record<string, unknown> = {}) => ({
  dimension, key, value, confidence: 0.62, evidenceCount: 3, contradictions: 0, status: 'active', locked: false,
  temporary: false, source: 'inference', updatedAt: now - 2 * day, evidenceText: 'From 3 observations — latest: mentioned react.', ...extra,
});

const MIND = {
  success: true, ownerId: 'user:demo', turnCount: 42, createdAt: now - 30 * day, updatedAt: now,
  identity: [
    belief('identity', 'profession', 'Product engineer', { source: 'explicit', evidenceText: 'You said this.' }),
    belief('identity', 'founder', true, { evidenceText: 'From 4 observations — latest: founder-context language.' }),
    belief('identity', 'project', 'Tidepool — an offline-first field notes app for marine biology researchers working on long expeditions', { source: 'explicit', evidenceText: 'From something you told Aqua.' }),
    belief('identity', 'custom_very_bored', 'very bored'),
  ],
  personality: [], preferences: [], behavior: [],
  communication: [
    belief('communication', 'response_length', 'brief', { source: 'explicit', evidenceCount: 2 }),
    belief('communication', 'message_style', 'terse'),
  ],
  decision: [belief('decision', 'risk_tolerance', 'cautious')],
  knowledge: [
    belief('knowledge', 'domain:machine_learning', 'familiar', { label: 'Machine learning', evidenceCount: 5 }),
    belief('knowledge', 'tech:react', 'familiar', { evidenceCount: 8 }),
    belief('knowledge', 'tech:postgres', 'familiar', { evidenceCount: 2 }),
    // Not here: domain:alpha. The server drops markup domains from GET /mind
    // (uiPayloadContract.test.js); the reflection below still names it.
  ],
  goals: [
    { id: 'g1', title: 'Ship the Tidepool public beta to the first fifty research teams before the spring field season starts', priority: 5, progress: 0.6, deadline: now + 20 * day, dependencies: [], blockers: ['App Store review'], relatedProjects: [], status: 'active', confidence: 0.55, mentions: 6, createdAt: now - 20 * day, updatedAt: now, lastMentionedAt: now - day },
    { id: 'g2', title: 'Hire a designer', priority: 5, progress: 0.2, deadline: null, dependencies: [], blockers: [], relatedProjects: [], status: 'blocked', confidence: 0.55, mentions: 2, createdAt: now - 10 * day, updatedAt: now, lastMentionedAt: now - 3 * day },
  ],
  activeGoals: ['g1'], episodes: [],
  working: {
    focus: [], updatedAt: now,
    focusRanked: [{ topic: 'simple_qa', weight: 5 }, { topic: 'react', weight: 3 }, { topic: 'offline sync', weight: 2 }],
    blockers: [{ text: 'App Store review', addedAt: now - day, lastSeenAt: now - day }],
    deadlines: [{ label: 'Beta launch on 12 Nov', addedAt: now - day }],
    recentDiscoveries: [], openQuestions: [{ text: 'Should sync use CRDTs?', addedAt: now - day, lastSeenAt: now - day }],
  },
  predictions: [{ label: 'Next questions likely about: simple_qa', probability: 0.6, basis: 'dominant working-memory focus', ts: now }],
  timeline: [
    { id: 't1', ts: now - 2 * day, kind: 'goal_created', subject: 'ship the Tidepool beta', detail: '', importance: 6 },
    { id: 't2', ts: now - day, kind: 'episode_opened', subject: 'Working on simple qa', detail: '', importance: 6 },
  ],
  graph: { nodeCount: 4, edgeCount: 3 },
  reflections: [{ ts: now - day, turnCount: 40, learned: [{ key: 'knowledge:domain:alpha', value: 1, confidence: 0.5 }], weakened: [], promoted: [], archived: [], goalsStaled: [], episodesClosed: 0, graphPruned: 0, expired: [] }],
  lastReflectionAt: now - day,
};

const GRAPH = {
  success: true,
  nodes: [
    { id: 's', key: 'person:__self__', type: 'person', label: 'You', weight: 3 },
    { id: 'p', key: 'project:tidepool', type: 'project', label: 'Tidepool', weight: 3 },
    { id: 'g', key: 'goal:beta', type: 'goal', label: 'Ship the public beta', weight: 2 },
    { id: 't', key: 'tech:react', type: 'technology', label: 'React', weight: 2 },
    { id: 'f', key: 'artifact:x', type: 'artifact', label: 'IMG-20260817-WA0001-a-very-long-uploaded-file-name.jpg', weight: 1 },
  ],
  edges: [
    { key: 'e1', from: 's', to: 'p', type: 'works_on', weight: 1 },
    { key: 'e2', from: 'p', to: 'g', type: 'has_goal', weight: 1 },
    { key: 'e3', from: 'p', to: 't', type: 'uses', weight: 1 },
  ],
};

const UNDERSTANDING = {
  success: true, score: 53, confidence: 'fairly sure', isNew: false, sections: [], updatedAt: now,
  projects: [{ id: 'p', label: 'Tidepool', ref: 'graph:p' }],
  goals: [], unknowns: [{ id: 'u1', dimension: 'preferences', prompt: 'How you like to plan your week', weight: 1 }],
  sources: [{ kind: 'conversation', label: 'From your conversations', count: 31 }, { kind: 'document', label: 'From files you uploaded', count: 2 }],
};

const MEMORY = {
  success: true, ownerId: 'user:demo', factCount: 4,
  facts: [
    { key: 'city', label: 'City', value: 'Pune', category: 'location', createdAt: now - 3 * day, sourceMessage: 'I moved to Pune last year.' },
    { key: 'goal', label: 'Goals', value: ['ship the beta', 'hire a designer'], items: ['Ship the beta', 'Hire a designer'], category: 'goals', createdAt: now - 2 * day },
    { key: 'custom_favourite_trail', label: null, value: `The coastal trail — notes at ${LONG_URL}`, category: 'custom', createdAt: now - day },
  ],
  hiddenSensitive: [{ key: 'custom_right_eye', value: 'moving automatically', items: ['Moving automatically'], sensitivity: 'health' }],
};
const CLAIMS = {
  success: true, configured: true, hiddenSensitive: [],
  claims: [
    { claimId: 'c1', statement: 'You are building Tidepool, an offline-first field notes app', quote: 'I am building Tidepool, an offline-first notes app for field researchers.', sourceKind: 'conversation', sourceName: null, assertedAt: new Date(now - 2 * day).toISOString(), disputed: false, scheduledFrom: null },
    { claimId: 'c2', statement: `Your design doc lives at ${LONG_URL}`, quote: null, sourceKind: 'document', sourceName: 'tidepool-design-final-v7-really-long-file-name.pdf', assertedAt: new Date(now - day).toISOString(), disputed: true, scheduledFrom: null },
  ],
};
const TIMELINE = {
  success: true, ownerId: 'user:demo', days: 30,
  changes: [
    { at: now - day, kind: 'event', label: 'event' },
    { at: now - day, kind: 'goal_created', label: 'Started working toward ship the beta' },
    { at: now - 2 * day, kind: 'fact_new', label: 'custom_networth = "almost zero"' },
  ],
};

const CONVERSATION = {
  success: true, id: 'demo1', meta: { title: 'Planning the Tidepool beta launch and the sync architecture decision' }, messageCount: 2,
  messages: [
    { role: 'user', content: `Compare sync options for Tidepool. Reference: ${LONG_URL}`, ts: now - 60_000 },
    { role: 'assistant', ts: now - 50_000,
      // A stored answer's context, resolved now (GET /conversations/:id, 2026-10-29).
      contextUsed: { items: [
        { kind: 'claim', id: '0b7f8a8e-3c1d-4e2a-9f10-1a2b3c4d5e6f', text: 'Tidepool syncs field notes offline with last-write-wins', disputed: false, changed: true },
        { kind: 'fact', key: 'city', label: 'City', text: 'Pune', changed: false },
      ], removed: 1, unavailable: 0 },
      content: [
      'Here is a comparison:',
      '',
      '| Approach | Offline writes | Conflict handling | Effort |',
      '|---|---|---|---|',
      '| Last-write-wins | Yes | Loses concurrent edits silently | Low |',
      '| CRDT (Yjs / Automerge) | Yes | Merges automatically, preserves intent | Medium |',
      '| Server-authoritative queue | Partial | Rejects stale writes, asks the user | Medium |',
      '',
      'The merge cost grows as $O(n \\log n)$ in the number of operations, and the expected divergence is',
      '',
      '$$E[d] = \\int_0^T \\lambda(t)\\,dt$$',
      '',
      '```ts',
      'export function mergeNotes(local: Note[], remote: Note[]): Note[] { return crdt.merge(local, remote).filter((n) => !n.deleted && n.updatedAt > lastSyncedAt); }',
      '```',
    ].join('\n') },
  ],
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function mockApi(page: Page) {
  // Path must START with /api/ — vite serves the app's own modules from
  // /aqua/src/api/*.ts, which a looser match would answer with JSON.
  await page.route((u) => u.pathname.startsWith('/api/'), (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname.replace(/^\/api(?:\/aqua)?/, '');
    const method = route.request().method();
    if (p === '/account') return json(route, { success: true, account: { email: 'demo@example.com', authMethod: 'password', reauthFresh: false } });
    if (p === '/account/privacy') return json(route, { success: true, rememberSensitive: false });
    if (p === '/billing/wallet') return json(route, { success: true, wallet: { total: 120, isUnlimited: false } });
    if (p === '/conversations') return json(route, { success: true, total: 2, count: 2, conversations: [
      { id: 'demo1', title: CONVERSATION.meta.title, pinned: false, archived: false, updatedAt: now - 50_000, messageCount: 2, meta: {} },
      { id: 'demo2', title: 'Hiring plan', pinned: false, archived: false, updatedAt: now - 2 * day, messageCount: 4, meta: {} },
    ] });
    if (p.startsWith('/conversations/')) return json(route, CONVERSATION);
    if (p === '/brain/welcome') return json(route, { success: true, welcome: { text: 'Last time you were weighing CRDTs for Tidepool sync.', kind: 'resume', basis: 'world_model', established: true, evidence: [], worldVersion: '1', messageId: 'w1', threads: [
      { id: 't1', kind: 'deadline_approaching', text: "The Tidepool public beta is due in 5 days — let's make sure it's on track.", prompt: 'About the Tidepool public beta: ', evidence: [{ source: 'claim', id: 'c1' }] },
      { id: 't2', kind: 'open_decision', text: `You haven't settled on the sync engine yet — want to think it through? See ${LONG_URL}`, prompt: 'About the sync engine: ', evidence: [{ source: 'claim', id: 'c2' }] },
      { id: 't3', kind: 'goal', text: "Let's keep working toward hiring a designer.", prompt: 'About hire a designer: ', evidence: [{ source: 'claim', id: 'c3' }] },
    ] } });
    if (p === '/understanding/intro/state') return json(route, { success: true, ownerId: 'user:demo', hasIntro: true, score: 53, shouldOffer: false });
    if (p === '/understanding') return json(route, UNDERSTANDING);
    if (p === '/brain/changes') return json(route, { success: true, changes: [{ at: now - day, summary: 'Moved Tidepool sync from last-write-wins to CRDTs', entities: 1, relationships: 0, obsoleted: 1, revised: 1, applied: true }] });
    if (p === '/brain/current') return json(route, CLAIMS);
    if (p === '/mind') return json(route, MIND);
    if (p === '/mind/graph') return json(route, GRAPH);
    if (p === '/mind/review') return json(route, { success: true, candidates: [
      { id: 'goal:g9', kind: 'merged_goal', goalId: 'g9', title: 'become a billionaire and build a company people love', parts: ['become a billionaire', 'build a company people love'] },
      { id: 'fact:profession', kind: 'fact_fails_schema', key: 'profession', label: 'Profession', value: 'Billionaire', aspiration: true, learnedFrom: `I want to be a billionaire — notes at ${LONG_URL}` },
    ] });
    if (p === '/memory') return json(route, MEMORY);
    if (p === '/memory/timeline') return json(route, TIMELINE);
    if (p === '/chat/stream' && method === 'POST') {
      // The pre-fix server's failure: its router log line as the error.
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body:
        'event: meta\ndata: {"conversationId":"demo3","requestId":"r1"}\n\n' +
        'event: error\ndata: {"error":"All providers exhausted | task=simple_qa | chain=groq:failed(auth) → gemini:failed(config)","recoverable":true,"fallbackChain":[{"provider":"groq","outcome":"failed"}]}\n\n' });
    }
    if (/^\/(artifacts|project\/workspaces?)/.test(p)) return json(route, { success: true, count: 0, artifacts: [], workspaces: [] });
    return json(route, { success: true });
  });
}

const LEAKS: [RegExp, string][] = [
  [/\bcustom_/i, 'custom_ key'],
  [/\b(?:simple[_\s]qa|personal[_\s]info|memory[_\s]recall)\b/i, 'intent id'],
  [/collection_merge/i, 'internal operation'],
  [/^\s*event\s*$/im, 'bare "event"'],
  [/Domain:/, '"Domain:" prefix'],
  [/exhausted|task=|chain=|\bgroq\b|\bgemini\b/i, 'router internals'],
  [/\d+\s*%/, 'percentage'],
  [/priority 5\b/, 'default priority'],
  [/What Aqua expects next/, 'forecast section'],
  [/moving automatically/i, 'sensitive detail outside the collapsed section'],
];

async function audit(page: Page, name: string, testInfo: { project: { name: string } }) {
  await page.waitForTimeout(1200); // entrance animations settle
  const vw = page.viewportSize()?.width ?? 0;
  const result = await page.evaluate((viewportWidth) => {
    const sideways = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    // Anything laid out past the right edge, outside a scroller meant to scroll
    // sideways (tables, code, the heatmap) or an off-canvas drawer.
    const offenders: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.right <= viewportWidth + 1) continue;
      if (el.closest('.overflow-x-auto, .md-table-wrap, pre, [data-scroll-x], [aria-hidden="true"], [role="dialog"]:not([open])')) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      let hiddenByClip = false;
      for (let a = el.parentElement; a; a = a.parentElement) {
        const ar = a.getBoundingClientRect();
        const cs = getComputedStyle(a);
        if ((cs.overflowX === 'hidden' || cs.overflowX === 'clip') && ar.right <= viewportWidth + 1) { hiddenByClip = r.left >= ar.right - 1 || true; break; }
        if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') { hiddenByClip = true; break; }
      }
      if (hiddenByClip) continue;
      offenders.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 80)} right=${Math.round(r.right)}`);
    }
    return { sideways, offenders: offenders.slice(0, 10), text: document.body.innerText };
  }, vw);
  if (SHOTS) {
    // The app scrolls inside <main>, not the document, so fullPage alone stops
    // at the viewport: grow the viewport to the content for the capture.
    const size = page.viewportSize()!;
    const contentHeight = await page.evaluate(() => Math.max(
      ...Array.from(document.querySelectorAll<HTMLElement>('#aqua-main, #aqua-main *'))
        .filter((el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY))
        .map((el) => el.scrollHeight + el.getBoundingClientRect().top),
      window.innerHeight,
    ));
    await page.setViewportSize({ width: size.width, height: Math.min(Math.ceil(contentHeight), 9000) });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/${name}-${testInfo.project.name}.png` });
    await page.setViewportSize(size);
  }
  expect(result.sideways, `${name}: the page scrolls sideways`).toBeLessThanOrEqual(1);
  expect(result.offenders, `${name}: laid out past the right edge`).toEqual([]);
  const found = LEAKS.filter(([re]) => re.test(result.text)).map(([, why]) => why);
  expect(found, `${name}: leaks on screen`).toEqual([]);
}

// The first visit to a cold vite dev server pre-bundles dependencies.
test.setTimeout(120_000);

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  await mockApi(page);
});

test('chat: a conversation with a table, maths, code and a long URL', async ({ page }, info) => {
  await page.goto('./c/demo1');
  await expect(page.getByText('Here is a comparison:')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.katex').first()).toBeVisible();
  await audit(page, 'chat-conversation', info);
});

test('chat: a failed answer shows a sentence, not the router chain', async ({ page }, info) => {
  await page.goto('./');
  const composer = page.getByLabel('Message AQUA');
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer.fill('What should I build next?');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible({ timeout: 15_000 });
  await audit(page, 'chat-error', info);
});

test('memory page', async ({ page }, info) => {
  await page.goto('./memory');
  await expect(page.getByText('What AQUA remembers')).toBeVisible({ timeout: 30_000 });
  await audit(page, 'memory', info);
});

test('understanding page', async ({ page }, info) => {
  await page.goto('./mind');
  await expect(page.getByText('A living model of you')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Tidepool').first()).toBeVisible();
  await audit(page, 'understanding', info);
});

test('understanding page: the belief drawer', async ({ page }, info) => {
  await page.route((u) => u.pathname.startsWith('/api/aqua/mind/beliefs/'), (route) => json(route, { success: true, explanation: {
    dimension: 'identity', key: 'profession', value: 'Product engineer', confidence: 0.9, evidenceCount: 3, contradictions: 0,
    explanation: 'You said this. Seen across 2 conversations.', recentEvidence: [{ ts: now - day, conversationId: 'c1', signal: 'You said this', delta: 0, support: true }],
  } }));
  await page.goto('./mind');
  await page.getByRole('button', { name: /Profession/ }).click();
  await expect(page.getByRole('dialog', { name: /Why Aqua believes/ })).toBeVisible();
  await expect(page.getByText('You said this. Seen across 2 conversations.')).toBeVisible();
  await audit(page, 'understanding-drawer', info);
});

test('home: grounded threads to pick up, dismissible, composer pre-filled not sent', async ({ page }, info) => {
  await page.goto('./');
  await expect(page.getByText('On your plate')).toBeVisible({ timeout: 30_000 });
  await audit(page, 'home', info);
  await page.getByText("Let's keep working toward hiring a designer.").click();
  await expect(page.getByLabel('Message AQUA')).toHaveValue('About hire a designer: ');
  await page.getByRole('button', { name: /Don't suggest this: The Tidepool/ }).click();
  await expect(page.getByText(/Tidepool public beta is due/)).toHaveCount(0);
});

test('chat: an answer shows the context it used, collapsed until asked', async ({ page }, info) => {
  const done = {
    success: true, conversationId: 'demo4', requestId: 'r2', answer: 'Given the beta date, ship CRDT sync after launch and keep last-write-wins for now.',
    truncated: false, finishReason: 'stop', memory: { extracted: 0, injected: 1, facts: [] },
    contextUsed: { items: [
      { kind: 'claim', id: '0b7f8a8e-3c1d-4e2a-9f10-1a2b3c4d5e6f', text: 'We launch the Tidepool beta on November 12.', disputed: false },
      { kind: 'fact', key: 'custom_trail', label: null, text: `The coastal trail — notes at ${LONG_URL}` },
      { kind: 'fact', key: 'city', label: 'City', text: 'Pune' },
    ] },
  };
  await page.route((u) => u.pathname.endsWith('/chat/stream'), (route) => route.fulfill({ status: 200, contentType: 'text/event-stream', body:
    'event: meta\ndata: {"conversationId":"demo4","requestId":"r2"}\n\n' +
    `event: token\ndata: ${JSON.stringify({ t: done.answer })}\n\n` +
    `event: done\ndata: ${JSON.stringify(done)}\n\n` }));
  await page.goto('./');
  const composer = page.getByLabel('Message AQUA');
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer.fill('Should we switch sync engines before the beta?');
  await page.getByRole('button', { name: 'Send message' }).click();
  const toggle = page.getByRole('button', { name: /Context used · 3/ });
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('We launch the Tidepool beta on November 12.')).toHaveCount(0);
  await toggle.click();
  await expect(page.getByText('We launch the Tidepool beta on November 12.')).toBeVisible();
  await audit(page, 'chat-context-used', info);
});

test('memory page: legacy records offered for review, nothing changed until chosen', async ({ page }, info) => {
  await page.goto('./memory');
  await expect(page.getByText('Worth a second look')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Split into 2' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove it' })).toBeVisible();
  await audit(page, 'memory-review', info);
});

test('chat: a reopened answer shows what it used, marks what changed, counts what was removed', async ({ page }, info) => {
  await page.goto('./c/demo1');
  const toggle = page.getByRole('button', { name: /Context used · 3/ });
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  await toggle.click();
  await expect(page.getByText('(since changed)')).toBeVisible();
  await expect(page.getByText(/1 more was used, and has since been removed/)).toBeVisible();
  await audit(page, 'chat-reopened-context', info);
});

// Dark theme (2026-10-29): the app follows the system scheme; never inspected before.
for (const [name, path, ready] of [
  ['dark-home', './', 'On your plate'],
  ['dark-memory', './memory', 'Worth a second look'],
  ['dark-understanding', './mind', 'A living model of you'],
] as const) {
  test(`dark theme: ${name}`, async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(path);
    await expect(page.getByText(ready)).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true);
    await audit(page, name, info);
  });
}
