/**
 * AQUA Brain — Timeline V2: Federated View (Brain V1 / B7)
 *
 * "Every event should connect to: projects, people, goals, documents,
 *  conversations." — the brief's second requirement for this phase.
 *
 * Today an event knows its `entities` (raw name strings) and its
 * `sourceFiles`. What it cannot tell you is whether those entities are people
 * or projects, which goal the event advances, or which conversation it came
 * from. That is exactly the information the earlier increments made available:
 *
 *   B2 gave semantic entity types    (mind's `person`/`project`/`organization`
 *                                     federated onto file-resolved entities)
 *   B3 gave conversation source nodes (a turn is an addressable source)
 *   the Mind gave goals              (active/blocked, with titles)
 *
 * So this module does the linking rather than re-extracting anything: it takes
 * events from every source, resolves each event's entities through the world
 * model, and attaches the typed links the brief asks for.
 *
 * Impure only at the store boundary (reads graph, mind, evidence through
 * injected deps). Chain detection is delegated to the pure chainBuilder.
 */
import { buildChains } from './chainBuilder.js';
import { buildWorldIndex, projectEntity } from '../worldModel/projection.js';

/** Mind node types that count as each link category. */
const PERSON_TYPES  = new Set(['person']);
const PROJECT_TYPES = new Set(['project', 'organization', 'artifact']);

/**
 * A sortable time from an event node.
 *
 * graphBuilder persists only the DISPLAY timestamp on event nodes
 * (`data.timestamp` — an ISO date slice for dated documents, or a media
 * offset like "00:12:34"), not the numeric seconds the extractor computed. So
 * derive it rather than reading a field that is never written: without this
 * every graph event sorts as undated, and every chain gets penalised for
 * anchoring it actually has.
 *
 * Returns null rather than a guess when the display form is not a date — an
 * unparseable timestamp is an undated event, not a fabricated position.
 */
function secondsFromNode(data = {}) {
  if (typeof data.timestampSeconds === 'number') return data.timestampSeconds;
  const raw = data.timestamp;
  if (raw == null) return null;
  if (typeof raw === 'number') return raw;
  const iso = String(raw).match(/^\d{4}-\d{2}-\d{2}$/);
  if (iso) {
    const t = Date.parse(`${raw}T00:00:00Z`);
    return Number.isNaN(t) ? null : Math.floor(t / 1000);
  }
  // Media offsets ("00:12:34") are positions within a file, not points in
  // history — they must not sort against calendar dates.
  return null;
}

/**
 * Gather events from every source into one shape the chain builder and the
 * view can both consume.
 *
 * Three sources, kept distinguishable by `origin`:
 *   reasoning     event nodes in the graph (extracted from file facts)
 *   mind          the Mind's own timeline (goals created/completed, episodes)
 *   conversation  events whose provenance is a conversation turn (B3)
 *
 * @param {object} deps - { graph, peekMind }
 * @returns {Array} normalized events
 */
export function gatherEvents(deps, ownerId, { limit = 500 } = {}) {
  const { graph: G, peekMind } = deps;
  const out = [];

  // 1. Reasoning-graph event nodes.
  for (const node of G.nodesByType(ownerId, 'event')) {
    // The entities an event involves come from its `involves` edges — the
    // graph already models this, so we read it rather than re-parsing text.
    const involved = G.neighbors(ownerId, node.id, { type: 'entity', edgeType: 'involves' });
    const fromConversation = (node.sourceFiles ?? []).some(f => String(f).startsWith('conv:'));
    out.push({
      id: node.id,
      type: node.data?.eventType ?? null,
      statement: node.label,
      entities: involved.map(({ node: n }) => n.label),
      entityIds: involved.map(({ node: n }) => n.id),
      timestamp: node.data?.timestamp ?? null,
      timestampSeconds: secondsFromNode(node.data),
      certainty: node.data?.certainty ?? 'unknown',
      sourceFiles: node.sourceFiles ?? [],
      origin: fromConversation ? 'conversation' : 'reasoning',
    });
  }

  // 2. The Mind's own timeline.
  const mind = peekMind?.(ownerId) ?? null;
  for (const ev of mind?.timeline ?? []) {
    out.push({
      id: ev.id,
      kind: ev.kind,
      statement: ev.detail ? `${ev.kind}: ${ev.subject} — ${ev.detail}` : `${ev.kind}: ${ev.subject}`,
      subject: ev.subject,
      entities: ev.subject ? [ev.subject] : [],
      entityIds: [],
      ts: ev.ts ?? null,
      timestampSeconds: ev.ts != null ? Math.floor(ev.ts / 1000) : null,
      certainty: 'exact',      // the Mind stamps its own events as they happen
      importance: ev.importance ?? 5,
      sourceFiles: [],
      origin: 'mind',
    });
  }

  return out.slice(0, limit);
}

/**
 * Attach the five link categories the brief names to one event.
 *
 * People and projects come from the FEDERATED entity type (B2) — which is the
 * whole reason the federation was worth building: the file side types every
 * proper noun as `name`, so without B2 there would be no way to say which of
 * an event's entities is a person and which is a project.
 */
function linkEvent(deps, ownerId, event, index, goals) {
  const people = [];
  const projects = [];
  const documents = [...new Set((event.sourceFiles ?? []).filter(f => !String(f).startsWith('conv:')))];
  const conversations = [...new Set(
    (event.sourceFiles ?? [])
      .filter(f => String(f).startsWith('conv:'))
      // `conv:<id>:<turn>` → the conversation, not the individual turn.
      .map(f => String(f).split(':').slice(0, 2).join(':')),
  )];

  for (const id of event.entityIds ?? []) {
    const entity = projectEntity(deps, ownerId, id, index);
    if (!entity) continue;
    const ref = { id: entity.id, title: entity.title, type: entity.type };
    if (PERSON_TYPES.has(entity.type)) people.push(ref);
    else if (PROJECT_TYPES.has(entity.type)) projects.push(ref);
  }

  // Goals: an event advances a goal when it names it. Matching on the goal
  // TITLE's words rather than an id, because goals are inferred from prose and
  // have no formal link to graph entities.
  const text = String(event.statement ?? '').toLowerCase();
  const linkedGoals = goals
    .filter(g => {
      const title = String(g.title ?? '').toLowerCase();
      if (title.length < 4) return false;
      return text.includes(title) || (event.subject && String(event.subject).toLowerCase().includes(title));
    })
    .map(g => ({ title: g.title, status: g.status }));

  return { people, projects, goals: linkedGoals, documents, conversations };
}

/** Active + blocked goals from the Mind, defensively. */
function goalsOf(mind) {
  if (!mind?.goals) return [];
  try {
    return Object.values(mind.goals).filter(g => g?.title).slice(0, 40);
  } catch { return []; }
}

/**
 * The unified timeline: every event from every source, ordered, each carrying
 * its typed links, plus the lifecycle chains detected across them.
 *
 * @param {object} deps - { graph, peekMind, evidenceStore, annotations }
 * @param {object} [opts] - { limit, minStages, subject }
 * @returns {{ events, chains, stats }}
 */
export function buildUnifiedTimeline(deps, ownerId, { limit = 200, minStages = 2, subject = null } = {}) {
  const events = gatherEvents(deps, ownerId, { limit: limit * 2 });
  if (!events.length) return { events: [], chains: [], stats: emptyStats() };

  const index = buildWorldIndex(deps, ownerId);
  const goals = goalsOf(deps.peekMind?.(ownerId) ?? null);

  const linked = events.map(e => ({ ...e, links: linkEvent(deps, ownerId, e, index, goals) }));

  // Chains are built from the linked events so a chain's stages carry links too.
  const chains = buildChains(linked, { minStages });

  const filtered = subject
    ? linked.filter(e => (e.entities ?? []).some(x => String(x).toLowerCase().includes(String(subject).toLowerCase()))
        || String(e.subject ?? '').toLowerCase().includes(String(subject).toLowerCase()))
    : linked;

  // Dated first (ascending), undated after — never given a fabricated position.
  const ordered = [...filtered].sort((a, b) => {
    const ta = a.timestampSeconds ?? null;
    const tb = b.timestampSeconds ?? null;
    if (ta == null && tb == null) return 0;
    if (ta == null) return 1;
    if (tb == null) return -1;
    return ta - tb;
  }).slice(0, limit);

  return {
    events: ordered,
    chains: subject ? chains.filter(c => c.subject.includes(String(subject).toLowerCase())) : chains,
    stats: {
      events: ordered.length,
      byOrigin: tally(ordered.map(e => e.origin)),
      anchored: ordered.filter(e => e.timestampSeconds != null).length,
      unanchored: ordered.filter(e => e.timestampSeconds == null).length,
      chains: chains.length,
      linkedToProjects: ordered.filter(e => e.links.projects.length).length,
      linkedToPeople: ordered.filter(e => e.links.people.length).length,
      linkedToGoals: ordered.filter(e => e.links.goals.length).length,
      linkedToConversations: ordered.filter(e => e.links.conversations.length).length,
    },
  };
}

function tally(arr) {
  const out = {};
  for (const x of arr) out[x] = (out[x] ?? 0) + 1;
  return out;
}

function emptyStats() {
  return { events: 0, byOrigin: {}, anchored: 0, unanchored: 0, chains: 0,
    linkedToProjects: 0, linkedToPeople: 0, linkedToGoals: 0, linkedToConversations: 0 };
}
