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
    case 'self_approval_forbidden':
      // D230b (migration 0056): the raiser, finder or fixer of a QC snag may not approve its closure
      return new ProblemException(403, 'self_approval_forbidden', { detail: detail ?? 'You may not approve this yourself.' });
    case 'document_rule_pending':
      // Q226 (migration 0056): a conditional document whose rule cannot be decided yet blocks the approval
      return new ProblemException(422, 'document_rule_pending', {
        detail: detail ?? 'A document rule cannot be decided yet.',
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
    case 'insufficient_stock':
    case 'item_in_use':
      return new ProblemException(422, m[1], {
        detail: detail ?? (m[1] === 'item_in_use' ? 'The item is in use.' : 'Not enough stock.'),
        errors: Array.isArray(extra.errors) ? (extra.errors as FieldError[]) : [],
      });
    case 'template_rejected':
      return new ProblemException(422, 'template_rejected', {
        detail: detail ?? 'This file is not an approved template.',
        extra: typeof extra.reason === 'string' ? { reason: extra.reason } : undefined,
        commit: true,
      });
    case 'team_scope_mismatch':
      // Q97 (migration 0043): the team's specialization does not match the Procurement order scope in the Settings match table
      return new ProblemException(422, 'team_scope_mismatch', {
        detail: detail ?? 'The team does not match the order scope.',
        errors: Array.isArray(extra.errors) ? (extra.errors as FieldError[]) : [],
        extra: { order_scope: typeof extra.scope === 'string' ? extra.scope : null, team_specialization: typeof extra.specialization === 'string' ? extra.specialization : null },
      });
    case 'scope_scenario_conflict':
      // Q3 (migration 0052): the scenario makes a task N/A while the scope flags say the work exists; review before the scope is applied
      return new ProblemException(422, 'scope_scenario_conflict', {
        detail: detail ?? 'The scenario and the scope flags disagree.',
        extra: { conflicts: Array.isArray(extra.conflicts) ? extra.conflicts : [] },
      });
    case 'list_not_configured':
      // 0057 (Q104): a critical list of the register has no active value yet; approval waits for the System Admin
      return new ProblemException(422, 'list_not_configured', {
        detail: detail ?? 'A critical list of this register has no value yet.',
        extra: { lists: Array.isArray(extra.lists) ? extra.lists : [] },
      });
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
      // Self-service (0044): an admin enforces two-factor; an admin-owned profile field; a step-up the database re-checks.
      if (/two_factor_enforced/.test(msg)) {
        return new ProblemException(403, 'two_factor_enforced', { detail: 'An administrator enforces two-factor on your account, so you cannot turn it off. Ask an administrator.' });
      }
      if (/cannot be changed on your own account/i.test(msg)) {
        return new ProblemException(403, 'field_read_only', { detail: 'This field is managed by an administrator.' });
      }
      if (/fresh step-up of this session/i.test(msg)) {
        return new ProblemException(401, 'step_up_required', { detail: 'Confirm your password to continue.', step_up_method: 'password' });
      }
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
      // Self-service (0044)
      if (/two-factor is already on for this account/i.test(msg)) return new ProblemException(409, 'invalid_transition', { detail: 'Two-factor is already on for your account.' });
      if (/two-factor is not on for your account/i.test(msg)) return new ProblemException(409, 'invalid_transition', { detail: 'Two-factor is not on for your account.' });
      if (/two-factor is off for this user: turn it on first/i.test(msg)) return new ProblemException(409, 'invalid_transition', { detail: 'Two-factor is off for this user: turn it on first.' });
      if (/an email change is already pending/i.test(msg)) return new ProblemException(409, 'invalid_transition', { detail: 'An email change is already waiting for approval. Cancel it first.' });
      if (/this email change is not pending/i.test(msg)) return new ProblemException(409, 'invalid_transition', { detail: 'This email change is no longer waiting for a decision.' });
      if (/email: already used by another account/i.test(msg)) {
        return new ProblemException(409, 'duplicate', { detail: 'This email is already used or requested by another account.', errors: [{ path: '/new_email', code: 'duplicate', message: 'Already used or requested by another account.' }] });
      }
      if (/phone: already used by another account/i.test(msg)) {
        return new ProblemException(409, 'duplicate', { detail: 'This phone is already used by another account.', errors: [{ path: '/phone', code: 'duplicate', message: 'Already used by another account.' }] });
      }
      if (/^email: |\bemail: /i.test(msg)) {
        return new ProblemException(422, 'validation_failed', {
          detail: /already your email/i.test(msg) ? 'This is already your email.' : 'The email is not valid.',
          errors: [{ path: '/new_email', code: /already your email/i.test(msg) ? 'same_as_current' : 'invalid', message: /already your email/i.test(msg) ? 'This is already your email.' : 'Not a valid email address.' }],
        });
      }
      if (/profile: /i.test(msg)) {
        const field = /profile: (display_name|phone|locale|theme)/.exec(msg)?.[1];
        return new ProblemException(422, 'validation_failed', { detail: 'A profile value is not valid.', errors: field ? [{ path: `/${field}`, code: 'invalid' }] : [] });
      }
      if (/two-factor is not on for this user/i.test(msg)) return new ProblemException(409, 'invalid_transition', { detail: 'Two-factor is not on for this user: there is nothing to reset.' });
      if (/no enrolment code can be issued/i.test(msg)) return new ProblemException(409, 'invalid_transition', { detail: 'This user is not waiting for enrolment, so there is no enrolment code to issue. Turn two-factor on, or reset it.' });
      if (/two-factor needs a local account/i.test(msg)) {
        return new ProblemException(422, 'validation_failed', {
          detail: 'Two-factor needs a local account with sign-in on.',
          errors: [{ path: '/user_id', code: 'no_local_account', message: 'This user has no local sign-in.' }],
        });
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
