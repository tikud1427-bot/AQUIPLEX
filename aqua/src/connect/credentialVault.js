/**
 * AQUA Connect — credential vault (Phase 1b)
 *
 * Connector credentials (access/refresh tokens, API keys) are sealed with
 * AES-256-GCM (node:crypto, no dependency) before they are stored, and opened
 * only inside the connect engine, only for the connection they belong to.
 *
 *   key        32 bytes from AQUA_CONNECTOR_KEY (base64 or 64 hex chars).
 *              There is NO fallback key: without a valid key the vault cannot
 *              be created and connecting fails closed. Generate with
 *              `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
 *   AAD        "aqua-connect-v1|<ownerId>|<connectionId>|<connectorId>" — a
 *              ciphertext copied into another user's or another connection's
 *              record does not decrypt (GCM authentication fails).
 *   keyId      first 16 hex chars of sha256(key), stored beside the ciphertext
 *              so a future rotation can tell which key sealed a record. A record
 *              sealed under a different key is refused, never guessed at.
 *   envelope   { v: 1, alg: 'aes-256-gcm', keyId, iv, tag, ct }  (base64 fields)
 *
 * What never happens: plaintext credentials in a store, a log line, an error
 * message, a status object, a prompt, or engine JSON data files.
 */
import crypto from 'node:crypto';

export const CONNECTOR_KEY_ENV = 'AQUA_CONNECTOR_KEY';
const ALG = 'aes-256-gcm';

export class CredentialVaultError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Parse a 32-byte key from base64 or hex. Throws — never substitutes a default. */
export function parseConnectorKey(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) throw new CredentialVaultError('KEY_MISSING', `${CONNECTOR_KEY_ENV} is not set; connector credentials cannot be stored`);
  let key = null;
  if (/^[0-9a-f]{64}$/i.test(s)) key = Buffer.from(s, 'hex');
  else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) key = Buffer.from(s, 'base64');
  if (!key || key.length !== 32) throw new CredentialVaultError('KEY_INVALID', `${CONNECTOR_KEY_ENV} must be 32 bytes (base64 or 64 hex chars)`);
  if (key.every(b => b === key[0])) throw new CredentialVaultError('KEY_INVALID', `${CONNECTOR_KEY_ENV} is not random (all bytes equal)`);
  return key;
}

const aadFor = ({ ownerId, connectionId, connectorId }) => {
  for (const [k, v] of Object.entries({ ownerId, connectionId, connectorId })) {
    if (typeof v !== 'string' || !v) throw new CredentialVaultError('AAD_INVALID', `credential binding requires ${k}`);
  }
  return Buffer.from(`aqua-connect-v1|${ownerId}|${connectionId}|${connectorId}`, 'utf8');
};

/**
 * @param {{ key?: Buffer|string, env?: object }} [opts]  key: raw 32-byte Buffer (tests) or
 *        the env value; default reads process.env.AQUA_CONNECTOR_KEY.
 */
export function createCredentialVault({ key = null, env = process.env } = {}) {
  const k = Buffer.isBuffer(key) ? key : parseConnectorKey(key ?? env.AQUA_CONNECTOR_KEY);
  if (k.length !== 32) throw new CredentialVaultError('KEY_INVALID', 'key must be 32 bytes');
  const keyId = crypto.createHash('sha256').update(k).digest('hex').slice(0, 16);

  function seal(credentials, binding) {
    if (credentials == null || typeof credentials !== 'object') throw new CredentialVaultError('CREDENTIALS_INVALID', 'credentials must be an object');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALG, k, iv);
    cipher.setAAD(aadFor(binding));
    const ct = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
    return { v: 1, alg: ALG, keyId, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
  }

  function open(envelope, binding) {
    if (!envelope || envelope.v !== 1 || envelope.alg !== ALG) throw new CredentialVaultError('ENVELOPE_INVALID', 'unrecognised credential envelope');
    if (envelope.keyId !== keyId) throw new CredentialVaultError('KEY_MISMATCH', 'credentials were sealed with a different key');
    try {
      const decipher = crypto.createDecipheriv(ALG, k, Buffer.from(envelope.iv, 'base64'));
      decipher.setAAD(aadFor(binding));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const pt = Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]);
      return JSON.parse(pt.toString('utf8'));
    } catch {
      // One message for every failure: wrong owner/connection, tampering, corruption.
      throw new CredentialVaultError('DECRYPT_FAILED', 'credentials could not be opened for this connection');
    }
  }

  return Object.freeze({ seal, open, keyId });
}
