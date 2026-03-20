const mongoose = require("mongoose");

const workspaceSchema = new mongoose.Schema({
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "User", 
    required: true 
  },

  tools: [
    { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "Tool" 
    }
  ]
});

module.exports = mongoose.model("Workspace", workspaceSchema);
