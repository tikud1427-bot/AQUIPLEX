/**
 * PWI benchmark — ground truth by construction (2026-11-15).
 *
 * The dataset is an event script. Each event says what the user said (or did)
 * and its EFFECTS on the user's world, written by the dataset author before any
 * run. Replaying the effects up to a stage gives the truth at that stage. No
 * label is derived from Aqua's output.
 *
 * Slot state (per persona, per slot):
 *   current    values true now
 *   past       values that WERE true (the world changed: set over a value, end, remove)
 *   wrong      values the user corrected (they were never true)
 *   deleted    values the user asked to forget (must not appear anywhere derived)
 *   hedged     values said only tentatively (must not become a fact)
 *   sensitive  values in a sensitive category without opt-in (must not be kept)
 * Each value: { value, match: [surface forms], source: 'chat'|'document', stage }.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
// (norm is defined below; function declarations are hoisted.)

export const STAGES = ['A', 'B', 'C'];
const order = s => STAGES.indexOf(s);

export function loadDataset(file) {
  const raw = fs.readFileSync(file);
  return { dataset: JSON.parse(raw.toString('utf8')), sha256: crypto.createHash('sha256').update(raw).digest('hex') };
}

const val = (e, stage) => ({ value: e.value, match: e.match ?? [e.value], source: e.source ?? 'chat', stage });

/** Truth for one persona after every event of `stage` and earlier. */
export function truthAt(persona, stage) {
  const slots = {};
  for (const name of Object.keys(persona.slots)) slots[name] = { current: [], past: [], wrong: [], deleted: [], hedged: [], sensitive: [] };
  const extraDeleted = [];
  for (const ev of persona.events) {
    if (order(ev.stage) > order(stage)) continue;
    for (const fx of ev.effects ?? []) {
      const s = slots[fx.slot];
      if (!s) throw new Error(`${persona.id}: unknown slot ${fx.slot}`);
      switch (fx.op) {
        case 'set': s.past.push(...s.current); s.current = [val(fx, ev.stage)]; break;
        case 'add': s.current.push(val(fx, ev.stage)); break;
        case 'remove': {
          const i = s.current.findIndex(v => v.value === fx.value);
          if (i < 0) throw new Error(`${persona.id}: remove of absent ${fx.slot}=${fx.value}`);
          s.past.push(...s.current.splice(i, 1)); break;
        }
        case 'end': s.past.push(...s.current); s.current = []; break;
        case 'correct': s.wrong.push(...s.current); s.current = [val(fx, ev.stage)]; break;
        case 'delete':
          s.deleted.push(...s.current, ...s.past, ...s.wrong); s.current = []; s.past = []; s.wrong = [];
          for (const x of fx.extra ?? []) extraDeleted.push({ value: x, match: [x], source: 'chat', stage: ev.stage });
          break;
        case 'hedge': s.hedged.push(val(fx, ev.stage)); break;
        case 'sensitive': s.sensitive.push(val(fx, ev.stage)); break;
        default: throw new Error(`${persona.id}: unknown op ${fx.op}`);
      }
    }
  }
  const live = x => order(x.introduced) <= order(stage) && !(x.deleted && order(x.deleted) <= order(stage));
  const entities = persona.entities.filter(live);
  const deletedEntities = persona.entities.filter(x => x.deleted && order(x.deleted) <= order(stage));
  const relations = persona.relations.filter(r => live(r) && !(r.ended && order(r.ended) <= order(stage)));
  const endedRelations = persona.relations.filter(r => live(r) && r.ended && order(r.ended) <= order(stage));
  const deletedRelations = persona.relations.filter(r => r.deleted && order(r.deleted) <= order(stage));
  return { stage, slots, extraDeleted, entities, deletedEntities, relations, endedRelations, deletedRelations };
}

/** Everything this persona asked to forget, by `stage`: slot values + extra strings + deleted entities. */
export function deletedValues(truth) {
  const all = [
    ...Object.values(truth.slots).flatMap(s => s.deleted),
    ...truth.extraDeleted,
    ...truth.deletedEntities.map(e => ({ value: e.name, match: e.match, source: 'chat', stage: e.deleted })),
  ];
  // One check per forgotten thing: a deleted slot value and the same deleted entity are one item.
  const seen = new Set();
  return all.filter(v => { const k = norm(v.match[0]); if (seen.has(k)) return false; seen.add(k); return true; });
}

/** A probe at a stage → what the context must contain, must not contain, and may not need. */
export function resolveProbe(persona, probe, truth) {
  const required = [];
  const staleChecks = [];   // values that must not appear UNMARKED (past / wrong / hedged of the probed slots)
  for (const ref of probe.requires) {
    const [slot, mod] = ref.split('@');
    const s = truth.slots[slot];
    if (!s) throw new Error(`${probe.id}: unknown slot ${slot}`);
    if (mod === 'past') { for (const v of s.past) required.push({ slot, kind: 'past', ...v }); continue; }
    for (const v of s.current) required.push({ slot, kind: 'current', ...v });
    for (const v of s.past) staleChecks.push({ slot, kind: 'past', ...v });
    for (const v of s.wrong) staleChecks.push({ slot, kind: 'wrong', ...v });
    for (const v of s.hedged) staleChecks.push({ slot, kind: 'hedged', ...v });
  }
  const requiredSlots = new Set(probe.requires.map(r => r.split('@')[0]));
  // Relevance: every other CURRENT fact of this user is, for this question, not needed.
  // The name is excluded: the identity card is shown on every turn by design.
  const irrelevant = Object.entries(truth.slots)
    .filter(([slot]) => !requiredSlots.has(slot) && slot !== 'name')
    .flatMap(([slot, s]) => s.current.map(v => ({ slot, ...v })));
  return { required, staleChecks, irrelevant, unknown: probe.unknown ?? null };
}

/** Structural checks on the dataset; throws on the first problem. Run before freezing. */
export function validateDataset(dataset) {
  const ids = new Set();
  const users = new Set();
  const canaryOwner = new Map();
  for (const p of dataset.personas) {
    if (users.has(p.userId)) throw new Error(`duplicate userId ${p.userId}`);
    users.add(p.userId);
    for (const c of p.canaries) {
      if (canaryOwner.has(c.toLowerCase())) throw new Error(`canary ${c} shared by ${canaryOwner.get(c.toLowerCase())} and ${p.id}`);
      canaryOwner.set(c.toLowerCase(), p.id);
    }
    const ents = new Set(p.entities.map(e => e.id));
    for (const r of p.relations) for (const end of [r.from, r.to]) if (end !== 'self' && !ents.has(end)) throw new Error(`${p.id}: relation to unknown entity ${end}`);
    let last = '';
    for (const ev of p.events) {
      if (!STAGES.includes(ev.stage)) throw new Error(`${p.id}: bad stage ${ev.stage}`);
      if (ev.date < last) throw new Error(`${p.id}: events out of date order at ${ev.date}`);
      last = ev.date;
      if (!ev.say && !ev.upload && !ev.action) throw new Error(`${p.id}: event with nothing to do at ${ev.date}`);
      for (const fx of ev.effects ?? []) for (const m of fx.match ?? []) if (m.length < 3) throw new Error(`${p.id}: match "${m}" too short to be specific`);
    }
    for (const s of STAGES) truthAt(p, s);   // replays must not throw
    for (const q of p.probes) {
      if (ids.has(q.id)) throw new Error(`duplicate probe ${q.id}`);
      ids.add(q.id);
      for (const s of q.stages) resolveProbe(p, q, truthAt(p, s));
    }
  }
  // A canary must not occur in another persona's text (or isolation would be untestable).
  for (const p of dataset.personas) {
    const text = JSON.stringify(p.events).toLowerCase();
    for (const [c, owner] of canaryOwner) if (owner !== p.id && text.includes(c)) throw new Error(`canary ${c} (${owner}) occurs in ${p.id}'s events`);
  }
  return { personas: dataset.personas.length, probes: ids.size };
}

// ── Matching ─────────────────────────────────────────────────────────────────

/** Lowercased, accents folded, whitespace collapsed. */
export function norm(s) {
  return String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ');
}
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whole-token occurrence of any surface form. */
export function mentions(text, match) {
  const t = norm(text);
  return (Array.isArray(match) ? match : [match]).some(m => {
    const n = norm(m);
    return new RegExp(`(^|[^\\p{L}\\p{N}])${esc(n)}($|[^\\p{L}\\p{N}])`, 'u').test(t);
  });
}

/** A line that presents a value as history, change, uncertainty or a dated quote — not as current fact. */
// Arrows are NOT markers: the relationship-graph lane renders every edge with one ("user —works_on→ X").
export const MARKED_LINE = /(previous|no longer|since changed|changed|used to|formerly|ended|former|before|was |were |earlier|replaced|retired|superseded|not current|might|maybe|considering|thinking about|not sure|possibly|uncertain|unconfirmed|tentative|hedg|\?|\[\s*\d{4}-\d{2}-\d{2}|\[\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}|\b(on|said on) (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2})/i;

/** Lines of `text` mentioning the value, split into marked / unmarked. */
export function occurrences(text, match) {
  const lines = String(text ?? '').split(/\r?\n/).filter(l => mentions(l, match));
  return { marked: lines.filter(l => MARKED_LINE.test(l)), unmarked: lines.filter(l => !MARKED_LINE.test(l)) };
}

export const UNKNOWN_ACK = /(not known|unknown|haven't (told|said|mentioned)|has not (told|said|mentioned)|no (information|record)|never (told|said|mentioned)|not (stated|provided|mentioned))/i;
