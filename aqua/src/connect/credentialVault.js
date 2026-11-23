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
export const IV_BYTES = 12;    // 96-bit GCM nonce, random per seal
export const TAG_BYTES = 16;   // full 128-bit GCM tag — never truncated

const STRICT_B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Decode one envelope field as canonical base64 of an exact length (or any
 * non-empty length when `bytes` is null). Anything else — wrong alphabet,
 * non-canonical padding, truncated, padded or oversized — is rejected before
 * decryption is attempted.
 */
function strictBase64(value, bytes, field) {
  if (typeof value !== 'string' || !value || !STRICT_B64.test(value)) {
    throw new CredentialVaultError('ENVELOPE_INVALID', `credential envelope field "${field}" is malformed`);
  }
  const buf = Buffer.from(value, 'base64');
  if (buf.toString('base64') !== value || (bytes != null ? buf.length !== bytes : buf.length === 0)) {
    throw new CredentialVaultError('ENVELOPE_INVALID', `credential envelope field "${field}" has the wrong length or encoding`);
  }
  return buf;
}

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

const keyIdOf = k => crypto.createHash('sha256').update(k).digest('hex').slice(0, 16);

/**
 * Previous keys (decrypt-only) from AQUA_CONNECTOR_PREVIOUS_KEYS: a comma- or
 * whitespace-separated list, each 32 bytes in base64 or hex. Any entry that
 * does not parse makes the WHOLE list invalid (KEY_INVALID) — a typo in a
 * rotation must not silently drop the key that opens half the credentials.
 */
export function parsePreviousConnectorKeys(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return [];
  return s.split(/[\s,]+/).filter(Boolean).map(part => {
    try { return parseConnectorKey(part); }
    catch { throw new CredentialVaultError('KEY_INVALID', `${PREVIOUS_KEYS_ENV} contains an entry that is not a 32-byte key`); }
  });
}
export const PREVIOUS_KEYS_ENV = 'AQUA_CONNECTOR_PREVIOUS_KEYS';

/**
 * KEY ROTATION (Phase 2A). A vault holds ONE current key and any number of
 * PREVIOUS keys:
 *   seal   always uses the current key;
 *   open   selects the key by the envelope's keyId (current or previous); a
 *          keyId the vault does not hold is KEY_MISMATCH, never guessed at;
 *   needsReseal(envelope)  true when the envelope was sealed by a previous key;
 *   reseal(envelope, binding)  open with the previous key, seal with the current.
 * The connect service reseals lazily on every use and on demand
 * (rotateCredentials). Procedure: set the new key as AQUA_CONNECTOR_KEY and the
 * old one in AQUA_CONNECTOR_PREVIOUS_KEYS, deploy, reseal, then remove the old
 * key. A previous key equal to the current one is ignored (no duplicate ids).
 *
 * @param {{ key?: Buffer|string, previousKeys?: Array<Buffer|string>, env?: object }} [opts]
 *        key: raw 32-byte Buffer (tests) or the env value; default reads
 *        process.env.AQUA_CONNECTOR_KEY. previousKeys default: AQUA_CONNECTOR_PREVIOUS_KEYS
 *        (only when `key` is not given explicitly).
 */
export function createCredentialVault({ key = null, previousKeys = null, env = process.env } = {}) {
  const k = Buffer.isBuffer(key) ? key : parseConnectorKey(key ?? env.AQUA_CONNECTOR_KEY);
  if (k.length !== 32) throw new CredentialVaultError('KEY_INVALID', 'key must be 32 bytes');
  const keyId = keyIdOf(k);
  const prevRaw = previousKeys ?? (key == null ? parsePreviousConnectorKeys(env.AQUA_CONNECTOR_PREVIOUS_KEYS) : []);
  const keyring = new Map([[keyId, k]]);   // keyId → key; the current key first
  for (const p of prevRaw) {
    const pk = Buffer.isBuffer(p) ? p : parseConnectorKey(p);
    if (pk.length !== 32) throw new CredentialVaultError('KEY_INVALID', 'previous key must be 32 bytes');
    const id = keyIdOf(pk);
    if (!keyring.has(id)) keyring.set(id, pk);
  }
  const previousKeyIds = Object.freeze([...keyring.keys()].filter(id => id !== keyId));

  function seal(credentials, binding) {
    if (credentials == null || typeof credentials !== 'object') throw new CredentialVaultError('CREDENTIALS_INVALID', 'credentials must be an object');
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALG, k, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(aadFor(binding));
    const ct = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
    return { v: 1, alg: ALG, keyId, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
  }

  function open(envelope, binding) {
    if (!envelope || envelope.v !== 1 || envelope.alg !== ALG) throw new CredentialVaultError('ENVELOPE_INVALID', 'unrecognised credential envelope');
    const openKey = typeof envelope.keyId === 'string' ? keyring.get(envelope.keyId) : undefined;
    if (!openKey) throw new CredentialVaultError('KEY_MISMATCH', 'credentials were sealed with a different key');
    // Decode strictly and check lengths BEFORE any
    // decryption. Node's GCM decipher otherwise accepts tags as short as 4
    // bytes (and any IV length), which would cut integrity to 32 bits.
    const iv = strictBase64(envelope.iv, IV_BYTES, 'iv');
    const tag = strictBase64(envelope.tag, TAG_BYTES, 'tag');
    const ct = strictBase64(envelope.ct, null, 'ct');
    try {
      const decipher = crypto.createDecipheriv(ALG, openKey, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(aadFor(binding));
      decipher.setAuthTag(tag);
      const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
      return JSON.parse(pt.toString('utf8'));
    } catch {
      // One message for every failure: wrong owner/connection, tampering, corruption.
      throw new CredentialVaultError('DECRYPT_FAILED', 'credentials could not be opened for this connection');
    }
  }

  /** Sealed under a key this vault still holds, but not the current one. */
  const needsReseal = envelope => Boolean(envelope && typeof envelope.keyId === 'string' && envelope.keyId !== keyId && keyring.has(envelope.keyId));

  /** Re-encrypt under the current key (same binding). Throws like open() when it cannot be opened. */
  function reseal(envelope, binding) { return seal(open(envelope, binding), binding); }

  return Object.freeze({ seal, open, keyId, previousKeyIds, needsReseal, reseal });
}

/**
 * A vault that holds NO key. Every seal/open fails with
 * `code` (KEY_MISSING / KEY_INVALID). It lets the connect service keep working
 * for the operations that do not need credentials — listing connections,
 * marking them reconnect-required, disconnecting and deleting knowledge —
 * when the key is absent, instead of refusing to start at all. It never
 * decrypts anything and never substitutes a key.
 */
export function createUnavailableVault(code = 'KEY_MISSING') {
  const fail = () => { throw new CredentialVaultError(code, 'the connector credential key is not available'); };
  return Object.freeze({ seal: fail, open: fail, reseal: fail, needsReseal: () => false, keyId: null, previousKeyIds: Object.freeze([]), unavailable: true, code });
}

/** The vault for a deployment: real when the key parses, otherwise an unavailable vault (never a fallback key). */
export function vaultFromEnv(env = process.env) {
  try {
    return createCredentialVault({ env });
  } catch (err) {
    if (err?.code === 'KEY_MISSING' || err?.code === 'KEY_INVALID') return createUnavailableVault(err.code);
    throw err;
  }
}

/** Vault errors that mean "these stored credentials can never be opened with what we have". */
export const UNREADABLE_CREDENTIAL_CODES = Object.freeze(['KEY_MISSING', 'KEY_INVALID', 'KEY_MISMATCH', 'DECRYPT_FAILED', 'ENVELOPE_INVALID']);
