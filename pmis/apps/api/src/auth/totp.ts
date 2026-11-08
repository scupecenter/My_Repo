import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238) with HMAC-SHA-1, 6 digits, 30 seconds, one step of tolerance either side (ADR 0014).
 * Pure functions only: no database, no clock of their own (the caller passes the time).
 */
export const TOTP_PERIOD_S = 30;
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW = 1;
export const TOTP_ISSUER = 'GSDN Workspace';
export const RECOVERY_CODE_COUNT = 10;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('not base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 4226 HOTP value for a counter (the time step). */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const off = h[h.length - 1]! & 0x0f;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const stepOf = (nowMs: number, period = TOTP_PERIOD_S): number => Math.floor(nowMs / 1000 / period);

export function totpCode(secret: Buffer, nowMs: number, digits = TOTP_DIGITS, period = TOTP_PERIOD_S): string {
  return hotp(secret, stepOf(nowMs, period), digits);
}

const constEq = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * The time step whose code equals `code`, looking one step back and one forward, or null. Every candidate is compared (no early exit)
 * so the timing does not say which step matched. Replay (a step already used) is decided by the database, not here.
 */
export function matchStep(secret: Buffer, code: string, nowMs: number): number | null {
  if (!/^[0-9]{6}$/.test(code)) return null;
  const now = stepOf(nowMs);
  let found: number | null = null;
  for (let s = now - TOTP_WINDOW; s <= now + TOTP_WINDOW; s++) {
    if (constEq(hotp(secret, s), code) && found === null) found = s;
  }
  return found;
}

export const generateSecret = (): Buffer => randomBytes(20);

export function otpauthUri(secretBase32: string, account: string): string {
  const label = `${encodeURIComponent(TOTP_ISSUER)}:${encodeURIComponent(account)}`;
  const q = new URLSearchParams({ secret: secretBase32, issuer: TOTP_ISSUER, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_PERIOD_S) });
  return `otpauth://totp/${label}?${q.toString().replace(/\+/g, '%20')}`;
}

/** TOTP_ENC_KEY: 32 bytes as 64 hex characters or as base64. Null when it is neither. */
export function parseEncKey(raw: string): Buffer | null {
  const s = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, 'hex');
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(s)) {
    const b = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (b.length === 32) return b;
  }
  return null;
}

/**
 * AES-256-GCM envelope `v1:<base64url(iv | tag | ciphertext)>`. The user id is authenticated data, so a ciphertext copied from one
 * user's row to another's does not decrypt.
 */
export function encryptSecret(key: Buffer, userId: string, secret: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(userId));
  const ct = Buffer.concat([c.update(secret), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url')}`;
}

export function decryptSecret(key: Buffer, userId: string, envelope: string): Buffer {
  if (!envelope.startsWith('v1:')) throw new Error('unknown envelope');
  const raw = Buffer.from(envelope.slice(3), 'base64url');
  if (raw.length < 12 + 16 + 1) throw new Error('short envelope');
  const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12), { authTagLength: 16 });
  d.setAAD(Buffer.from(userId));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]);
}

// Recovery codes: 10 characters from a 32-letter alphabet without look-alikes (50 bits), shown as XXXXX-XXXXX.
const RC_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateRecoveryCodes(n = RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < n) {
    let c = '';
    for (let i = 0; i < 10; i++) c += RC_ALPHABET[randomInt(RC_ALPHABET.length)];
    codes.add(`${c.slice(0, 5)}-${c.slice(5)}`);
  }
  return [...codes];
}

/** Upper case, no separators; null when it cannot be a recovery code. */
export function normaliseRecoveryCode(raw: string): string | null {
  const c = raw.toUpperCase().replace(/[\s-]/g, '');
  return /^[A-Z2-9]{10}$/.test(c) ? c : null;
}

/** Keyed hash of a recovery code (HMAC-SHA-256 with a key derived from TOTP_ENC_KEY): a leaked table cannot be brute-forced offline. */
export function hashRecoveryCode(encKey: Buffer, code: string): string {
  const key = Buffer.from(hkdfSync('sha256', encKey, Buffer.alloc(0), 'pmis-recovery-codes', 32));
  return createHmac('sha256', key).update(code).digest('hex');
}

// Enrolment codes (ADR 0014 amendment): 8 characters from the same 32-letter alphabet (40 bits), shown as XXXX-XXXX. An admin hands one to
// a user who has not enrolled yet; without it the password alone cannot put a phone on the account.
export const ENROL_CODE_LENGTH = 8;

export function generateEnrolCode(): string {
  let c = '';
  for (let i = 0; i < ENROL_CODE_LENGTH; i++) c += RC_ALPHABET[randomInt(RC_ALPHABET.length)];
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

/** Upper case, no spaces or dashes; null when it cannot be an enrolment code. */
export function normaliseEnrolCode(raw: string): string | null {
  const c = raw.toUpperCase().replace(/[\s-]/g, '');
  return new RegExp(`^[${RC_ALPHABET}]{${ENROL_CODE_LENGTH}}$`).test(c) ? c : null;
}

/**
 * Keyed hash of an enrolment code: HMAC-SHA-256 over "<user id>:<code>" with a key derived from TOTP_ENC_KEY (its own HKDF label, so it
 * is not the recovery-code key). The user id is part of the input: the code of one user never matches another user. The database stores and
 * compares only this hash. A text that is not a well-formed code still gets a hash (of a fixed word), so the database counts the miss.
 */
export function hashEnrolCode(encKey: Buffer, userId: string, code: string | null): string {
  const key = Buffer.from(hkdfSync('sha256', encKey, Buffer.alloc(0), 'pmis-enrol-codes', 32));
  return createHmac('sha256', key).update(`${userId.toLowerCase()}:${code ?? 'not-a-code'}`).digest('hex');
}
