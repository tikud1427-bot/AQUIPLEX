const mongoose = require("mongoose");

const historySchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  title: {
    type: String // first message as title
  },
  messages: [
    {
      role: String, // "user" or "assistant"
      content: String
    }
  ]
}, { timestamps: true });

module.exports = mongoose.model("History", historySchema);