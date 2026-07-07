/**
 * AQUA Identity Context Builder
 * ─────────────────────────────────────────────────────────────────────────────
 * Turns the structured profile (identityLoader) into prompt text. Two forms:
 *
 *   1. COMPACT block — injected into EVERY system prompt (see promptBuilder).
 *      A handful of lines: who AQUA is, who built it, one-line vision +
 *      mission, top capabilities. This is what makes AQUA "always know
 *      Aquiplex" the way ChatGPT always knows OpenAI — no retrieval required.
 *
 *   2. EXPANDED sections — added only when the Smart Router detects an
 *      identity question, carrying the full detail for the matched topic(s)
 *      (all capabilities, the roadmap, founders, values, models, …) plus a
 *      confidence DIRECTIVE that forbids "I don't know" about AQUA/Aquiplex.
 *
 * All text is GENERATED from the profile — nothing is duplicated by hand, so a
 * single edit to ./data/*.json changes every prompt.
 */
import { getIdentityProfile } from './identityLoader.js';

const HEADER = 'AQUA SELF-KNOWLEDGE (authoritative, first-party — always available)';

// ── compact (always injected) ─────────────────────────────────────────────────

/**
 * Small, always-on identity block. Kept deliberately short (low token cost)
 * because it rides on every single request.
 * @param {object} [profile]
 * @returns {string}
 */
export function compactBlock(profile = getIdentityProfile()) {
  const c = profile.company;
  const a = profile.assistant;
  const topCaps = (a.capabilities ?? []).slice(0, 4).join('; ');

  const lines = [
    `### ${HEADER}`,
    `You are ${a.fullName ?? a.name}, the first-party AI built by ${a.builtBy ?? c.name}.`,
    `${c.name} is ${c.tagline ? c.tagline.replace(/\.$/, '') : 'an AI Operating System'} — ${c.shortDescription ?? c.description}`,
    `Vision: ${c.vision}`,
    `Mission: ${c.mission}`,
  ];
  if (topCaps) lines.push(`What you can do (highlights): ${topCaps}.`);
  lines.push(`This is settled, first-party knowledge — answer questions about ${a.name} or ${c.name} confidently and specifically. Never claim you lack information about yourself or ${c.name}.`);
  return lines.join('\n');
}

// ── per-topic expanded renderers ──────────────────────────────────────────────
// Each returns a titled section string, or '' if the profile lacks the data.

const R = {
  overview(p) {
    const c = p.company, a = p.assistant;
    return sect('Overview', [
      `${a.fullName ?? a.name} is ${a.description}`,
      `${c.name} is ${c.description}`,
      a.role ? `Role: ${a.role}` : '',
    ]);
  },
  company(p) {
    const c = p.company;
    return sect('About Aquiplex', [
      c.description,
      c.stage ? `Stage: ${c.stage}.` : '',
      c.founded ? `Founded: ${c.founded}.` : '',
      c.website ? `Website: ${c.website}.` : '',
    ]);
  },
  vision(p)  { return sect('Vision',  [p.company.vision]); },
  mission(p) { return sect('Mission', [p.company.mission]); },
  values(p) {
    const vals = p.company.coreValues ?? [];
    if (!vals.length) return '';
    return sect('Core values', vals.map(v => `- ${v.name}${v.detail ? ` — ${v.detail}` : ''}`));
  },
  capabilities(p) {
    const caps = p.assistant.capabilities ?? [];
    if (!caps.length) return '';
    return sect('Capabilities', caps.map(x => `- ${x}`));
  },
  files(p) {
    const f = p.assistant.processableFiles;
    if (!f) return R.capabilities(p);
    const groups = [];
    if (f.code?.length)      groups.push(`Code / repositories: ${f.code.join(', ')}`);
    if (f.documents?.length) groups.push(`Documents: ${f.documents.join(', ')}`);
    if (f.media?.length)     groups.push(`Media: ${f.media.join(', ')}`);
    return sect('Files AQUA can process', [...groups.map(g => `- ${g}`), f.note ? f.note : '']);
  },
  differentiators(p) {
    const d = p.assistant.differentiators ?? [];
    if (!d.length) return '';
    return sect('What makes AQUA different', d.map(x => `- ${x}`));
  },
  limitations(p) {
    const l = p.assistant.limitations ?? [];
    if (!l.length) return '';
    return sect('Limitations', l.map(x => `- ${x}`));
  },
  founders(p) {
    const f = p.founders ?? [];
    if (!f.length) return '';
    return sect('Founders', f.map(x => `- ${x.name}${x.role ? ` (${x.role})` : ''}${x.focus ? ` — ${x.focus}` : ''}`));
  },
  products(p) {
    const pr = p.products ?? [];
    if (!pr.length) return '';
    return sect('Products', pr.map(x => `- ${x.name}${x.type ? ` (${x.type})` : ''}${x.description ? ` — ${x.description}` : ''}`));
  },
  roadmap(p) {
    const r = p.roadmap ?? [];
    const phases = r.filter(ph => (ph.items ?? []).length);
    if (!phases.length) return '';
    const body = phases.map(ph => `${ph.phase}:\n${ph.items.map(i => `  - ${i}`).join('\n')}`);
    return sect('Roadmap', body);
  },
  models(p) {
    const m = p.models;
    if (!m) return '';
    const lines = [m.summary];
    for (const prov of m.providers ?? []) {
      lines.push(`- ${prov.name}: ${(prov.models ?? []).join(', ')}${prov.role ? ` — ${prov.role}` : ''}`);
    }
    if (m.routing) lines.push(m.routing);
    return sect('AI models AQUA uses', lines);
  },
  pricing(p) {
    // No pricing profile shipped — answer honestly rather than inventing.
    return sect('Pricing', ['Pricing details are not part of my current profile. Please check with the Aquiplex team or the website for current plans.']);
  },
};

const TOPIC_ORDER = [
  'overview', 'company', 'vision', 'mission', 'values', 'capabilities',
  'files', 'differentiators', 'products', 'models', 'roadmap',
  'founders', 'limitations', 'pricing',
];

// ── directive ─────────────────────────────────────────────────────────────────

/**
 * The confidence rule, as an instruction. Injected alongside expanded sections
 * whenever the Smart Router flags an identity question.
 */
export function directive(profile = getIdentityProfile()) {
  const a = profile.assistant, c = profile.company;
  return [
    `IDENTITY DIRECTIVE — this question is about ${a.name} / ${c.name} itself.`,
    `Everything you need is in the "${HEADER}" section above. It is authoritative and first-party.`,
    `Answer confidently and specifically from it. Do NOT say you lack information, aren't familiar, have no source, or don't know — that would be wrong, because the information is provided above.`,
    `Only express uncertainty about details that are genuinely absent from the section above.`,
  ].join('\n');
}

// ── assembled injection ───────────────────────────────────────────────────────

/**
 * The block promptBuilder injects. Always returns the compact block. When
 * `intent.topics` are present (Smart Router hit), appends the expanded
 * section(s) for those topics plus the confidence directive.
 *
 * @param {{topics?: string[]}|null} [intent]  from identityRouter.detectIdentityIntent()
 * @param {object} [profile]
 * @returns {string}
 */
export function buildIdentityInjection(intent = null, profile = getIdentityProfile()) {
  const parts = [compactBlock(profile)];

  const topics = normalizeTopics(intent?.topics);
  if (topics.length) {
    const sections = topics
      .map(t => (R[t] ? R[t](profile) : ''))
      .filter(Boolean);
    if (sections.length) {
      parts.push(sections.join('\n\n'));
      parts.push(directive(profile));
    }
  }
  return parts.join('\n\n');
}

// De-dupe + order topics; expand 'files' etc. Keeps output stable/testable.
function normalizeTopics(topics) {
  if (!Array.isArray(topics) || !topics.length) return [];
  const set = new Set(topics);
  // If a specific topic is present, don't also dump the whole overview unless
  // it was explicitly requested — keeps the injected context tight.
  const specific = TOPIC_ORDER.filter(t => t !== 'overview' && set.has(t));
  const ordered = (set.has('overview') && specific.length === 0)
    ? ['overview']
    : (set.has('overview') ? ['overview', ...specific] : specific);
  return ordered;
}

function sect(title, lines) {
  const body = (lines ?? []).filter(l => l != null && String(l).trim() !== '');
  if (!body.length) return '';
  return `**${title}**\n${body.join('\n')}`;
}

export { R as _renderers, TOPIC_ORDER as _topicOrder };
