"use strict";
/**
 * services/account/privacySettings.service.js
 * AQUIPLEX — per-user privacy settings that the AQUA engine needs on every turn.
 *
 * Today one setting: `rememberSensitive` (default false) — may AQUA remember
 * health and mood details (aqua/src/memory/sensitivity.js)?
 *
 * Read on every engine request, so it is cached per user for a short TTL. A
 * change made through setPrivacy() takes effect on this instance at once; on
 * another instance it takes at most CACHE_TTL_MS. A read failure yields the
 * DEFAULT (false): failing closed means "not remembered", never the reverse.
 */

const User = require("../../models/User");

const CACHE_TTL_MS = 30_000;
const DEFAULTS = Object.freeze({ rememberSensitive: false });
const cache = new Map();   // uid -> { at, value }

function normalize(doc) {
  return { rememberSensitive: doc?.privacy?.rememberSensitive === true };
}

async function getPrivacy(uid, { model = User, now = Date.now() } = {}) {
  if (!uid) return { ...DEFAULTS };
  const hit = cache.get(String(uid));
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;
  try {
    const doc = await model.findById(uid).select("privacy").lean();
    const value = normalize(doc);
    cache.set(String(uid), { at: now, value });
    return value;
  } catch {
    return { ...DEFAULTS };
  }
}

async function setPrivacy(uid, patch = {}, { model = User } = {}) {
  const update = {};
  if (typeof patch.rememberSensitive === "boolean") update["privacy.rememberSensitive"] = patch.rememberSensitive;
  if (!Object.keys(update).length) return getPrivacy(uid, { model });
  const doc = await model.findByIdAndUpdate(uid, { $set: update }, { new: true }).select("privacy").lean();
  const value = normalize(doc);
  cache.set(String(uid), { at: Date.now(), value });
  return value;
}

/** Express middleware: req.aquaSettings for the engine (after requireLogin). */
function attachAquaSettings(getUid) {
  return async (req, res, next) => {
    req.aquaSettings = await getPrivacy(getUid(req));
    next();
  };
}

function _clearCache() { cache.clear(); }

module.exports = { getPrivacy, setPrivacy, attachAquaSettings, DEFAULTS, CACHE_TTL_MS, _clearCache };
