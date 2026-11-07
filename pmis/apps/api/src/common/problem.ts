import { HttpException } from '@nestjs/common';

/** Error codes of contracts/openapi.yaml (ErrorCode). */
export type ErrorCode =
  | 'validation_failed' | 'unauthenticated' | 'mfa_required' | 'step_up_required' | 'pending_assignment'
  | 'module_forbidden' | 'action_forbidden' | 'field_read_only' | 'not_eligible_holder' | 'self_beneficiary'
  | 'delegate_forbidden' | 'last_admin' | 'not_found' | 'already_claimed' | 'already_assigned'
  | 'invalid_transition' | 'note_required' | 'role_in_use' | 'precondition_failed' | 'precondition_required' | 'duplicate' | 'rate_limited'
  | 'account_locked' | 'invalid_credentials' | 'invalid_code' | 'invalid_enrol_code' | 'enrol_code_expired' | 'password_change_required' | 'weak_password' | 'internal_error'
  | 'mandatory_slots_missing' | 'mandatory_fields_missing' | 'open_snags' | 'empty_cell' | 'insufficient_stock' | 'item_in_use' | 'template_rejected'
  | 'file_too_large' | 'file_rejected' | 'malware_scan_unavailable' | 'export_expired' | 'team_scope_mismatch' | 'two_factor_enforced'
  | 'scope_scenario_conflict'
  | 'too_many_rows' | 'integrity_too_large' | 'mail_not_configured'
  | 'self_approval_forbidden' | 'document_rule_pending' | 'file_pending_scan'
  | 'list_not_configured'
  | 'email_not_verified'
  | 'batch_processing' | 'vehicle_already_reserved';

export interface FieldError {
  path: string;
  code: string;
  message?: string;
}

const TITLES: Record<string, string> = {
  validation_failed: 'Validation failed',
  unauthenticated: 'Not signed in',
  step_up_required: 'Re-authentication required',
  pending_assignment: 'Account is waiting for an assignment',
  module_forbidden: 'Module not available',
  action_forbidden: 'Action not allowed',
  self_beneficiary: 'You cannot do this to your own account',
  delegate_forbidden: 'Not allowed for a delegate',
  last_admin: 'At least one active System Admin must remain',
  not_found: 'Not found',
  already_assigned: 'Already assigned',
  note_required: 'A note is required',
  not_eligible_holder: 'You do not hold this level',
  already_claimed: 'Already claimed',
  invalid_transition: 'This is not possible in the current state',
  mandatory_slots_missing: 'Mandatory document slots are missing',
  mandatory_fields_missing: 'Mandatory fields are missing',
  open_snags: 'Open snags block this approval',
  scope_scenario_conflict: 'The scenario and the scope flags disagree',
  self_approval_forbidden: 'You may not approve this yourself',
  document_rule_pending: 'A document rule cannot be decided yet',
  file_pending_scan: 'The file waits for the virus scan',
  list_not_configured: 'A critical list has no value yet',
  vehicle_already_reserved: 'The vehicle is already reserved for overlapping dates',
  empty_cell: 'A level in use has no holder',
  role_in_use: 'The role is in use',
  precondition_failed: 'The resource changed',
  precondition_required: 'If-Match header required',
  duplicate: 'Already exists',
  rate_limited: 'Too many requests',
  account_locked: 'Account locked',
  invalid_credentials: 'Invalid credentials',
  invalid_code: 'Invalid code',
  invalid_enrol_code: 'Invalid enrolment code',
  enrol_code_expired: 'Enrolment code expired',
  password_change_required: 'Password change required',
  weak_password: 'Password does not meet the policy',
  internal_error: 'Internal error',
  template_rejected: 'The file is not an approved template',
  file_too_large: 'The file is too large',
  file_rejected: 'The file is not accepted',
  export_expired: 'The export has expired',
  team_scope_mismatch: 'The team does not match the order scope',
  two_factor_enforced: 'Two-factor is enforced by an administrator',
  field_read_only: 'This field is managed by an administrator',
  too_many_rows: 'Too many rows for one file',
  integrity_too_large: 'The check is too large for one request',
  mail_not_configured: 'Mail is not configured',
  email_not_verified: 'The new email address is not confirmed',
  batch_processing: 'The batch is being processed',
};

export const problemTitle = (code: string): string => TITLES[code] ?? code;

export interface ProblemOptions {
  detail?: string;
  errors?: FieldError[];
  step_up_method?: 'password' | 'password_totp' | 'm365' | 'totp';
  /** Extra members of the problem body (for example `missing`, `claimed_by`). */
  extra?: Record<string, unknown>;
  headers?: Record<string, string>;
  /** Commit the request transaction before the error is sent (failed-password counters must persist). */
  commit?: boolean;
}

/** An RFC 9457 problem. The exception filter turns it into application/problem+json. */
export class ProblemException extends HttpException {
  readonly code: ErrorCode;
  readonly opts: ProblemOptions;

  constructor(status: number, code: ErrorCode, opts: ProblemOptions = {}) {
    super({ code }, status);
    this.code = code;
    this.opts = opts;
  }

  get commit(): boolean {
    return this.opts.commit === true;
  }
}

export const problems = {
  unauthenticated: (detail = 'Sign in to continue.') => new ProblemException(401, 'unauthenticated', { detail }),
  invalidCredentials: (commit = false) =>
    new ProblemException(401, 'invalid_credentials', { detail: 'The identifier or the password is not correct.', commit }),
  forbidden: (code: ErrorCode = 'action_forbidden', detail?: string) => new ProblemException(403, code, { detail }),
  notFound: (detail = 'The resource does not exist or is not visible to you.') => new ProblemException(404, 'not_found', { detail }),
  validation: (errors: FieldError[], detail = 'The request is not valid.') => new ProblemException(422, 'validation_failed', { errors, detail }),
  badRequest: (detail: string) => new ProblemException(400, 'validation_failed', { detail }),
  rateLimited: (retryAfterSeconds: number) =>
    new ProblemException(429, 'rate_limited', { detail: 'Too many attempts. Try again later.', headers: { 'Retry-After': String(retryAfterSeconds) } }),
};
