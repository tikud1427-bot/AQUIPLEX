/**
AQUA Long-Term Memory Store v3 (Cleaned)
*/
import fs from 'fs';
import path from 'path';
import { resolveMemoryConflict } from './memoryConflictResolver.js';
import { RESOLUTION_ACTIONS } from './memoryResolver.js';

const STORE_FILE = path.join(process.cwd(), '.aqua-memory.json');
const MIN_CONF = 0.5;

const store = new Map();

function loadFromDisk() {
  try {
    if (!fs.existsSync(STORE_FILE)) return; 
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const data = JSON.parse(raw);
    let count = 0;
    for (const [convId, factsObj] of Object.entries(data)) {
      store.set(convId, new Map(Object.entries(factsObj)));
      count += Object.keys(factsObj).length;
    }
    console.log(`[LTM] Loaded ${store.size} conversations, ${count} facts from disk`);
  } catch (err) {
    console.warn('[LTM] Could not load from disk:', err.message);
  }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const data = {};
      for (const [convId, factMap] of store.entries()) {
        data[convId] = Object.fromEntries(factMap);
      }
      fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.warn('[LTM] Could not save to disk:', err.message);
    }
  }, 500);
}
loadFromDisk();

function getOrCreate(conversationId) {
  if (!store.has(conversationId)) store.set(conversationId, new Map());
  return store.get(conversationId); 
}

function buildVersionHistory(existing, reason) {
  const prevHistory = Array.isArray(existing.history) ? existing.history : [];
  return [
    ...prevHistory,
    {
      value: existing.value,
      normalizedValue: existing.normalizedValue ?? existing.value,
      ts: existing.ts,
      supersededAt: Date.now(),
      confidence: existing.confidence ?? 0.5,
      reason,
      sourceMessage: existing.sourceMessage || existing.sourceText || '',
      revision: existing.revision || 1,
    },
  ];
}

function makeFactId(conversationId, key) {
  return `${conversationId}:${key}`;
}

function upgradeFact(fact, conversationId) {
  const now = Date.now();
  return {
    id: fact.id || makeFactId(conversationId, fact.key),
    category: fact.category || null,
    key: fact.key,
    value: fact.value,
    normalizedValue: fact.normalizedValue ?? fact.value,
    confidence: fact.confidence ?? 0.5,
    importance: fact.importance ?? 5,
    createdAt: fact.createdAt || fact.ts || now,
    updatedAt: fact.updatedAt || fact.ts || now,
    lastMentionedAt: fact.lastMentionedAt || fact.ts || now,
    ts: fact.ts || now,
    sourceConversation: fact.sourceConversation || conversationId,
    sourceMessage: fact.sourceMessage || fact.sourceText || '',
    sourceText: fact.sourceText || fact.sourceMessage || '',
    metadata: fact.metadata || {},
    revision: fact.revision ?? 1,
    history: Array.isArray(fact.history) ? fact.history : [],
    status: fact.status || 'active',
  };
}

export function storeFact(conversationId, fact) {
  if (!fact || (fact.confidence ?? 0) < MIN_CONF) return;
  const factMap = getOrCreate(conversationId);
  const existing = factMap.get(fact.key) ?? null;
  const now = Date.now();

  if (fact.action && Object.values(RESOLUTION_ACTIONS).includes(fact.action)) {
    return storeResolved(conversationId, fact);
  }

  const { action, reason } = resolveMemoryConflict(fact, existing);
  console.log(`[LTM] CONFLICT_RESOLVED conv=${conversationId} key=${fact.key} action=${action} reason=${reason}`);

  if (action === 'keep' && reason === 'identical_value' && existing) {
    existing.updatedAt = now;
    existing.lastMentionedAt = now;
    existing.ts = now;
    existing.confidence = Math.min(1.0, (existing.confidence || 0.5) + 0.05);
    existing.revision = existing.revision || 1;
    factMap.set(fact.key, existing);
    scheduleSave();
    return;
  }

  if (action === 'keep') return;

  const history = existing ? buildVersionHistory(existing, reason) : (existing?.history || []);
  const { isCorrection: _drop, action: _drop2, ...persistableFact } = fact;
  const upgraded = upgradeFact(persistableFact, conversationId);
  upgraded.history = history;
  
  if (existing) {
    upgraded.revision = (existing.revision || 1) + 1;
    upgraded.createdAt = existing.createdAt || upgraded.createdAt;
  }
  
  factMap.set(fact.key, upgraded);
  scheduleSave();
}

export function storeResolved(conversationId, resolved) {
  if (!resolved || (resolved.confidence ?? 0) < MIN_CONF) return;
  const factMap = getOrCreate(conversationId);
  const existing = factMap.get(resolved.key) ?? null;
  const now = Date.now();

  switch (resolved.action) {
    case RESOLUTION_ACTIONS.DUPLICATE: {
      if (existing) {
        existing.lastMentionedAt = now;
        existing.updatedAt = now;
        existing.ts = now;
        existing.confidence = Math.min(1.0, (existing.confidence || 0.5) + 0.05);
        scheduleSave();
      }
      return;
    }
    case RESOLUTION_ACTIONS.MERGE: {
      const merged = resolved.mergedValue;
      const history = existing ? buildVersionHistory(existing, 'collection_merge') : [];
      const upgraded = upgradeFact({ ...resolved, value: merged, normalizedValue: merged }, conversationId);
      upgraded.history = history;
      upgraded.revision = (existing?.revision || 0) + 1;
      upgraded.createdAt = existing?.createdAt || now;
      upgraded.lastMentionedAt = now;
      factMap.set(resolved.key, upgraded);
      scheduleSave();
      return;
    }
    case RESOLUTION_ACTIONS.OVERWRITE:
    case RESOLUTION_ACTIONS.CORRECTION: {
      const history = existing ? buildVersionHistory(existing, resolved.reason) : [];
      const upgraded = upgradeFact(resolved, conversationId);
      upgraded.history = history;
      upgraded.revision = (existing?.revision || 0) + 1;
      upgraded.createdAt = existing?.createdAt || now;
      upgraded.lastMentionedAt = now;
      factMap.set(resolved.key, upgraded);
      scheduleSave();
      return;
    }
    default: {
      const upgraded = upgradeFact(resolved, conversationId);
      upgraded.createdAt = now;
      upgraded.lastMentionedAt = now;
      factMap.set(resolved.key, upgraded);
      scheduleSave();
      return;
    }
  }
}

export function getFacts(conversationId) {
  const factMap = store.get(conversationId);
  if (!factMap || !factMap.size) return [];
  return [...factMap.values()].sort((a, b) => (b.importance || 0) - (a.importance || 0));
}

export function getFact(conversationId, key) {
  return store.get(conversationId)?.get(key) ?? null;
}

export function clearFacts(conversationId) {
  store.delete(conversationId);
  scheduleSave();
}

export function storeFacts(conversationId, facts = []) {
  if (!Array.isArray(facts)) return;

  for (const fact of facts) {
    storeFact(conversationId, fact);
  }
}

export function deleteFact(conversationId, key) {
  const factMap = store.get(conversationId);

  if (!factMap) return false;

  const deleted = factMap.delete(key);

  if (deleted) {
    scheduleSave();
  }

  return deleted;
}

export function getFactHistory(conversationId, key) {
  const fact = store.get(conversationId)?.get(key);
  if (!fact) return [];
  return Array.isArray(fact.history) ? fact.history : [];
}

export function getMemoryStats() {
  let conversations = store.size;
  let facts = 0;
  let resolved = 0;

  for (const memory of store.values()) {
    facts += memory.size;

    for (const fact of memory.values()) {
      if (fact.resolved) {
        resolved++;
      }
    }
  }

  return {
    conversations,
    facts,
    resolved,
    active: facts - resolved
  };
}