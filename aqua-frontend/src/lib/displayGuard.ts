/* What may reach the screen from the engine's state (2026-10-28).

   The server already strips internals from the Memory and Understanding
   payloads (aqua/src/memory/displayLabels.js, aqua/src/mind/mindPresentation.js).
   This is the second line: an older server, a cached response, or a new
   producer must still not put "event", "custom_…", "collection_merge",
   "simple_qa" or "Domain:" on the page. Rule: no human label → not shown. */

const HIDDEN_INTENTS = ['simple_qa', 'personal_info', 'memory_recall', 'memory_update'];
const INTENT_RE = new RegExp(`\\b(?:${HIDDEN_INTENTS.map((i) => i.replace('_', '[_\\s]')).join('|')})\\b`, 'i');
const INTERNAL_RE = /\bcustom_|\bcollection_merge\b|^\s*domain:/i;

/** True when a string shown to the person would expose engine internals. */
export function isInternalText(text: unknown): boolean {
  const s = String(text ?? '').trim();
  if (!s || /^event$/i.test(s)) return true;
  return INTERNAL_RE.test(s) || INTENT_RE.test(s);
}

/** A routing id ("simple_qa") or an unknown snake_case id is not a topic a person has. */
export function isInternalTopic(topic: unknown): boolean {
  const s = String(topic ?? '').trim();
  if (!s || s.startsWith('workspace:')) return true;
  return isInternalText(s) || /^[a-z]+(?:_[a-z]+)+$/.test(s);
}

/** A fact heading: `label` from the server; a custom_ key never becomes one. */
export function factHeading(fact: { key: string; label?: string | null }): string | null {
  if (fact.label !== undefined) return fact.label && !isInternalText(fact.label) ? fact.label : null;
  if (/^custom_/i.test(fact.key)) return null;
  const words = fact.key.replace(/[_.:\-/]+/g, ' ').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
}

/** A fact value as distinct strings — a collection is a list, never a joined string. */
export function factValueItems(fact: { value: unknown; items?: string[] }): string[] {
  if (Array.isArray(fact.items)) return fact.items;
  const raw = Array.isArray(fact.value) ? fact.value : [fact.value];
  const out: string[] = [];
  for (const v of raw) {
    const s = (v && typeof v === 'object' ? String((v as { name?: unknown }).name ?? '') : String(v ?? '')).trim();
    if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return out;
}

/* ── Beliefs (2026-10-28, second pass) ──────────────────────────────────────
   A belief's `confidence` is not calibrated: it starts at 0.25 + changeRate ×
   strength, or 0.9 for anything matched by a schema pattern. Printing it as
   "73%" claimed a measurement nobody had made. What the page can say truthfully
   is WHERE the belief came from (the person said it, corrected it, or Aqua
   inferred it) and how many observations it rests on. */

type BeliefLike = { key: string; value: unknown; status?: string; source?: string; evidenceCount?: number };

/** One rule for "a person may see this belief" — the cards and the count both use it. */
export function isDisplayableBelief(b: BeliefLike): boolean {
  if (b.status === 'archived' || /^custom_/i.test(b.key)) return false;
  if (b.value === true || b.value === 'true' || b.value == null) return true;
  return !isInternalText(typeof b.value === 'object' ? JSON.stringify(b.value) : String(b.value));
}

const BASIS: Record<string, { label: string; stated: boolean }> = {
  explicit:    { label: 'You said this', stated: true },
  correction:  { label: 'You corrected this', stated: true },
  // understanding/fileBridge.js: topics read out of uploaded documents.
  fact_bridge: { label: 'From your files', stated: false },
  inference:   { label: 'Inferred', stated: false },
  reflection:  { label: 'Inferred', stated: false },
};

/** Fact or inference, in words. Unknown provenance → null (no badge), never a guess. */
export function beliefBasis(b: Pick<BeliefLike, 'source'>): { label: string; stated: boolean } | null {
  return (b.source && BASIS[b.source]) || null;
}

/** "seen 3×" — the observation count; the only number a belief card prints. */
export function evidenceCountText(n: number | undefined): string | null {
  return n && n > 0 ? `seen ${n}×` : null;
}

const DIMENSION_LABEL: Record<string, string> = {
  identity: 'Identity', personality: 'Personality', communication: 'Communication',
  preferences: 'Preferences', knowledge: 'Knowledge', behavior: 'How you work', decision: 'Decisions',
};

/** A dimension id as a heading; an id the page does not know is not printed. */
export function dimensionLabel(d: string): string | null {
  return DIMENSION_LABEL[d] ?? null;
}

/** "domain:machine_learning" → "Machine learning". */
export function stripInternalPrefix(key: string): string {
  const base = key.replace(/^(?:tech|domain):/i, '').replace(/_/g, ' ').trim();
  return base.charAt(0).toUpperCase() + base.slice(1);
}
