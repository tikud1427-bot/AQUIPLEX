const mongoose = require("mongoose");

const workspaceSchema = new mongoose.Schema({
  userId: String,
  tools: [
    {
      toolId: String,
      name: String,
      url: String,
      logo: String
    }
  ]
});

module.exports = mongoose.model("Workspace", workspaceSchema);