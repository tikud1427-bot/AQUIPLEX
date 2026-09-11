/**
 * AQUA Memory Migration — legacy `.aqua-memory.json` → unified Mind store.
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs ONCE at boot (idempotent: source file is renamed after success, so a
 * restart is a no-op). Nothing is lost:
 *
 *   conversation-keyed facts → owner-keyed facts
 *     conversation has meta.userId  → `user:<userId>`   (the real owner)
 *     otherwise                     → `conv:<convId>`   (adopted on login,
 *                                     see ownerResolver.resolveOwner)
 *
 * When several conversations of one user carried the same key, facts merge
 * through storeFact's conflict resolver — newer/higher-confidence wins,
 * history preserved. Exactly the semantics a live overwrite would have had.
 */
import fs from 'fs';
import path from 'path';
import { storeFact } from './longTermMemory.js';
import { getConversationMeta } from './conversationStore.js';
import { ownerForUser, ownerForConversation } from './ownerResolver.js';

import { dataPath } from '../core/dataDir.js';

// P0 — the unconverted legacy fact file may live in the deploy tree (pre
// data-dir builds) or already inside the data dir (migrated by dataDir on a
// boot where conversion hadn't run yet). Check both; first hit wins.
const LEGACY_CANDIDATES = [
  dataPath('.aqua-memory.json'),
  path.join(process.cwd(), '.aqua-memory.json'),
];
const LEGACY_FILE = LEGACY_CANDIDATES.find(p => fs.existsSync(p)) ?? LEGACY_CANDIDATES[0];

export function migrateLegacyMemory() {
  if (!fs.existsSync(LEGACY_FILE)) return { migrated: false };

  let data;
  try {
    data = JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf8'));
  } catch (err) {
    console.warn('[MIGRATE] Legacy memory file unreadable — leaving untouched:', err.message);
    return { migrated: false, error: err.message };
  }

  let facts = 0;
  let conversations = 0;
  let toUsers = 0;

  for (const [conversationId, factsObj] of Object.entries(data)) {
    conversations++;
    const meta = getConversationMeta(conversationId);
    const owner = meta?.userId
      ? ownerForUser(meta.userId)
      : ownerForConversation(conversationId);
    if (meta?.userId) toUsers++;

    for (const fact of Object.values(factsObj || {})) {
      storeFact(owner, { ...fact, sourceConversation: conversationId });
      facts++;
    }
  }

  const archived = `${LEGACY_FILE}.migrated-${Date.now()}`;
  try {
    fs.renameSync(LEGACY_FILE, archived);
  } catch (err) {
    console.warn('[MIGRATE] Could not archive legacy file:', err.message);
  }

  console.log(`[MIGRATE] Legacy memory unified: conversations=${conversations} facts=${facts} userOwned=${toUsers} → ${path.basename(archived)}`);
  return { migrated: true, conversations, facts, toUsers };
}
