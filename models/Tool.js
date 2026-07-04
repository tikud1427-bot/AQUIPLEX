const mongoose = require("mongoose");

const toolSchema = new mongoose.Schema({
  id: String,
  name: String,
  category: String,
  url: String,
  description: String,
  trending: Boolean,

  clicks: {
    type: Number,
    default: 0,
  },

  likes: {
    type: Number,
    default: 0,
  },

  likedBy: {
    type: [String],
    default: [],
  },

  logo: String,

  clickHistory: [
    {
      date: { type: Date, default: Date.now },
    },
  ],

  // ── Moderation ────────────────────────────────────────────────────────────
  // "pending"  → submitted, awaiting admin review (hidden from public)
  // "approved" → visible in public tool listings
  // "rejected" → not shown, submitter can be notified
  status: {
    type: String,
    enum: ["pending", "approved", "rejected"],
    default: "approved", // existing/seeded tools are auto-approved
    index: true,
  },

  submittedBy: {
    type: String, // userId or "anonymous"
    default: "anonymous",
  },

  rejectionReason: {
    type: String,
    default: "",
  },
});

module.exports = mongoose.model("Tool", toolSchema);