import crypto from 'node:crypto';

/**
 * Pairing is an X25519 exchange with a commitment and a short code both screens show (as Bluetooth numeric
 * comparison does). After that, every request between the two devices is AES-256-GCM under the pair key.
 * Everything here is node:crypto.
 */

const SPKI_X25519_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export interface KeyPair {
  privateKey: crypto.KeyObject;
  /** Raw 32-byte public key, base64. */
  publicKey: string;
}

export function newKeyPair(): KeyPair {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return { privateKey, publicKey: der.subarray(der.length - 32).toString('base64') };
}

function importPublic(raw: string): crypto.KeyObject {
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length !== 32) throw new Error('bad public key');
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_X25519_PREFIX, bytes]), format: 'der', type: 'spki' });
}

export const randomNonce = () => crypto.randomBytes(16).toString('base64');

const sha256 = (...parts: string[]) => {
  const hash = crypto.createHash('sha256');
  for (const part of parts) hash.update(part).update('\0');
  return hash.digest();
};

/** What the initiator sends first, so it cannot pick its key after seeing the responder's. */
export const commitment = (publicKey: string, nonce: string) => sha256('telepathy-pair-commit', publicKey, nonce).toString('base64');

export interface PairTranscript {
  initiatorId: string;
  responderId: string;
  initiatorKey: string;
  responderKey: string;
  initiatorNonce: string;
  responderNonce: string;
}

const transcriptParts = (t: PairTranscript) => [
  t.initiatorId,
  t.responderId,
  t.initiatorKey,
  t.responderKey,
  t.initiatorNonce,
  t.responderNonce,
];

/** The six digits both screens show. A man in the middle has one try in a million to match them. */
export function shortCode(t: PairTranscript): string {
  const digest = sha256('telepathy-pair-code', ...transcriptParts(t));
  const n = digest.readUInt32BE(0) % 1_000_000;
  const digits = n.toString().padStart(6, '0');
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

/** The pair key both sides derive. Base64, 32 bytes. */
export function pairKey(own: KeyPair, otherPublic: string, t: PairTranscript): string {
  const shared = crypto.diffieHellman({ privateKey: own.privateKey, publicKey: importPublic(otherPublic) });
  const salt = sha256('telepathy-pair-salt', ...transcriptParts(t));
  return Buffer.from(crypto.hkdfSync('sha256', shared, salt, 'telepathy-bridge-v1', 32)).toString('base64');
}

/** Proof that a side holds the key and its user said yes. */
export const confirmMac = (key: string, role: 'initiator' | 'responder') =>
  crypto.createHmac('sha256', Buffer.from(key, 'base64')).update(`telepathy-pair-confirm:${role}`).digest('base64');

export function macEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'base64');
  const y = Buffer.from(b, 'base64');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export interface Sealed {
  /** Sender's epoch ms. */
  t: number;
  /** base64 12-byte IV, unique per message. */
  n: string;
  /** base64 ciphertext with the 16-byte tag appended. */
  c: string;
}

export function seal(key: string, aad: string, value: unknown, t = Date.now()): Sealed {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv);
  cipher.setAAD(Buffer.from(`${aad}\0${t}`));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { t, n: iv.toString('base64'), c: body.toString('base64') };
}

/** Opens a sealed value, or throws. The caller checks `t` for freshness and `n` for replay. */
export function open<T>(key: string, aad: string, sealed: Sealed): T {
  const iv = Buffer.from(String(sealed.n), 'base64');
  const data = Buffer.from(String(sealed.c), 'base64');
  if (iv.length !== 12 || data.length < 16) throw new Error('bad envelope');
  // Base64 decoding ignores whitespace and padding variants; the replay cache keys on `n`, so it must be canonical.
  if (iv.toString('base64') !== sealed.n) throw new Error('bad envelope');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv);
  decipher.setAAD(Buffer.from(`${aad}\0${sealed.t}`));
  decipher.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
  return JSON.parse(plain.toString('utf8')) as T;
}
