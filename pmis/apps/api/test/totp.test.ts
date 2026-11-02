import { describe, expect, it } from 'vitest';
import {
  base32Decode, base32Encode, decryptSecret, encryptSecret, generateEnrolCode, generateRecoveryCodes, hashEnrolCode, hashRecoveryCode, hotp, matchStep,
  normaliseEnrolCode, normaliseRecoveryCode, otpauthUri, parseEncKey, stepOf, totpCode,
} from '../src/auth/totp';

// RFC 6238 Appendix B, HMAC-SHA-1, secret "12345678901234567890" (ASCII), 8 digits.
const SECRET = Buffer.from('12345678901234567890', 'ascii');
const VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('RFC 6238 Appendix B (SHA-1)', () => {
  it.each(VECTORS)('time %i gives %s with 8 digits', (t, code) => {
    expect(totpCode(SECRET, t * 1000, 8)).toBe(code);
  });

  it.each(VECTORS)('time %i gives the last 6 digits of %s with 6 digits', (t, code) => {
    expect(totpCode(SECRET, t * 1000)).toBe(code.slice(2));
  });

  it('RFC 4226 Appendix D HOTP values for counters 0 to 9', () => {
    const want = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    want.forEach((w, i) => expect(hotp(SECRET, i)).toBe(w));
  });
});

describe('matchStep: 6 digits, 30 s, one step either side', () => {
  const t = 1111111111 * 1000;
  const step = stepOf(t);
  const at = (s: number) => hotp(SECRET, s);

  it('accepts the current step and one either side, and says which step matched', () => {
    expect(matchStep(SECRET, at(step), t)).toBe(step);
    expect(matchStep(SECRET, at(step - 1), t)).toBe(step - 1);
    expect(matchStep(SECRET, at(step + 1), t)).toBe(step + 1);
  });

  it('refuses two steps away, a wrong code and anything that is not 6 digits', () => {
    expect(matchStep(SECRET, at(step - 2), t)).toBeNull();
    expect(matchStep(SECRET, at(step + 2), t)).toBeNull();
    const wrong = ['000000', '111111'].find((c) => ![step - 1, step, step + 1].some((x) => at(x) === c))!;
    expect(matchStep(SECRET, wrong, t)).toBeNull();
    expect(matchStep(SECRET, `${at(step)}0`, t)).toBeNull();
    expect(matchStep(SECRET, at(step).slice(1), t)).toBeNull();
    expect(matchStep(SECRET, ' 123456', t)).toBeNull();
  });

  it('does not depend on the weekday or the machine clock: the time is an argument', () => {
    for (const day of [0, 1, 2, 3, 4, 5, 6]) {
      const now = Date.UTC(2026, 10, 1 + day, 12, 0, 0);
      expect(matchStep(SECRET, totpCode(SECRET, now), now)).toBe(stepOf(now));
    }
  });
});

describe('base32 and the otpauth URI', () => {
  it('round-trips and matches RFC 4648 test vectors', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
    expect(base32Decode('mzxw 6ytb-oi').toString()).toBe('foobar');
    const raw = Buffer.from(Array.from({ length: 20 }, (_, i) => i * 13));
    expect(base32Decode(base32Encode(raw))).toEqual(raw);
    expect(() => base32Decode('not*base32')).toThrow();
  });

  it('names the issuer "GSDN PMIS", SHA1, 6 digits and 30 seconds', () => {
    const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'ali.test@example.test');
    expect(uri).toBe('otpauth://totp/GSDN%20PMIS:ali.test%40example.test?secret=JBSWY3DPEHPK3PXP&issuer=GSDN%20PMIS&algorithm=SHA1&digits=6&period=30');
  });
});

describe('secret envelope and recovery codes', () => {
  const key = parseEncKey('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff')!;

  it('accepts a 32-byte key as 64 hex characters or as base64, and nothing else', () => {
    expect(key).toHaveLength(32);
    expect(parseEncKey(key.toString('base64'))).toEqual(key);
    expect(parseEncKey('short')).toBeNull();
    expect(parseEncKey('z'.repeat(64))).toBeNull();
    expect(parseEncKey('00'.repeat(31))).toBeNull();
  });

  it('encrypts with AES-256-GCM, a fresh IV each time, bound to the user id', () => {
    const a = encryptSecret(key, 'user-a', SECRET);
    const b = encryptSecret(key, 'user-a', SECRET);
    expect(a).toMatch(/^v1:[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
    expect(decryptSecret(key, 'user-a', a)).toEqual(SECRET);
    expect(() => decryptSecret(key, 'user-b', a)).toThrow(); // copied to another user's row
    expect(() => decryptSecret(Buffer.alloc(32, 1), 'user-a', a)).toThrow(); // another key
    const tampered = `${a.slice(0, -2)}${a.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(() => decryptSecret(key, 'user-a', tampered)).toThrow();
    expect(a).not.toContain(SECRET.toString('base64url'));
  });

  it('makes 10 distinct codes, normalises typing variants, and hashes them with a key', () => {
    const codes = generateRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    const c = codes[0]!;
    expect(normaliseRecoveryCode(c.toLowerCase())).toBe(c.replace('-', ''));
    expect(normaliseRecoveryCode(` ${c} `)).toBe(c.replace('-', ''));
    expect(normaliseRecoveryCode('short')).toBeNull();
    const h = hashRecoveryCode(key, c.replace('-', ''));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRecoveryCode(key, c.replace('-', ''))).toBe(h);
    expect(hashRecoveryCode(Buffer.alloc(32, 7), c.replace('-', ''))).not.toBe(h);
  });

  it('makes enrolment codes of 8 unambiguous characters shown as XXXX-XXXX, and normalises typing variants', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const c = generateEnrolCode();
      expect(c).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
      expect(c).not.toMatch(/[01IO]/);
      seen.add(c);
    }
    expect(seen.size).toBeGreaterThan(190);
    const c = generateEnrolCode();
    const bare = c.replace('-', '');
    expect(normaliseEnrolCode(c.toLowerCase())).toBe(bare);
    expect(normaliseEnrolCode(` ${bare.slice(0, 2)} ${bare.slice(2, 4)}-${bare.slice(4)} `)).toBe(bare);
    for (const bad of ['', 'short', 'AAAA-BBBBB', 'AAAA-BB0B', 'AAAA-BBIB', 'AAAA BB!B']) expect(normaliseEnrolCode(bad)).toBeNull();
    expect(normaliseEnrolCode('ABCDEFGHJ')).toBeNull(); // 9 characters
  });

  it('hashes an enrolment code with a key and the user id: another user, another key or another label gives another hash', () => {
    const u1 = '11111111-1111-4111-8111-111111111111';
    const u2 = '22222222-2222-4222-8222-222222222222';
    const h = hashEnrolCode(key, u1, 'ABCDEFGH');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashEnrolCode(key, u1, 'ABCDEFGH')).toBe(h);
    expect(hashEnrolCode(key, u1.toUpperCase(), 'ABCDEFGH')).toBe(h);
    expect(hashEnrolCode(key, u2, 'ABCDEFGH')).not.toBe(h); // the code of one user is nothing for another
    expect(hashEnrolCode(Buffer.alloc(32, 7), u1, 'ABCDEFGH')).not.toBe(h);
    expect(hashEnrolCode(key, u1, 'ABCDEFGJ')).not.toBe(h);
    expect(hashEnrolCode(key, u1, null)).not.toBe(h);
    expect(hashEnrolCode(key, u1, 'ABCDEFGH')).not.toBe(hashRecoveryCode(key, 'ABCDEFGH')); // not the recovery-code key
  });
});
