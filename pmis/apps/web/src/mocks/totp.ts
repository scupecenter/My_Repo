// TOTP for the mock server (RFC 6238: SHA-1, 6 digits, 30 s, one step either side). Mock only: the real server does this in apps/api.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function b32encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function b32decode(s: string): Uint8Array {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/[\s=-]/g, '').toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) continue;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

export const stepOf = (ms: number) => Math.floor(ms / 30000);

/** The 6-digit code of one time step. */
export async function hotp(secretB32: string, step: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', b32decode(secretB32) as BufferSource, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(step));
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

/** The step whose code equals `code` (now, one before or one after), or null. */
export async function matchStep(secretB32: string, code: string, nowMs = Date.now()): Promise<number | null> {
  if (!/^[0-9]{6}$/.test(code)) return null;
  const now = stepOf(nowMs);
  for (const s of [now, now - 1, now + 1]) if ((await hotp(secretB32, s)) === code) return s;
  return null;
}

export function newSecret(): string {
  const b = new Uint8Array(20);
  crypto.getRandomValues(b);
  return b32encode(b);
}

const RC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newRecoveryCodes(): string[] {
  return Array.from({ length: 10 }, () => {
    const b = new Uint8Array(10);
    crypto.getRandomValues(b);
    const c = Array.from(b, (x) => RC[x % RC.length]).join('');
    return `${c.slice(0, 5)}-${c.slice(5)}`;
  });
}

export const otpauth = (secret: string, account: string) =>
  `otpauth://totp/GSDN%20Workspace:${encodeURIComponent(account)}?secret=${secret}&issuer=GSDN%20Workspace&algorithm=SHA1&digits=6&period=30`;

/** One-time enrolment code (contract 0.6.0): 8 characters, shown as XXXX-XXXX. Mock only: the real server keeps a keyed hash. */
export function newEnrolCode(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  const c = Array.from(b, (x) => RC[x % RC.length]).join('');
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}
export const normaliseEnrolCode = (raw: string) => raw.toUpperCase().replace(/[\s-]/g, '');
export const ENROL_CODE_MS = 72 * 3600_000;
