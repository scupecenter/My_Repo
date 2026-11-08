import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Transform } from 'node:stream';

/**
 * Encryption at rest for stored files (ADR 0008 amendment 2026-11-02, owner answer Q134).
 *
 * Envelope scheme. Each object gets a random 32-byte data key and a random 12-byte nonce. The content is encrypted with AES-256-GCM
 * under the data key, streamed (the ciphertext is as long as the plaintext). The data key is wrapped with a master key (AES-256-GCM,
 * 12-byte iv | 16-byte tag | 32-byte key = 60 bytes). The wrapped key, its master key id, the nonce, the GCM tag and the SHA-256 of the
 * plaintext are kept in `stored_object_meta` (migration 0048). The master keys never reach the database.
 *
 * Master keys: FILE_ENC_KEY is the active key (64 hex characters or base64, 32 bytes), its id is FILE_ENC_KEY_ID (default `k1`).
 * FILE_ENC_OLD_KEYS keeps the earlier keys while data keys are rewrapped: `id:key,id:key`. The id is stored with each object.
 */

export const DATA_KEY_BYTES = 32;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
export const WRAPPED_KEY_BYTES = NONCE_BYTES + TAG_BYTES + DATA_KEY_BYTES;
const WRAP_AAD = Buffer.from('pmis-file-data-key-v1');
const KEY_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

export interface MasterKeys {
  readonly activeId: string;
  readonly keys: ReadonlyMap<string, Buffer>;
}

function decodeKey(raw: string): Buffer | null {
  const s = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, 'hex');
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(s)) {
    const b = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (b.length === DATA_KEY_BYTES) return b;
  }
  return null;
}

/** Reads FILE_ENC_KEY, FILE_ENC_KEY_ID and FILE_ENC_OLD_KEYS. Throws a readable error when a key is malformed or an id is repeated. */
export function parseMasterKeys(env: { FILE_ENC_KEY?: string; FILE_ENC_KEY_ID?: string; FILE_ENC_OLD_KEYS?: string }): MasterKeys {
  const activeId = (env.FILE_ENC_KEY_ID ?? '').trim() || 'k1';
  if (!KEY_ID_RE.test(activeId)) throw new Error('FILE_ENC_KEY_ID may contain letters, digits, _ and - only (1 to 40 characters)');
  const active = decodeKey(env.FILE_ENC_KEY ?? '');
  if (!active) throw new Error('FILE_ENC_KEY must be 32 bytes: 64 hex characters (openssl rand -hex 32) or base64');
  const keys = new Map<string, Buffer>([[activeId, active]]);
  for (const part of (env.FILE_ENC_OLD_KEYS ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const i = part.indexOf(':');
    const id = part.slice(0, i).trim();
    const key = i > 0 ? decodeKey(part.slice(i + 1)) : null;
    if (!KEY_ID_RE.test(id) || !key) throw new Error('FILE_ENC_OLD_KEYS must look like id:key,id:key (each key 32 bytes)');
    if (keys.has(id)) throw new Error(`FILE_ENC_OLD_KEYS repeats the key id ${id}`);
    keys.set(id, key);
  }
  return { activeId, keys };
}

/** A fresh data key wrapped under the master key: iv | tag | ciphertext (60 bytes). */
export function wrapDataKey(master: Buffer, dataKey: Buffer): Buffer {
  const iv = randomBytes(NONCE_BYTES);
  const c = createCipheriv('aes-256-gcm', master, iv);
  c.setAAD(WRAP_AAD);
  const ct = Buffer.concat([c.update(dataKey), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

export function unwrapDataKey(master: Buffer, wrapped: Buffer): Buffer {
  if (wrapped.length !== WRAPPED_KEY_BYTES) throw new Error('wrapped data key has the wrong size');
  const d = createDecipheriv('aes-256-gcm', master, wrapped.subarray(0, NONCE_BYTES), { authTagLength: TAG_BYTES });
  d.setAAD(WRAP_AAD);
  d.setAuthTag(wrapped.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
  return Buffer.concat([d.update(wrapped.subarray(NONCE_BYTES + TAG_BYTES)), d.final()]);
}

export function newDataKey(): { dataKey: Buffer; nonce: Buffer } {
  return { dataKey: randomBytes(DATA_KEY_BYTES), nonce: randomBytes(NONCE_BYTES) };
}

/** Streaming AES-256-GCM encryption. `tag()` is valid once the stream has ended (the flush has run). */
export class GcmEncryptor {
  private readonly cipher;
  private computed: Buffer | null = null;
  readonly stream: Transform;
  constructor(dataKey: Buffer, nonce: Buffer) {
    this.cipher = createCipheriv('aes-256-gcm', dataKey, nonce);
    const c = this.cipher;
    this.stream = new Transform({
      transform: (chunk: Buffer, _enc, cb) => {
        try {
          cb(null, c.update(chunk));
        } catch (e) {
          cb(e as Error);
        }
      },
      flush: (cb) => {
        try {
          const last = c.final();
          this.computed = c.getAuthTag();
          cb(null, last);
        } catch (e) {
          cb(e as Error);
        }
      },
    });
  }
  tag(): Buffer {
    if (!this.computed) throw new Error('the stream has not ended');
    return this.computed;
  }
}

/** Streaming AES-256-GCM decryption. The tag is checked at the end: a changed byte makes the stream fail (an error event). */
export function gcmDecryptStream(dataKey: Buffer, nonce: Buffer, tag: Buffer): Transform {
  const d = createDecipheriv('aes-256-gcm', dataKey, nonce, { authTagLength: TAG_BYTES });
  d.setAuthTag(tag);
  return new Transform({
    transform: (chunk: Buffer, _enc, cb) => {
      try {
        cb(null, d.update(chunk));
      } catch (e) {
        cb(e as Error);
      }
    },
    flush: (cb) => {
      try {
        cb(null, d.final());
      } catch {
        cb(new Error('the stored file failed its integrity check'));
      }
    },
  });
}

/** Passes the bytes through and hashes them (the SHA-256 of the plaintext). `digest()` after the end. */
export class Sha256Tap {
  private readonly h = createHash('sha256');
  private done: string | null = null;
  readonly stream = new Transform({
    transform: (chunk: Buffer, _enc, cb) => {
      this.h.update(chunk);
      cb(null, chunk);
    },
    flush: (cb) => {
      this.done = this.h.digest('hex');
      cb();
    },
  });
  digest(): string {
    if (!this.done) throw new Error('the stream has not ended');
    return this.done;
  }
}

export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
