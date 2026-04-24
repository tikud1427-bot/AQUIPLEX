const mongoose = require("mongoose");

/**
 * UPGRADED User model
 * 
 * [FIX-3] Added googleId field.
 * The original model was missing this field, causing Google OAuth users
 * to silently lose their googleId on every save (Mongoose drops unknown fields).
 */
const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
  },
  password: {
    type: String,
    required: true,
  },
  // Added: stored on first Google OAuth login, used to link accounts
  googleId: {
    type: String,
    default: null,
    sparse: true, // allows multiple null values (non-OAuth users)
  },
});

module.exports = mongoose.model("User", userSchema);
