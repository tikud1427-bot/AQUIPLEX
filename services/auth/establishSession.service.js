"use strict";
/**
 * Sign a user into the request's session — on a FRESH session id.
 *
 * THE GAP THIS CLOSES (session fixation)
 * --------------------------------------
 * The CSRF middleware issues its token into the session on the first page
 * view, so /login and /signup always run on a session that already exists and
 * whose id the browser already holds. /login and /signup then wrote the user
 * id into THAT session: whoever planted or learned the pre-login id was signed
 * in as the victim. The Google paths never had this problem — Passport's
 * req.login() regenerates the session — so only the email paths change.
 *
 * Everything in the pre-login session is dropped on purpose (including its
 * CSRF token; the next page view issues a new one). Callers that need a
 * pre-login value, such as the post-login redirect, read it BEFORE calling.
 */

function sessionIdentity(user) {
  return { _id: user._id, email: user.email, username: user.email.split("@")[0] };
}

/**
 * @param {import('express').Request} req
 * @param {{ _id: unknown, email: string }} user
 * @returns {Promise<void>} resolves once the new session is saved
 */
function establishSession(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.user   = sessionIdentity(user);
      req.session.userId = user._id;
      req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve()));
    });
  });
}

module.exports = { establishSession, sessionIdentity };
