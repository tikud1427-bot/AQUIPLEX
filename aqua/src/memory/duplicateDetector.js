/**
 * AQUA Duplicate Detector v3
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects duplicates WITHIN a single message's candidate set.
 * Cross-message duplicate detection happens in memoryResolver against stored facts.
 *
 * Rules:
 *   • Same key + same normalized value → keep highest confidence, mark as duplicate
 *   • For multiValue collections: same item (by identity) → merge
 */

/**
 * Deduplicate a list of candidates within the same message.
 * Returns { unique, duplicates }.
 *
 * @param {Candidate[]} candidates
 * @returns {{ unique: Candidate[], duplicates: Candidate[] }}
 */
export function deduplicateIntraMessage(candidates) {
  const unique = [];
  const duplicates = [];
  const seenByKey = new Map();       // key → candidate
  const seenCollectionItems = new Map(); // key → Set<itemKey>

  for (const c of candidates) {
    if (c.multiValue) {
      // Collection: dedupe by item identity
      const items = Array.isArray(c.normalizedValue) ? c.normalizedValue : [c.normalizedValue];
      const isFirst = !seenCollectionItems.has(c.key);
      if (isFirst) {
        // First encounter — push as-is and seed the seen set
        seenCollectionItems.set(c.key, new Set(items.map(itemIdentityKey)));
        seenByKey.set(c.key, c);
        unique.push(c);
        continue;
      }
      const existingSet = seenCollectionItems.get(c.key);
      const existingCand = seenByKey.get(c.key);
      const newItems = [];
      for (const item of items) {
        const itemKey = itemIdentityKey(item);
        if (existingSet.has(itemKey)) {
          duplicates.push({ ...c, _singleItem: item, rejectionReason: 'intra_message_duplicate' });
        } else {
          existingSet.add(itemKey);
          newItems.push(item);
        }
      }
      // Merge new items into existing candidate
      if (existingCand && newItems.length > 0) {
        existingCand.normalizedValue = Array.isArray(existingCand.normalizedValue)
          ? [...existingCand.normalizedValue, ...newItems]
          : [...(existingCand.normalizedValue !== null && existingCand.normalizedValue !== undefined ? [existingCand.normalizedValue] : []), ...newItems];
      }
    } else {
      // Scalar: dedupe by key
      if (seenByKey.has(c.key)) {
        const existing = seenByKey.get(c.key);
        // Keep the one with higher confidence
        if ((c.confidence || 0) > (existing.confidence || 0)) {
          // Replace
          const idx = unique.indexOf(existing);
          if (idx >= 0) unique[idx] = c;
          seenByKey.set(c.key, c);
          duplicates.push({ ...existing, rejectionReason: 'intra_message_duplicate_lower_conf' });
        } else {
          duplicates.push({ ...c, rejectionReason: 'intra_message_duplicate' });
        }
      } else {
        seenByKey.set(c.key, c);
        unique.push(c);
      }
    }
  }

  return { unique, duplicates };
}

/**
 * Produce a stable identity key for a collection item.
 * Objects: use all fields sorted; primitives: use value.
 */
function itemIdentityKey(item) {
  if (item === null || item === undefined) return '';
  if (typeof item !== 'object') return String(item).toLowerCase().trim();
  // For pet-like objects: use type+name as identity
  if (item.type && item.name) {
    return `${item.type}:${item.name}`.toLowerCase();
  }
  // Generic: sorted JSON
  const keys = Object.keys(item).sort();
  return keys.map((k) => `${k}=${item[k]}`).join('|').toLowerCase();
}