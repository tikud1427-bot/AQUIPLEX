/**
 * AQUA Identity Migration — legacy `custom_trait` → canonical identity / de-collided customs
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs ONCE at boot, after the store-unification migration. Idempotent: each
 * mind is flagged `_identityMigrated` and skipped on the next run.
 *
 * Before v4, three things could land in the single OVERWRITE-policy fact key
 * `custom_trait`, each destroying the last:
 *   • a role+company blob  ("the founder of Aquiplex")  — should be identity
 *   • a personal trait     ("a night owl")               — a legitimate custom
 *   • an intro name         (rare, if the schema missed it)
 *
 * This pass repairs existing data WITHOUT guessing:
 *   1. If the value has an unambiguous role-of-org shape ("[the] ROLE of/at
 *      ORG"), promote it to `profession` + `workplace` (the identity fields),
 *      through the normal conflict-resolving store (never a blind overwrite).
 *   2. Otherwise, de-collide the shared bucket into a per-value key
 *      (`custom_<slug>`) so it stops overwriting future custom facts.
 *   Nothing is dropped. Ambiguous free text (including bare names) is preserved
 *   as a custom fact rather than mis-promoted — forward extraction, now fixed,
 *   captures names correctly from here on.
 */
import { _iterateMindsForStats, touchMind } from '../mind/mindStore.js';
import { storeFact } from './longTermMemory.js';
import { CATEGORIES } from './memorySchema.js';

// Unambiguous "[the/a/an] ROLE of|at|for ORG" — the exact shape that used to
// rot inside custom_trait. Conservative on purpose: we only auto-promote when
// the structure is unmistakable.
const ROLE_OF_ORG = /^(?:the\s+|a\s+|an\s+)?([a-z][a-z\s-]{1,30}?)\s+(?:of|at|for)\s+([A-Za-z0-9][A-Za-z0-9&.'\s-]{1,40})$/i;
const FOUNDER_OF   = /^(co-?)?founder\s+of\s+([A-Za-z0-9][A-Za-z0-9&.'\s-]{1,40})$/i;

function titleCase(s) { return String(s).trim().replace(/\b\w/g, c => c.toUpperCase()); }

function structuredIdentity(text) {
  const t = String(text).trim();
  let m = t.match(FOUNDER_OF);
  if (m) return [{ key: 'profession', value: m[1] ? 'Co-founder' : 'Founder' }, { key: 'workplace', value: m[2].trim() }];
  m = t.match(ROLE_OF_ORG);
  if (m) return [{ key: 'profession', value: m[1].trim() }, { key: 'workplace', value: m[2].trim() }];
  return null;
}

function customSlug(value) {
  return 'custom_' + String(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

export function migrateIdentity() {
  let owners = 0, reclassified = 0, decollided = 0, scanned = 0;

  for (const mind of _iterateMindsForStats()) {
    if (!mind || mind._identityMigrated || mind.adoptedInto) continue;
    scanned++;
    const owner = mind.ownerId;
    const facts = mind.facts || {};
    let changed = false;

    // Only the collided shared bucket is ambiguous enough to need repair.
    const legacy = facts['custom_trait'];
    if (legacy && typeof legacy.value === 'string' && legacy.value.trim()) {
      const text = legacy.value.trim();
      const ident = structuredIdentity(text);
      if (ident) {
        for (const u of ident) {
          storeFact(owner, {
            key: u.key, value: u.value,
            confidence: Math.max(0.6, (legacy.confidence ?? 0.7)),
            importance: 8, category: CATEGORIES.WORK,
            sourceText: `migrated from custom_trait: "${text}"`,
            ts: legacy.ts || legacy.updatedAt || Date.now(),
          });
        }
        delete facts['custom_trait'];
        reclassified++; changed = true;
        console.log(`[MIGRATE] Identity: owner=${owner} promoted custom_trait "${text}" → role=${titleCase(ident[0].value)} company="${ident[1].value}"`);
      } else {
        const slug = customSlug(text);
        if (slug !== 'custom_' && !facts[slug]) facts[slug] = { ...legacy, key: slug, id: `${owner}:${slug}` };
        delete facts['custom_trait'];
        decollided++; changed = true;
        console.log(`[MIGRATE] Identity: owner=${owner} de-collided custom_trait → ${slug}`);
      }
    }

    mind._identityMigrated = true;
    if (changed) owners++;
    touchMind(mind); // persist the migration flag even when nothing changed
  }

  console.log(`[MIGRATE] Identity pass: mindsScanned=${scanned} ownersRepaired=${owners} reclassified=${reclassified} decollided=${decollided}`);
  return { owners, reclassified, decollided, scanned };
}
