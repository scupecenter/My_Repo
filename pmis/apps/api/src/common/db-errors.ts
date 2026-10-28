import { Prisma } from '@prisma/client';
import { ProblemException, FieldError } from './problem';

interface PgInfo {
  sqlstate?: string;
  message: string;
}

/** Pulls the PostgreSQL SQLSTATE and message out of the shapes Prisma wraps them in. */
export function pgInfo(e: unknown): PgInfo | null {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = (e.meta ?? {}) as { code?: unknown; message?: unknown; target?: unknown };
    const message = typeof meta.message === 'string' ? meta.message : e.message;
    let sqlstate = typeof meta.code === 'string' && /^[0-9A-Z]{5}$/.test(meta.code) ? meta.code : undefined;
    if (!sqlstate && e.code === 'P2002') sqlstate = '23505';
    if (!sqlstate) {
      const m = /SQLSTATE[^0-9A-Z]*([0-9A-Z]{5})/.exec(e.message) ?? /code: "([0-9A-Z]{5})"/.exec(e.message);
      sqlstate = m?.[1];
    }
    const target = Array.isArray(meta.target) ? meta.target.join(',') : typeof meta.target === 'string' ? meta.target : '';
    return { sqlstate, message: `${message} ${target}`.trim() };
  }
  if (e instanceof Prisma.PrismaClientUnknownRequestError) {
    const m = /SQLSTATE[^0-9A-Z]*([0-9A-Z]{5})/.exec(e.message) ?? /code: "([0-9A-Z]{5})"/.exec(e.message);
    return { sqlstate: m?.[1], message: e.message };
  }
  return null;
}

const FIELD_BY_CONSTRAINT: [RegExp, string][] = [
  [/users_email_key|\(email\)|\bemail\b/i, '/email'],
  [/users_employee_id_key|\(employee_id\)|employee_id/i, '/employee_id'],
  [/users_phone_key|users_phone_e164|\(phone\)|\bphone\b/i, '/phone'],
];

function duplicateField(message: string): string | undefined {
  return FIELD_BY_CONSTRAINT.find(([re]) => re.test(message))?.[1];
}

/**
 * Maps a PostgreSQL error raised by an idm_* / auth_local_* function (or a constraint) to a problem.
 * Returns null when the error is not one we know how to describe (the caller answers 500).
 */
export function mapDbError(e: unknown): ProblemException | null {
  const info = pgInfo(e);
  if (!info) return null;
  const msg = info.message;
  switch (info.sqlstate) {
    case '42501': {
      if (/yourself|your own|own account|own status|own password/i.test(msg)) {
        return new ProblemException(403, 'self_beneficiary', { detail: 'You cannot do this to your own account.' });
      }
      // "System Admin only", "no signed-in actor", "delegation covering ... required", "global scope" and so on.
      return new ProblemException(403, 'action_forbidden', { detail: 'You are not allowed to do this.' });
    }
    case '23505': {
      const path = duplicateField(msg);
      const errors: FieldError[] = path ? [{ path, code: 'duplicate', message: 'Already used by another account.' }] : [];
      return new ProblemException(409, 'duplicate', { detail: 'The value is already used by another account.', errors });
    }
    case '23514': {
      if (/System Admin must remain/i.test(msg)) {
        return new ProblemException(409, 'last_admin', { detail: 'At least one active System Admin must remain.' });
      }
      const path = duplicateField(msg);
      return new ProblemException(422, 'validation_failed', {
        detail: 'A value is not allowed.',
        errors: path ? [{ path, code: 'invalid', message: 'This value is not valid.' }] : [],
      });
    }
    case '23503':
      return new ProblemException(409, 'invalid_transition', { detail: 'The change conflicts with related data.' });
    case 'P0001': {
      if (/not found/i.test(msg)) return new ProblemException(404, 'not_found', { detail: 'The resource does not exist.' });
      if (/at least one active System Admin/i.test(msg)) return new ProblemException(409, 'last_admin', { detail: 'At least one active System Admin must remain.' });
      return new ProblemException(422, 'validation_failed', { detail: 'The request is not valid.' });
    }
    case '22P02': // invalid text representation (for example a bad uuid)
    case '22001': // value too long
      return new ProblemException(422, 'validation_failed', { detail: 'A value has the wrong format.' });
    default:
      return null;
  }
}
