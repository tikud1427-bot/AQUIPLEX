/**
AQUA Entity Normalizer v3.1
*/
import { getSchema, CATEGORIES } from './memorySchema.js';

const log = {
  debug: (msg, ...args) => console.debug(`[AQUA Normalizer] ${msg}`, ...args),
  warn: (msg, ...args) => console.warn(`[AQUA Normalizer] ${msg}`, ...args),
};

export function normalizeCandidates(candidates) {
  const accepted = [];
  const rejected = [];

  for (const c of candidates) {
    // Custom facts have no schema entry — accept with passthrough normalization
    if (c.category === CATEGORIES.CUSTOM) {
      const normalized = (c.value || '').trim();
      if (!normalized) {
        rejected.push({ ...c, rejectionReason: 'empty_after_normalize', validationStatus: 'rejected' });
        continue;
      }
      accepted.push({ ...c, normalizedValue: normalized, validationStatus: 'validated' });
      continue;
    }

    const schema = getSchema(c.key);
    if (!schema) {
      rejected.push({ ...c, rejectionReason: 'no_schema', validationStatus: 'rejected' });
      continue;
    }

    let normalized = c.value;
    try {
      if (typeof schema.normalizer === 'function') {
        normalized = schema.normalizer(c.value);
      }
    } catch (err) {
      rejected.push({ ...c, rejectionReason: 'normalizer_error', error: err.message, validationStatus: 'rejected' });
      continue;
    }

    if (normalized === null || normalized === undefined || normalized === '') {
      rejected.push({ ...c, rejectionReason: 'empty_after_normalize', validationStatus: 'rejected' });
      continue;
    }

    if (Array.isArray(normalized)) {
      normalized = normalized.filter((v) => v !== null && v !== undefined && v !== '');
      if (normalized.length === 0) {
        rejected.push({ ...c, rejectionReason: 'empty_array_after_normalize', validationStatus: 'rejected' });
        continue;
      }
    }

    if (typeof schema.validator === 'function') {
      try {
        if (!schema.validator(normalized)) {
          rejected.push({ ...c, normalizedValue: normalized, rejectionReason: 'validation_failed', validationStatus: 'rejected' });
          log.debug(`Rejected ${c.key} due to validation failure`, { value: normalized });
          continue;
        }
      } catch (err) {
        rejected.push({ ...c, rejectionReason: 'validator_error', error: err.message, validationStatus: 'rejected' });
        continue;
      }
    }

    accepted.push({ ...c, normalizedValue: normalized, validationStatus: 'validated' });
  }

  log.debug(`Normalized ${accepted.length} candidates, rejected ${rejected.length}`);
  return { accepted, rejected };
}

export function normalizeCandidate(candidate) {
  const { accepted, rejected } = normalizeCandidates([candidate]);
  return accepted[0] || rejected[0] || null;
}