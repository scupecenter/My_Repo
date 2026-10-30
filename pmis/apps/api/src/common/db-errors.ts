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
  [/departments_code_key|departments.*\(code\)|\(code\)=|roles_code_key|permission_profiles_code_key/i, '/code'],
  [/users_email_key|\(email\)|\bemail\b/i, '/email'],
  [/users_employee_id_key|\(employee_id\)|employee_id/i, '/employee_id'],
  [/users_phone_key|users_phone_e164|\(phone\)|\bphone\b/i, '/phone'],
];

function duplicateField(message: string): string | undefined {
  return FIELD_BY_CONSTRAINT.find(([re]) => re.test(message))?.[1];
}

const WF_RE = /wf:([a-z_]+):(\{.*\})/s;

/** Errors of the wf_* functions (migration 0015) arrive as P0001 with the message `wf:<code>:<json>`. */
export function mapWfError(message: string): ProblemException | null {
  const m = WF_RE.exec(message);
  if (!m) return null;
  let extra: Record<string, unknown> = {};
  try {
    extra = JSON.parse(m[2] as string) as Record<string, unknown>;
  } catch {
    /* no details */
  }
  const detail = typeof extra.detail === 'string' ? extra.detail : undefined;
  switch (m[1]) {
    case 'not_found':
      return new ProblemException(404, 'not_found', { detail: detail ?? 'The task does not exist or is not visible to you.' });
    case 'duplicate':
      return new ProblemException(409, 'duplicate', {
        detail: detail ?? 'It exists already.',
        extra: typeof extra.existing_id === 'string' ? { existing_id: extra.existing_id } : undefined,
      });
    case 'precondition_failed':
      return new ProblemException(412, 'precondition_failed', { detail: detail ?? 'The task changed since you read it. Reload and try again.' });
    case 'action_forbidden':
      return new ProblemException(403, 'action_forbidden', { detail: detail ?? 'You are not allowed to do this.' });
    case 'not_eligible_holder':
      return new ProblemException(403, 'not_eligible_holder', { detail: detail ?? 'You are not a holder of the level the task is at.' });
    case 'already_claimed':
      return new ProblemException(409, 'already_claimed', { detail: 'Another holder has claimed this level.', extra: { claimed_by: { id: extra.claimed_by } } });
    case 'invalid_transition':
      return new ProblemException(409, 'invalid_transition', { detail: detail ?? 'This is not possible in the current state.' });
    case 'note_required':
      return new ProblemException(422, 'note_required', { detail: 'A rejection needs a note.', errors: [{ path: '/note', code: 'required', message: 'A note is required.' }] });
    case 'mandatory_slots_missing':
    case 'mandatory_fields_missing':
      return new ProblemException(422, m[1], {
        detail: m[1] === 'mandatory_slots_missing' ? 'Mandatory document slots are missing.' : 'Mandatory fields are missing.',
        extra: { missing: Array.isArray(extra.missing) ? extra.missing : [] },
      });
    case 'open_snags':
      return new ProblemException(422, 'open_snags', {
        detail: `This acceptance cannot be submitted or approved while ${String(extra.count ?? 'some')} open ${typeof extra.scope === 'string' ? `${extra.scope} ` : ''}snag(s) remain on the site.`,
        extra: { count: Number(extra.count ?? 0), ...(typeof extra.scope === 'string' ? { scope: extra.scope } : {}) },
      });
    case 'empty_cell':
      return new ProblemException(422, 'empty_cell', {
        detail: detail ?? 'Every level in use needs at least one holder.',
        extra: { cells: Array.isArray(extra.cells) ? extra.cells : [] },
      });
    case 'step_up_required':
      return new ProblemException(401, 'step_up_required', { detail: 'Confirm your password to continue.', step_up_method: 'password' });
    case 'validation_failed':
      return new ProblemException(422, 'validation_failed', {
        detail: detail ?? 'The request is not valid.',
        errors: Array.isArray(extra.errors) ? (extra.errors as FieldError[]) : [],
      });
    default:
      return null;
  }
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
      // Delegation rules: only a System Admin delegates (a delegate may pass on only what the admin allowed, never wider).
      if (/can create a delegation|re-delegation needs|cannot delegate (wider|more|%)|cannot delegate \S+\.\S+ ?:|cannot outlive the parent|only a System Admin or the delegator/i.test(msg)) {
        return new ProblemException(403, 'delegate_forbidden', { detail: 'A delegate cannot delegate or revoke beyond what the System Admin allowed.' });
      }
      // Nobody changes their own rights: assigning to oneself, a profile that gives the actor rights, field rules that apply to the actor.
      if (/yourself|your own (assignments?|account|status|password|name)|own account|own status|own password|gives you rights|apply to you|role you hold/i.test(msg)) {
        return new ProblemException(403, 'self_beneficiary', { detail: 'You cannot do this to your own account or rights.' });
      }
      // "System Admin only", "no signed-in actor", "delegation covering ... required", "global scope" and so on.
      return new ProblemException(403, 'action_forbidden', { detail: 'You are not allowed to do this.' });
    }
    case '23505': {
      const path = duplicateField(msg);
      const errors: FieldError[] = path ? [{ path, code: 'duplicate', message: path === '/code' ? 'This code is already in use.' : 'Already used by another account.' }] : [];
      return new ProblemException(409, 'duplicate', { detail: path === '/code' ? 'The code is already in use.' : 'The value is already used by another account.', errors });
    }
    case '23514': {
      if (/is assigned or referenced/i.test(msg)) {
        return new ProblemException(409, 'role_in_use', { detail: 'The role is assigned or referenced: deactivate it instead of deleting.' });
      }
      if (/System Admin must remain/i.test(msg)) {
        return new ProblemException(409, 'last_admin', { detail: 'At least one active System Admin must remain.' });
      }
      // custom-field trigger (0007): `field "code": ...`, `field "code" is required`, `unknown custom field "code" on table`
      const cf = /(?:unknown custom field|field) "([^"]+)"([^\n]*)/i.exec(msg);
      if (cf) {
        return new ProblemException(422, 'validation_failed', {
          detail: 'A custom field value is not valid.',
          errors: [{ path: `/custom/${cf[1]}`, code: 'invalid', message: `${cf[1]}${(cf[2] ?? '').replace(/ on \w+$/, '')}`.trim() }],
        });
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
      const wf = mapWfError(msg);
      if (wf) return wf;
      // Messages of idm_set_user_org and ann_send (migration 0011).
      if (/manager loop|manager chain too deep/i.test(msg)) {
        return new ProblemException(422, 'validation_failed', {
          detail: 'This manager would create a loop in the reporting line.',
          errors: [{ path: '/manager_id', code: 'manager_loop', message: 'This manager would create a loop.' }],
        });
      }
      if (/manager must be an active/i.test(msg)) {
        return new ProblemException(422, 'validation_failed', {
          detail: 'The manager must be an active user.',
          errors: [{ path: '/manager_id', code: 'inactive', message: 'The manager must be an active user.' }],
        });
      }
      if (/department must exist and be active/i.test(msg)) {
        return new ProblemException(422, 'validation_failed', {
          detail: 'The department must exist and be active.',
          errors: [{ path: '/department_id', code: 'inactive', message: 'The department must exist and be active.' }],
        });
      }
      if (/no active recipient/i.test(msg)) {
        return new ProblemException(422, 'validation_failed', {
          detail: 'Nobody matches this audience.',
          errors: [{ path: '/audience', code: 'no_recipients', message: 'No active user matches this audience.' }],
        });
      }
      if (/already deleted|is not deleted/i.test(msg)) {
        return new ProblemException(409, 'invalid_transition', { detail: 'The user is already in that state.' });
      }
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
