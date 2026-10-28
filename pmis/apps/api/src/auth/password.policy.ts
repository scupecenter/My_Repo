import { randomInt } from 'node:crypto';
import type { FieldError } from '../common/problem';
import { COMMON_PASSWORDS } from './common-passwords';

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

const COMMON = new Set(COMMON_PASSWORDS);

export interface PolicyContext {
  email?: string | null;
  employeeId?: string | null;
  phone?: string | null;
}

const normalise = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The password policy of ADR 0012 section 2 and the contract (POST /auth/local/password).
 * Returns the rules that fail (empty = acceptable). "Not the current password" is checked by the caller, who holds the hash.
 * The email local part is checked from 3 characters up: a one- or two-letter local part would reject nearly every password.
 */
export function passwordPolicyErrors(password: string, ctx: PolicyContext, path: string): FieldError[] {
  const errors: FieldError[] = [];
  const len = [...password].length;
  if (len < PASSWORD_MIN) errors.push({ path, code: 'too_short', message: `Use at least ${PASSWORD_MIN} characters.` });
  if (len > PASSWORD_MAX) errors.push({ path, code: 'too_long', message: `Use at most ${PASSWORD_MAX} characters.` });

  const lower = password.toLowerCase();
  const local = ctx.email ? (ctx.email.split('@')[0] ?? '').toLowerCase() : '';
  if (local.length >= 3 && lower.includes(local)) {
    errors.push({ path, code: 'contains_email', message: 'The password must not contain your email name.' });
  }
  if (ctx.employeeId && password.includes(ctx.employeeId)) {
    errors.push({ path, code: 'contains_employee_id', message: 'The password must not contain your employee ID.' });
  }
  if (ctx.phone) {
    const digits = ctx.phone.replace(/\D/g, '');
    if (digits && password.replace(/\D/g, '').includes(digits)) {
      errors.push({ path, code: 'contains_phone', message: 'The password must not contain your phone number.' });
    }
  }
  const n = normalise(password);
  if (COMMON.has(n) || /^(.)\1+$/.test(n)) {
    errors.push({ path, code: 'common_password', message: 'This password is too common.' });
  }
  return errors;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'; // no 0 O 1 l I
export const TEMP_PASSWORD_LENGTH = 16;

/** 16 characters from an unambiguous alphabet, crypto-random, with at least one upper case, lower case and digit. */
export function generateTemporaryPassword(ctx: PolicyContext = {}): string {
  for (;;) {
    let out = '';
    for (let i = 0; i < TEMP_PASSWORD_LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)];
    if (/[A-Z]/.test(out) && /[a-z]/.test(out) && /[2-9]/.test(out) && passwordPolicyErrors(out, ctx, '/').length === 0) return out;
  }
}
