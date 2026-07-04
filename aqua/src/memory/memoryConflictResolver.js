/**
AQUA Memory Conflict Resolver v3
─────────────────────────────────────────────────────────────────────────────
v3 additions (priority algorithm UNCHANGED):
• New actions: merge_collection, duplicate, contradiction, partial_overwrite
• resolveCollectionMerge() — deduped array merge for multiValue facts
• detectContradiction() — semantic contradiction detector (heuristic)
Priority order preserved:
explicit correction
newer timestamp
higher confidence
keep existing
*/
// ── Correction phrase list (unchanged) ────────────────────────────────────────
const DEFAULT_CORRECTION_PHRASES = [
'actually', 'actually,', 'actually my', 'no,', 'no.', 'nope', 'nope,',
'not anymore', 'i changed', "i've changed", 'i have changed', 'i switched',
"i've switched", 'i have switched', "it's now", 'it is now', 'update that',
'correction:', 'correction,', 'replace it with', 'forget that', 'instead,',
'instead.', 'from now on', 'use this instead', 'use x instead', 'my new',
'i no longer', 'i now use', 'i now prefer', 'i moved to', "i've moved to",
'i recently switched', 'wait,', 'wait no', 'scratch that', 'disregard that',
'ignore that', 'that was wrong', 'i was wrong', 'i lied', 'i meant', 'i mean,',
'previously', 'used to', 'rather',
];
const EXTRA_PHRASES = process.env.AQUA_CORRECTION_PHRASES
? process.env.AQUA_CORRECTION_PHRASES.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean)
: [];
export const CORRECTION_PHRASES = [...DEFAULT_CORRECTION_PHRASES, ...EXTRA_PHRASES];
// ── Correction detection (unchanged) ──────────────────────────────────────────
export function detectCorrection(message) {
if (!message || typeof message !== 'string') return { isCorrection: false };
const lower = message.toLowerCase().trim();
for (const phrase of CORRECTION_PHRASES) {
if (
lower === phrase ||
lower.startsWith(phrase + ' ') ||
lower.startsWith(phrase + ',') ||
lower.startsWith(phrase + '.')
) {
return { isCorrection: true, phrase };
}
let searchFrom = 0;
let idx;
while ((idx = lower.indexOf(phrase, searchFrom)) !== -1) {
const charBefore = idx > 0 ? lower[idx - 1] : null;
if (charBefore === null || charBefore === ' ' || charBefore === ',' || charBefore === '.') {
const charAfter = lower[idx + phrase.length];
if (!charAfter || charAfter === ' ' || charAfter === ',' || charAfter === '.') {
return { isCorrection: true, phrase };
}
}
searchFrom = idx + 1;
}
}
return { isCorrection: false };
}
// ── Conflict resolution (priority UNCHANGED) ──────────────────────────────────
export function resolveMemoryConflict(incoming, existing) {
if (!existing) return { action: 'overwrite', reason: 'no_existing' };
if (
typeof incoming.value === 'string' &&
typeof existing.value === 'string' &&
incoming.value.toLowerCase().trim() === existing.value.toLowerCase().trim()
) {
return { action: 'keep', reason: 'identical_value' };
}
if (incoming.isCorrection) return { action: 'overwrite', reason: 'explicit_correction' };
if ((incoming.ts || 0) > (existing.ts || 0)) return { action: 'overwrite', reason: 'newer_timestamp' };
if ((incoming.confidence || 0) > (existing.confidence || 0)) return { action: 'overwrite', reason: 'higher_confidence' };
return { action: 'keep', reason: 'existing_wins' };
}
// ── v3 additions ──────────────────────────────────────────────────────────────
/**
Merge a new array of items into an existing collection, deduping by identity.
Returns { merged, added, skipped }.
*/
export function resolveCollectionMerge(existingArr, incomingArr) {
const existing = Array.isArray(existingArr) ? existingArr : (existingArr ? [existingArr] : []);
const incoming = Array.isArray(incomingArr) ? incomingArr : (incomingArr ? [incomingArr] : []);
const existingKeys = new Set(existing.map(itemKey));
const added = [];
const skipped = [];
for (const item of incoming) {
const k = itemKey(item);
if (existingKeys.has(k)) skipped.push(item);
else {
added.push(item);
existingKeys.add(k);
}
}
return { merged: [...existing, ...added], added, skipped };
}
function itemKey(item) {
if (item === null || item === undefined) return '';
if (typeof item !== 'object') return String(item).toLowerCase().trim();
if (item.type && item.name) return `${item.type}:${item.name}`.toLowerCase();
const keys = Object.keys(item).sort();
return keys.map((k) => `${k}=${item[k]}`).join('|').toLowerCase();
}
/**
Heuristic contradiction detector.
Returns { isContradiction: true, reason } if incoming semantically contradicts existing.
Used as a signal — explicit correction still takes priority.
*/
export function detectContradiction(incoming, existing) {
if (!existing || !incoming) return { isContradiction: false };
if (incoming.key !== existing.key) return { isContradiction: false };
// Same value → not a contradiction
const a = norm(incoming.value);
const b = norm(existing.value);
if (a === b) return { isContradiction: false };
// For scalar strings: different non-empty values on same key = contradiction
if (typeof incoming.value === 'string' && typeof existing.value === 'string') {
return { isContradiction: true, reason: 'scalar_value_changed' };
}
return { isContradiction: false };
}
function norm(v) {
if (v === null || v === undefined) return '';
if (typeof v === 'string') return v.toLowerCase().trim();
return JSON.stringify(v);
}