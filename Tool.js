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
    default: 0
  },
  logo: String,

  clickHistory: [
    {
      date: { type: Date, default: Date.now }
    }
  ]

});

module.exports = mongoose.model("Tool", toolSchema);