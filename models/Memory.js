const mongoose = require("mongoose");

/**
 * UPGRADED MEMORY MODEL
 * 
 * Changes from original:
 * - Added memoryType: 'short_term' | 'long_term' | 'session'
 * - Added importance (0–1 float) for smart ranking
 * - Added frequency (how often this memory is referenced)
 * - Added lastAccessed (for recency ranking)
 * - Added expiresAt (TTL for short_term memories)
 * - importance field was in original schema but unused — now actively used
 */

const memorySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true, // index for fast per-user lookups
    },

    key: {
      type: String,
      required: true,
    },

    value: {
      type: String,
      required: true,
    },

    // 'short_term' = recent context, auto-expires after 24h
    // 'long_term'  = stable facts (name, goals, profession, etc.)
    // 'session'    = exists only for current chat session (not persisted long)
    memoryType: {
      type: String,
      enum: ["short_term", "long_term", "session"],
      default: "long_term",
    },

    // 0.0 – 1.0 — higher = more important, more likely to be kept
    importance: {
      type: Number,
      default: 0.5,
      min: 0,
      max: 1,
    },

    // How many times this memory has been extracted/referenced across messages
    frequency: {
      type: Number,
      default: 1,
    },

    // Timestamp of last access — used for recency ranking in retrieval
    lastAccessed: {
      type: Date,
      default: Date.now,
    },

    // Only set for short_term memories — MongoDB TTL index will auto-delete
    expiresAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// Compound index: fast lookup by userId + key (for upserts)
memorySchema.index({ userId: 1, key: 1 }, { unique: true });

// TTL index: MongoDB will auto-delete documents where expiresAt has passed
// This handles short_term memory expiry automatically at the DB level
memorySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, sparse: true });

module.exports = mongoose.model("Memory", memorySchema);
