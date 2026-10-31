import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import * as argon2 from 'argon2';
import { describe, expect, it } from 'vitest';
import { COMMON_PASSWORDS } from '../src/auth/common-passwords';
import { generateTemporaryPassword, passwordPolicyErrors } from '../src/auth/password.policy';
import { hashPassword, verifyPassword } from '../src/auth/password.service';
import { RateLimiter } from '../src/auth/rate-limiter';
import { normaliseIdentifier } from '../src/auth/auth.service';

// the argon2 library writes the parameters in the order m, p, t
const PHC = /^\$argon2id\$v=19\$m=65536,(p=1,t=3|t=3,p=1)\$/;
const ctx = { email: 'amira.salem@example.test', employeeId: '4821', phone: '+218911234567' };
const codes = (pw: string) => passwordPolicyErrors(pw, ctx, '/p').map((e) => e.code);

describe('password policy (ADR 0012 section 2)', () => {
  it('accepts a long unrelated passphrase', () => {
    expect(codes('Violet-Lantern-Harbour-77')).toEqual([]);
  });
  it('rejects fewer than 12 and more than 128 characters', () => {
    expect(codes('Short-1-Aa')).toContain('too_short');
    expect(codes('a'.repeat(129) + 'Q7!')).toContain('too_long');
    expect(codes('Qx7-' + 'b'.repeat(124))).not.toContain('too_long');
  });
  it('rejects the email local part, the employee ID and the phone number', () => {
    expect(codes('xx-Amira.Salem-yy-99')).toContain('contains_email');
    expect(codes('xx-4821-yy-Violet-Lantern')).toContain('contains_employee_id');
    expect(codes('call-218911234567-now')).toContain('contains_phone');
    expect(codes('call-+218 91 123 4567-now')).toContain('contains_phone');
  });
  it('rejects common passwords and their simple variants', () => {
    expect(COMMON_PASSWORDS.length).toBeGreaterThanOrEqual(300);
    expect(codes('Password123456')).toContain('common_password');
    expect(codes('P@ssw0rd-1234')).toContain('common_password');
    expect(codes('qwertyuiop123')).toContain('common_password');
    expect(codes('aaaaaaaaaaaaaa')).toContain('common_password');
    expect(codes('123456789012')).toContain('common_password');
  });
  it('does not apply the email rule to a very short local part', () => {
    expect(passwordPolicyErrors('Violet-Lantern-Harbour-77', { email: 'al@example.test' }, '/p')).toEqual([]);
  });
});

describe('temporary passwords', () => {
  it('are 16 characters from the unambiguous alphabet, random, and pass the policy', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = generateTemporaryPassword(ctx);
      expect(p).toHaveLength(16);
      expect(p).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789]{16}$/);
      expect(passwordPolicyErrors(p, ctx, '/p')).toEqual([]);
      seen.add(p);
    }
    expect(seen.size).toBe(200);
  });
});

describe('argon2id hashing', () => {
  it('uses argon2id with 64 MiB, 3 passes and 1 lane, and verifies', async () => {
    const h = await hashPassword('Violet-Lantern-Harbour-77');
    expect(h).toMatch(PHC);
    expect(await verifyPassword(h, 'Violet-Lantern-Harbour-77')).toBe(true);
    expect(await verifyPassword(h, 'Violet-Lantern-Harbour-78')).toBe(false);
    expect(await verifyPassword('not a hash', 'x')).toBe(false);
    expect((await argon2.verify(h, 'Violet-Lantern-Harbour-77'))).toBe(true);
  });
});

describe('rate limiter', () => {
  it('allows N per window, reports the wait, and forgets after the window', () => {
    const rl = new RateLimiter();
    let now = 1_000_000;
    rl.setClock({ now: () => now });
    for (let i = 0; i < 5; i++) expect(rl.hit('k', 5)).toBe(0);
    expect(rl.hit('k', 5)).toBeGreaterThan(0);
    expect(rl.hit('other', 5)).toBe(0);
    now += 30_000;
    expect(rl.hit('k', 5)).toBeGreaterThan(0);
    now += 31_000;
    expect(rl.hit('k', 5)).toBe(0);
  });
});

describe('identifier normalisation', () => {
  it('keeps IDs and emails and turns typed phones into E.164', () => {
    expect(normaliseIdentifier(' 4821 ')).toBe('4821');
    expect(normaliseIdentifier('A@B.test')).toBe('A@B.test');
    expect(normaliseIdentifier('+218 91 123 4567')).toBe('+218911234567');
    expect(normaliseIdentifier('00218911234567')).toBe('+218911234567');
  });
});

describe('cli hash-password', () => {
  const run = (input: string, env: Record<string, string> = {}) =>
    spawnSync(resolve(__dirname, '..', 'node_modules', '.bin', 'tsx'), ['src/cli.ts', 'hash-password'], {
      cwd: resolve(__dirname, '..'),
      input,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });

  it('prints an argon2id PHC hash for a good password (trailing newline ignored)', async () => {
    const r = run('Violet-Lantern-Harbour-77\n');
    expect(r.status).toBe(0);
    const hash = r.stdout.trim();
    expect(hash).toMatch(PHC);
    expect(await argon2.verify(hash, 'Violet-Lantern-Harbour-77')).toBe(true);
    expect(r.stderr).not.toContain('Violet');
  });
  it('exits 1 with a message for a weak password and prints no hash', () => {
    for (const weak of ['short', 'Password123456\n']) {
      const r = run(weak);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/not accepted/);
      expect(r.stderr).not.toContain(weak.trim());
    }
  });
});
