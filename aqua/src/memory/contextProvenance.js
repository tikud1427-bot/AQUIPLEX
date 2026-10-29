/**
 * AQUA — "Context used" for a REOPENED conversation (2026-10-29).
 *
 * The disclosure under a live answer is built from what that turn injected
 * (routes/chat.js contextUsedItems). Reopening the conversation later used to
 * show nothing, because a stored message is only { role, content, ts }.
 *
 * What is stored is a REFERENCE per item — a fact key or a claim id, plus a
 * short fingerprint of the exact text the model was given — never the text.
 * Copying the text onto messages would create a second store of personal data
 * that forget/correct (memory/forget.js) does not know about.
 *
 * Read time resolves each reference against the stores AS THEY ARE NOW:
 *   unchanged      shown as it was used
 *   changed        shown, marked "since changed"; the fingerprint proves the
 *                  current text is not what the model read, so nothing claims
 *                  it was
 *   gone           (forgotten / deleted / archived) never shown — counted only
 *   unreadable     (World Model down) counted, never guessed
 */
import crypto from 'node:crypto';
import { getFact } from './longTermMemory.js';
import { failsItsSchema } from './factVisibility.js';
import { factLabel, factItems } from './displayLabels.js';

const MAX_REFS = 8;
const fingerprint = text => crypto.createHash('sha256').update(String(text ?? '').trim().toLowerCase()).digest('hex').slice(0, 12);
const factText = f => factItems(f.value).join(', ').slice(0, 280);

/** contextUsed items (live payload shape) → references to store on the message. */
export function contextRefs(items) {
  const out = [];
  for (const i of Array.isArray(items) ? items.slice(0, MAX_REFS) : []) {
    if (i?.kind === 'claim' && i.id) out.push({ k: 'claim', id: String(i.id), h: fingerprint(i.text) });
    else if (i?.kind === 'fact' && i.key) out.push({ k: 'fact', key: String(i.key), h: fingerprint(i.text) });
  }
  return out;
}

/**
 * @param {string} ownerId                    the conversation's owner (never client input)
 * @param {object[]} refs                     as stored by contextRefs
 * @param {{ readClaims?: Function }} [deps]  readClaims(ownerId, ids, {retrospective}) — canonical store
 * @returns {Promise<{ items: object[], removed: number, unavailable: number } | null>} null when no refs
 */
export async function resolveContextRefs(ownerId, refs, { readClaims = null } = {}) {
  const list = Array.isArray(refs) ? refs.slice(0, MAX_REFS) : [];
  if (!ownerId || !list.length) return null;
  const items = [];
  let removed = 0;
  let unavailable = 0;

  const claimRefs = list.filter(r => r?.k === 'claim' && r.id);
  let claims = null;
  if (claimRefs.length) {
    try {
      claims = readClaims ? await readClaims(ownerId, claimRefs.map(r => r.id), { retrospective: true }) : null;
    } catch {
      claims = null;
    }
  }
  const claimById = new Map((claims ?? []).map(c => [String(c.claimId), c]));

  for (const r of list) {
    if (r?.k === 'fact' && r.key) {
      const f = getFact(ownerId, r.key);
      if (!f || f.status === 'archived' || failsItsSchema(f)) { removed++; continue; }
      const text = factText(f);
      if (!text) { removed++; continue; }
      items.push({ kind: 'fact', key: r.key, label: factLabel(f), text, changed: fingerprint(text) !== r.h });
    } else if (r?.k === 'claim' && r.id) {
      if (claims === null) { unavailable++; continue; }
      const c = claimById.get(r.id);
      // Archived (forgotten / deleted) claims are not read back at all.
      if (!c) { removed++; continue; }
      const text = String(c.statement ?? c.statementText ?? '').replace(/\s+/g, ' ').trim().slice(0, 280);
      if (!text) { removed++; continue; }
      items.push({ kind: 'claim', id: r.id, text, disputed: c.state === 'disputed', changed: c.state === 'superseded' || fingerprint(text) !== r.h });
    }
  }
  return { items, removed, unavailable };
}
