"use strict";
/**
 * Options for every Google OAuth strategy in index.js (sign-in, link, reauth).
 *
 * THE GAP THIS CLOSES (login / link CSRF, 2026-10-28)
 * ---------------------------------------------------
 * Without `state`, a callback URL carrying ANY valid authorization code was
 * accepted on whatever session arrived with it. An attacker could start a
 * Google flow in their own browser, stop at the callback, and send the
 * victim the URL: the sign-in callback then signs the victim into the
 * attacker's account, and the link callback (the victim is signed in; the
 * session cookie is SameSite=Lax, so a top-level GET carries it) binds the
 * ATTACKER's Google identity to the VICTIM's account, which is a takeover.
 *
 * `state: true` + `pkce: true` makes passport-oauth2 keep a random handle and
 * a PKCE verifier in the session that started the flow. A callback is
 * accepted only on that session, only with that handle, and only once:
 * the store deletes the entry on every verify, matched or not. The code
 * itself is useless without the verifier, so a leaked callback URL
 * cannot be redeemed elsewhere either.
 *
 * Each strategy gets its own session slot so a sign-in started in one tab
 * cannot clobber, or be satisfied by, a link or reauth flow in another.
 */

const SESSION_KEYS = Object.freeze({
  signin: "oauth2:google:signin",
  link:   "oauth2:google:link",
  reauth: "oauth2:google:reauth",
});

/**
 * @param {"signin"|"link"|"reauth"} flow
 * @param {string} callbackURL
 * @param {NodeJS.ProcessEnv} [env]
 */
function googleStrategyOptions(flow, callbackURL, env = process.env) {
  const sessionKey = SESSION_KEYS[flow];
  if (!sessionKey) throw new TypeError(`unknown Google OAuth flow: ${flow}`);
  return {
    clientID:     env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    callbackURL,
    state:        true,
    pkce:         true,
    sessionKey,
  };
}

module.exports = { googleStrategyOptions, SESSION_KEYS };
