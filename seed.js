const mongoose = require("mongoose");
const Tool = require("./models/Tool");
const tools = require("./data/tools.json");
require("dotenv").config();

async function seed() {
  try {
    await mongoose.connect(process.env.MONGO_URI);

    console.log("Connected to MongoDB");

    // delete old tools
    await Tool.deleteMany({});
    console.log("Old tools deleted");

    // insert new tools
    await Tool.insertMany(tools);
    console.log("New tools inserted");

    process.exit();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

seed();