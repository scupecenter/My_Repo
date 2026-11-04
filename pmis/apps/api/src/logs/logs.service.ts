import { Injectable, Logger, StreamableFile } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth.types';
import { SessionService } from '../auth/session.service';
import { StepUpService } from '../auth/step-up.service';
import { SyslogService } from '../auth/syslog.service';
import { decodeCursor, encodeCursor, parseLimit } from '../common/cursor';
import { parseIfMatch } from '../common/etag';
import { IdempotencyService } from '../common/idempotency.service';
import { FieldError, ProblemException, problems } from '../common/problem';
import { Query, isCalendarDate, oneParam } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { StorageService, newObjectKey } from '../documents/storage.service';
import { attachmentHeader } from '../documents/naming';
import { applyContext, jobContext, parseDevice } from './context';
import { WorkbookInput, activityWorkbook } from './activity-workbook';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})$/;
export const VIAS = ['manual', 'template', 'bulk', 'api', 'job'] as const;
const SEC_EVENTS = ['sign_in_started', 'sign_in_succeeded', 'callback_account_mismatch', 'sign_in_failed', 'sign_in_locked', 'sign_in_rate_limited', 'signed_out',
  'session_expired', 'session_ended', 'session_revoked_by_admin', 'mfa_exemption_granted', 'mfa_exemption_revoked', 'step_up_passed', 'step_up_failed',
  'break_glass_used', 'two_factor_passed', 'two_factor_failed', 'recovery_code_used', 'two_factor_enrolled', 'password_changed', 'password_reset'];
/** "Online" = real activity inside this window (contract ActiveSession.status). */
export const PRESENCE_MINUTES = 5;
/** Rows per log export file (owner answer Q170): a larger export is refused with 422 `too_many_rows`, never cut. */
export const EXPORT_MAX_ROWS = 100_000;
const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;

type UserRef = { id: string; display_name: string; employee_id: string | null } | null;

const csvCell = (v: unknown): string => {
  let s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // a spreadsheet must not run a cell
  return `"${s.replace(/"/g, '""')}"`;
};

const fieldError = (path: string, message: string): ProblemException => problems.validation([{ path, code: 'invalid', message }]);

/** Validated filters of the log readers, handed to the database as one jsonb object (keys the read functions know). */
function filters(q: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const get = (k: string): string | undefined => {
    const v = q[k];
    if (v === undefined || v === '' || v === null) return undefined;
    if (typeof v !== 'string') throw fieldError(`/${k}`, `${k} must be a single value.`);
    return v;
  };
  for (const k of keys) {
    const v = get(k);
    if (v === undefined) continue;
    switch (k) {
      case 'from': case 'to':
        if (!TS_RE.test(v) && !isCalendarDate(v)) throw fieldError(`/${k}`, `${k} is a date-time (ISO 8601).`);
        if (Number.isNaN(Date.parse(v))) throw fieldError(`/${k}`, `${k} is not a real instant.`);
        out[k] = isCalendarDate(v) ? `${v}T00:00:00Z` : v;
        break;
      case 'actor_id': case 'site_id': case 'user_id': case 'session_id': case 'batch_id': case 'bulk_action_id':
        if (!UUID_RE.test(v)) throw fieldError(`/${k}`, `${k} is a uuid.`);
        out[k] = v.toLowerCase();
        break;
      case 'region_id':
        if (!/^[1-9][0-9]{0,2}$/.test(v)) throw fieldError('/region_id', 'region_id is a region number.');
        out[k] = Number(v);
        break;
      case 'via':
        if (!(VIAS as readonly string[]).includes(v)) throw fieldError('/via', `via is one of ${VIAS.join(', ')}.`);
        out[k] = v;
        break;
      case 'ip':
        if (!isIP(v)) throw fieldError('/ip', 'ip is an IPv4 or IPv6 address.');
        out[k] = v;
        break;
      case 'admin_override': case 'privileged':
        if (v !== 'true' && v !== 'false') throw fieldError(`/${k}`, `${k} is true or false.`);
        out[k] = v === 'true';
        break;
      case 'outcome':
        if (!['success', 'failure', 'info'].includes(v)) throw fieldError('/outcome', 'outcome is success, failure or info.');
        out[k] = v;
        break;
      case 'event': {
        const list = v.split(',').map((x) => x.trim()).filter(Boolean);
        for (const e of list) if (!SEC_EVENTS.includes(e)) throw fieldError('/event', `Unknown event ${e}.`);
        out[k] = list;
        break;
      }
      default:
        if (v.length > 200) throw fieldError(`/${k}`, `${k} is too long.`);
        out[k] = v;
    }
  }
  if (typeof out.from === 'string' && typeof out.to === 'string' && Date.parse(out.to) < Date.parse(out.from)) throw fieldError('/to', 'to must not be before from.');
  return out;
}

const AUDIT_FILTERS = ['from', 'to', 'actor_id', 'site_id', 'region_id', 'entity_type', 'entity_id', 'action', 'module_key', 'via', 'ip', 'session_id', 'batch_id', 'bulk_action_id', 'admin_override', 'privileged', 'q'];
const FIELD_FILTERS = ['entity_type', 'entity_id', 'site_id', 'field', 'actor_id', 'from', 'to', 'ip', 'via'];
const SEC_FILTERS = ['from', 'to', 'event', 'outcome', 'user_id', 'ip', 'q'];

const exportAuditBody = z.object({
  from: z.string().optional(), to: z.string().optional(), actor_id: z.string().optional(), site_id: z.string().optional(), region_id: z.union([z.number().int(), z.string()]).optional(),
  entity_type: z.string().max(80).optional(), entity_id: z.string().max(200).optional(), action: z.string().max(80).optional(), via: z.string().optional(), ip: z.string().optional(),
  q: z.string().max(200).optional(),
}).strict();
const exportSecBody = z.object({
  from: z.string().optional(), to: z.string().optional(), event: z.array(z.string()).max(30).optional(), outcome: z.string().optional(), q: z.string().max(200).optional(),
  user_id: z.string().optional(), ip: z.string().optional(),
}).strict();
const reasonSchema = z.string().trim().min(3).max(1000);
const retentionInput = z.object({ reason: reasonSchema, system_log_days: z.number().int().min(90).max(3650), security_log_days: z.number().int().min(365).max(3650) }).strict();
const alertInput = z.object({
  reason: reasonSchema,
  failed_sign_ins: z.object({ count: z.number().int(), minutes: z.number().int() }).strict(),
  failed_by_ip: z.object({ count: z.number().int(), minutes: z.number().int() }).strict(),
  large_export_rows: z.number().int(),
  new_ip: z.boolean(),
  // 0.12.3 (Q167, Q168): optional; left out = kept. The database checks the rule names, the networks and the weakening.
  severity: z.record(z.string().max(60), z.enum(SEVERITIES)).optional(),
  email_min_severity: z.enum(SEVERITIES).optional(),
  trusted_networks: z.array(z.string().trim().min(3).max(64)).max(50).optional(),
}).strict();
const ackInput = z.object({ note: z.string().trim().min(3).max(1000) }).strict();
const withReason = z.object({ reason: reasonSchema }).strict();

interface AuditRow {
  id: bigint; at: Date; at_text: string; actor_id: string | null; on_behalf_of: string | null; action: string; entity_type: string; entity_id: string | null;
  site_id: string | null; region_id: number | null; before: unknown; after: Record<string, unknown> | null; reason: string | null; is_admin_override: boolean;
  ip: string | null; user_agent: string | null; request_id: string | null; module_key: string | null; session_id: string | null; auth_method: string | null;
  mfa: boolean | null; stepup_verified: boolean | null; via: string | null; batch_id: string | null; batch_row: string | null; device: unknown; job_name: string | null;
  privileged: boolean; site_code: string | null; chain_seq: bigint | null;
}

interface FieldRow {
  id: bigint; audit_id: bigint; at: Date; at_text: string; actor_id: string | null; on_behalf_of: string | null; action: string; entity_type: string; entity_id: string | null;
  record_id: string | null; site_id: string | null; region_id: number | null; module_key: string | null; field: string; field_label_en: string | null; field_label_ar: string | null;
  old_value: unknown; new_value: unknown; ip: string | null; user_agent: string | null; device: unknown; session_id: string | null; via: string | null; batch_id: string | null;
  request_id: string | null;
}

interface JobRow { id: string; requested_by: string; scope: { kind?: string; filters?: Record<string, unknown> }; status: 'queued' | 'running' | 'done' | 'failed'; progress: string | number;
  file_count: number | null; size_bytes: bigint | null; storage_key: string | null; error: string | null; created_at: Date; finished_at: Date | null; expires_at: Date | null }

/**
 * The log readers and admin screens of migration 0045 (contract 0.10.0): Audit Log, field changes and field history (decision B4 scope, enforced by the
 * database), integrity checks, exports, the sign-in and security log, the System Log, online sessions, job runs, deployments, security alerts, retention
 * and alert settings, and the monthly activity report. Every read of the Audit Log and of the security log is audited by the database functions.
 */
@Injectable()
export class LogsService {
  private readonly log = new Logger('Logs');
  private readonly running = new Set<Promise<void>>();
  /** The cap per export file (EXPORT_MAX_ROWS; a test lowers it instead of writing 100 000 rows). */
  exportMaxRows = EXPORT_MAX_ROWS;

  constructor(
    private readonly db: DbService,
    private readonly stepUp: StepUpService,
    private readonly sessions: SessionService,
    private readonly idem: IdempotencyService,
    private readonly storage: StorageService,
    private readonly syslog: SyslogService,
  ) {}

  /** Waits for export jobs started by this process (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  private async users(ids: (string | null | undefined)[]): Promise<Map<string, NonNullable<UserRef>>> {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    const m = new Map<string, NonNullable<UserRef>>();
    if (list.length === 0) return m;
    const rows = await this.db.tx.$queryRaw<{ id: string; display_name: string; employee_id: string | null }[]>(Prisma.sql`
      SELECT id::text AS id, display_name, nullif(trim(employee_id), '') AS employee_id FROM users WHERE id = ANY(${list}::uuid[])`);
    for (const r of rows) m.set(r.id, { id: r.id, display_name: r.display_name, employee_id: r.employee_id });
    return m;
  }

  private page<T>(items: T[], limit: number, cursorOf: (last: T) => string[], total?: number) {
    const more = items.length > limit;
    const out = more ? items.slice(0, limit) : items;
    const last = out[out.length - 1];
    return { items: out, page: { limit, next_cursor: more && last !== undefined ? encodeCursor(cursorOf(last)) : null, ...(total !== undefined ? { total } : {}) } };
  }

  private cursorTs(q: Query, idKind: 'bigint' | 'uuid'): { cursor_at?: string; cursor_id?: string } {
    const c = decodeCursor(oneParam(q, 'cursor'), 2);
    if (!c) return {};
    const [at, id] = c as [string, string];
    if (!TS_RE.test(at) || (idKind === 'bigint' ? !/^[0-9]{1,19}$/.test(id) : !UUID_RE.test(id))) throw problems.badRequest('The cursor is not valid.');
    return { cursor_at: at, cursor_id: id };
  }

  // ------------------------------------------------------------------ Audit Log
  private auditDto(r: AuditRow, u: Map<string, NonNullable<UserRef>>) {
    const after = r.after && typeof r.after === 'object' ? r.after : null;
    return {
      id: Number(r.id), at: r.at_text, actor: r.actor_id ? u.get(r.actor_id) ?? null : null, on_behalf_of: r.on_behalf_of ? u.get(r.on_behalf_of) ?? null : null,
      on_behalf_kind: r.on_behalf_of ? 'delegate' : null,
      action: r.action, entity_type: r.entity_type, entity_id: r.entity_id, site_id: r.site_id, site_code: r.site_code, region_id: r.region_id, module_key: r.module_key,
      before: r.before ?? null, after, reason: r.reason,
      bulk_action_id: typeof after?.bulk_action_id === 'string' ? after.bulk_action_id : r.entity_type === 'bulk_action' ? r.entity_id : null,
      batch_id: r.batch_id, batch_row: r.batch_row, is_admin_override: r.is_admin_override, privileged: r.privileged, stepup_verified: r.stepup_verified === true,
      mfa: r.mfa === true, self_approval: after?.self_approval === true, ip: r.ip, user_agent: r.user_agent, request_id: r.request_id, session_id: r.session_id,
      auth_method: r.auth_method, via: r.via, device: r.device ?? null, job_name: r.job_name, chain_seq: r.chain_seq === null ? null : Number(r.chain_seq),
    };
  }

  private auditSql(f: Record<string, unknown>, limit: number): Prisma.Sql {
    return Prisma.sql`SELECT a.*, log_ts_text(a.at) AS at_text, log_is_privileged(a.action, a.entity_type, a.is_admin_override) AS privileged,
        s.site_code, log_audit_chain_seq(a.id) AS chain_seq
      FROM log_audit_read(${JSON.stringify(f)}::jsonb, ${limit}::int) a
      LEFT JOIN sites s ON s.id = a.site_id
      ORDER BY a.at DESC, a.id DESC`;
  }

  async auditList(q: Query) {
    const limit = parseLimit(q.limit);
    const f = { ...filters(q, AUDIT_FILTERS), ...this.cursorTs(q, 'bigint') };
    const rows = await this.db.tx.$queryRaw<AuditRow[]>(this.auditSql(f, limit + 1));
    const u = await this.users(rows.flatMap((r) => [r.actor_id, r.on_behalf_of]));
    return this.page(rows.map((r) => this.auditDto(r, u)), limit, (l) => [l.at, String(l.id)]);
  }

  // ------------------------------------------------------------------ field changes
  private async fieldDtos(rows: FieldRow[]) {
    const u = await this.users(rows.flatMap((r) => [r.actor_id, r.on_behalf_of]));
    const ids = [...new Set(rows.map((r) => r.audit_id.toString()))];
    const audits = ids.length === 0 ? [] : await this.db.tx.$queryRaw<{ id: string; auth_method: string | null; mfa: boolean | null; reason: string | null }[]>(Prisma.sql`
      SELECT id::text AS id, auth_method, mfa, reason FROM audit_log WHERE id = ANY(${ids}::bigint[])`);
    const am = new Map(audits.map((a) => [a.id, a]));
    const siteIds = [...new Set(rows.map((r) => r.site_id).filter((x): x is string => !!x))];
    const sites = siteIds.length === 0 ? [] : await this.db.tx.$queryRaw<{ id: string; site_code: string }[]>(Prisma.sql`SELECT id::text AS id, site_code FROM sites WHERE id = ANY(${siteIds}::uuid[])`);
    const sm = new Map(sites.map((s) => [s.id, s.site_code]));
    const taskIds = [...new Set(rows.filter((r) => r.entity_type === 'task' && r.entity_id && UUID_RE.test(r.entity_id)).map((r) => r.entity_id as string))];
    const tasks = taskIds.length === 0 ? [] : await this.db.tx.$queryRaw<{ id: string; code: string }[]>(Prisma.sql`
      SELECT t.id::text AS id, d.code FROM task_instances t JOIN task_definitions d ON d.id = t.task_def_id WHERE t.id = ANY(${taskIds}::uuid[])`);
    const tm = new Map(tasks.map((t) => [t.id, t.code]));
    const recIds = [...new Set(rows.filter((r) => r.entity_type === 'register_record' && r.record_id && UUID_RE.test(r.record_id)).map((r) => r.record_id as string))];
    const recs = recIds.length === 0 ? [] : await this.db.tx.$queryRaw<{ id: string; register_key: string }[]>(Prisma.sql`
      SELECT id::text AS id, register_key FROM register_records WHERE id = ANY(${recIds}::uuid[])`);
    const rm = new Map(recs.map((r) => [r.id, r.register_key]));
    return rows.map((r) => {
      const a = am.get(r.audit_id.toString());
      const actor = r.actor_id ? u.get(r.actor_id) ?? null : null;
      const site = r.site_id ? sm.get(r.site_id) ?? null : null;
      const what = r.entity_type === 'task' ? tm.get(r.entity_id ?? '') ?? 'Task' : r.entity_type === 'register_record' ? (rm.get(r.record_id ?? '') ?? 'record').toUpperCase() : r.entity_type;
      return {
        id: r.id.toString(), audit_id: Number(r.audit_id), at: r.at_text,
        actor: actor ? { ...actor, name: actor.display_name } : null,
        on_behalf_of: r.on_behalf_of ? (() => { const o = u.get(r.on_behalf_of as string); return o ? { ...o, name: o.display_name } : null; })() : null,
        action: r.action, entity_type: r.entity_type, entity_id: r.entity_id, record_id: r.record_id, entity_label: site ? `${what} · ${site}` : what,
        site_id: r.site_id, site_code: site, region_id: r.region_id, module_key: r.module_key,
        field: r.field, field_label_en: r.field_label_en ?? r.field, field_label_ar: r.field_label_ar ?? r.field_label_en ?? r.field,
        old_value: r.old_value ?? null, new_value: r.new_value ?? null, via: r.via, batch_id: r.batch_id, ip: r.ip, device: r.device ?? parseDevice(r.user_agent),
        user_agent: r.user_agent, session_id: r.session_id, request_id: r.request_id, auth_method: a?.auth_method ?? null, mfa: a?.mfa === true, reason: a?.reason ?? null,
      };
    });
  }

  async fieldChanges(q: Query) {
    const limit = parseLimit(q.limit);
    const f = { ...filters(q, FIELD_FILTERS), ...this.cursorTs(q, 'bigint') };
    const rows = await this.db.tx.$queryRaw<FieldRow[]>(Prisma.sql`SELECT c.*, log_ts_text(c.at) AS at_text FROM log_field_changes_read(${JSON.stringify(f)}::jsonb, ${limit + 1}::int) c ORDER BY c.at DESC, c.id DESC`);
    return this.page(await this.fieldDtos(rows), limit, (l) => [l.at, l.id]);
  }

  async fieldHistory(q: Query) {
    const f = filters(q, ['entity_type', 'entity_id', 'field']);
    const errors: FieldError[] = ['entity_type', 'entity_id', 'field'].filter((k) => f[k] === undefined).map((k) => ({ path: `/${k}`, code: 'required', message: `${k} is required.` }));
    if (errors.length) throw problems.validation(errors);
    const rows = await this.db.tx.$queryRaw<FieldRow[]>(Prisma.sql`SELECT c.*, log_ts_text(c.at) AS at_text FROM log_field_changes_read(${JSON.stringify(f)}::jsonb, 200) c ORDER BY c.at DESC, c.id DESC`);
    return { items: await this.fieldDtos(rows) };
  }

  // ------------------------------------------------------------------ integrity
  async integrity(log: 'audit' | 'security', q: Query) {
    const num = (k: string): number | null => {
      const v = oneParam(q, k);
      if (v === undefined || v === '') return null;
      if (!/^[1-9][0-9]{0,17}$/.test(v)) throw fieldError(`/${k}`, `${k} is a positive integer.`);
      return Number(v);
    };
    const from = num('from_seq');
    const to = num('to_seq');
    // Q171: a large check runs as a job with progress (POST /admin/log-integrity/runs), not inside one request
    const span = await this.db.tx.$queryRaw<{ n: bigint; max: number | null }[]>(Prisma.sql`
      SELECT log_integrity_span(${log}::text, ${from}::bigint, ${to}::bigint) AS n,
             (SELECT CASE WHEN jsonb_typeof(value) = 'number' THEN (value #>> '{}')::int END FROM settings WHERE key = 'logs.integrity.sync_max_rows') AS max`);
    const max = span[0]?.max ?? 200_000;
    if (Number(span[0]?.n ?? 0) > max) {
      throw new ProblemException(422, 'integrity_too_large', {
        detail: `The check covers ${Number(span[0]?.n)} rows, more than ${max} at once: start it as a job (POST /admin/log-integrity/runs) or give from_seq and to_seq.`,
        extra: { row_count: Number(span[0]?.n), max_rows: max },
      });
    }
    const r = await this.db.tx.$queryRaw<{ j: Record<string, unknown> }[]>(Prisma.sql`SELECT log_verify_chain(${log}::text, ${from}::bigint, ${to}::bigint) AS j`);
    return r[0]!.j;
  }

  // ------------------------------------------------------------------ security log
  async securityList(q: Query) {
    const limit = parseLimit(q.limit);
    const f = { ...filters(q, SEC_FILTERS), ...this.cursorTs(q, 'bigint') };
    const rows = await this.db.tx.$queryRaw<{ id: bigint; at_text: string; event: string; outcome: string; user_id: string | null; actor_id: string | null; identifier_hash: string | null;
      client_type: string; ip: string | null; user_agent: string | null; device: unknown; session_id: string | null; request_id: string | null; detail: unknown }[]>(Prisma.sql`
      SELECT s.*, log_ts_text(s.at) AS at_text FROM sec_log_read(${JSON.stringify(f)}::jsonb, ${limit + 1}::int) s ORDER BY s.at DESC, s.id DESC`);
    const u = await this.users(rows.flatMap((r) => [r.user_id, r.actor_id]));
    const items = rows.map((r) => ({
      id: Number(r.id), at: r.at_text, event: r.event, outcome: r.outcome, user: r.user_id ? u.get(r.user_id) ?? null : null, actor: r.actor_id && r.actor_id !== r.user_id ? u.get(r.actor_id) ?? null : null,
      identifier_masked: r.user_id ? null : r.identifier_hash, client_type: r.client_type, ip: r.ip, user_agent: r.user_agent, device: r.device ?? parseDevice(r.user_agent),
      session_id: r.session_id, request_id: r.request_id, details: r.detail ?? null,
    }));
    return this.page(items, limit, (l) => [l.at, String(l.id)]);
  }

  // ------------------------------------------------------------------ System Log
  private async requireOps(): Promise<void> {
    const r = await this.db.tx.$queryRaw<{ ok: boolean }[]>`SELECT log_can_read_ops() AS ok`;
    if (!r[0]?.ok) throw new ProblemException(403, 'action_forbidden', { detail: 'A System Admin (or view on admin.system_log) is needed.' });
  }

  async systemList(q: Query) {
    await this.requireOps();
    const limit = parseLimit(q.limit);
    const f = filters(q, ['from', 'to', 'q']);
    const level = oneParam(q, 'level');
    if (level && !['debug', 'info', 'warn', 'error'].includes(level)) throw fieldError('/level', 'level is info, warn or error.');
    const source = oneParam(q, 'source');
    const requestId = oneParam(q, 'request_id');
    const c = this.cursorTs(q, 'bigint');
    const conds: Prisma.Sql[] = [Prisma.sql`true`];
    if (level) conds.push(Prisma.sql`l.level = ${level}::"LogLevel"`);
    if (source) conds.push(Prisma.sql`l.source = ${source}`);
    if (requestId) conds.push(Prisma.sql`l.request_id = ${requestId}`);
    if (f.from) conds.push(Prisma.sql`l.at >= ${f.from as string}::timestamptz`);
    if (f.to) conds.push(Prisma.sql`l.at < ${f.to as string}::timestamptz`);
    if (f.q) conds.push(Prisma.sql`(l.message ILIKE ${'%' + String(f.q).replace(/[\\%_]/g, (x) => '\\' + x) + '%'} OR l.request_id = ${f.q as string})`);
    if (c.cursor_at) conds.push(Prisma.sql`(l.at, l.id) < (${c.cursor_at}::timestamptz, ${c.cursor_id}::bigint)`);
    const rows = await this.db.tx.$queryRaw<{ id: bigint; at_text: string; level: string; source: string; message: string; context: Record<string, unknown> | null; user_id: string | null; request_id: string | null }[]>(Prisma.sql`
      SELECT l.id, log_ts_text(l.at) AS at_text, l.level::text AS level, l.source, l.message, l.context, l.user_id::text AS user_id, l.request_id
      FROM system_log l WHERE ${Prisma.join(conds, ' AND ')} ORDER BY l.at DESC, l.id DESC LIMIT ${limit + 1}`);
    const u = await this.users(rows.map((r) => r.user_id));
    const items = rows.map((r) => ({
      id: Number(r.id), at: r.at_text, level: r.level === 'debug' ? 'info' : r.level, source: r.source, code: typeof r.context?.code === 'string' ? r.context.code : null, message: r.message,
      request_id: r.request_id, user: r.user_id ? u.get(r.user_id) ?? null : null, route: typeof r.context?.route === 'string' ? r.context.route : null, details: r.context,
    }));
    return this.page(items, limit, (l) => [l.at, String(l.id)]);
  }

  // ------------------------------------------------------------------ sessions (Online now)
  private async canManageSessions(auth: AuthContext): Promise<boolean> {
    if (auth.state.isAdmin) return true;
    const r = await this.db.tx.$queryRaw<{ ok: boolean }[]>(Prisma.sql`SELECT app_has_permission(${auth.user.id}::uuid, 'admin.users', 'manage_users'::"PermissionAction")
      OR app_has_permission(${auth.user.id}::uuid, 'admin.online', 'manage_users'::"PermissionAction") AS ok`);
    return r[0]?.ok === true;
  }

  private async sessionRows(q: Query) {
    const status = oneParam(q, 'status');
    if (status && !['online', 'idle'].includes(status)) throw fieldError('/status', 'status is online or idle.');
    const text = oneParam(q, 'q');
    const conds: Prisma.Sql[] = [Prisma.sql`s.revoked_at IS NULL`, Prisma.sql`s.expires_at > now()`, Prisma.sql`s.last_activity_at > now() - interval '8 hours'`];
    if (status === 'online') conds.push(Prisma.sql`s.last_activity_at > now() - make_interval(mins => ${PRESENCE_MINUTES}::int)`);
    if (status === 'idle') conds.push(Prisma.sql`s.last_activity_at <= now() - make_interval(mins => ${PRESENCE_MINUTES}::int)`);
    if (text) conds.push(Prisma.sql`(u.display_name ILIKE ${'%' + text.replace(/[\\%_]/g, (x) => '\\' + x) + '%'} OR trim(u.employee_id) = ${text})`);
    return this.db.tx.$queryRaw<{ id: string; user_id: string; display_name: string; employee_id: string | null; created_at: Date; last_activity_at: Date; current_screen: string | null;
      auth_method: string; ip: string | null; user_agent: string | null; two_factor: boolean; online: boolean }[]>(Prisma.sql`
      SELECT s.id::text AS id, s.user_id::text AS user_id, u.display_name, nullif(trim(u.employee_id), '') AS employee_id, s.created_at, s.last_activity_at, s.current_screen,
             s.auth_method::text AS auth_method, host(s.ip) AS ip, s.user_agent, s.two_factor,
             s.last_activity_at > now() - make_interval(mins => ${PRESENCE_MINUTES}::int) AS online
      FROM user_sessions s JOIN users u ON u.id = s.user_id
      WHERE ${Prisma.join(conds, ' AND ')} ORDER BY s.last_activity_at DESC, s.id LIMIT 500`);
  }

  /** GET /sessions/active (Users and Roles, Online now tab). */
  async activeSessions(auth: AuthContext, q: Query) {
    if (!(await this.canManageSessions(auth))) throw new ProblemException(403, 'action_forbidden', { detail: 'A System Admin or the manage_users grant is needed.' });
    const limit = parseLimit(q.limit);
    const rows = await this.sessionRows(q);
    const items = rows.slice(0, limit).map((r) => ({
      session_id: r.id, user: { id: r.user_id, display_name: r.display_name, employee_id: r.employee_id }, status: r.online ? 'online' : 'idle',
      last_activity_at: r.last_activity_at, current_screen: r.current_screen, signed_in_at: r.created_at, client_type: r.auth_method === 'break_glass' ? 'break_glass' : 'web',
      ip: auth.state.isAdmin ? r.ip : null, is_current: r.id === auth.session.id,
    }));
    return { items, page: { limit, next_cursor: null, total: rows.length } };
  }

  /** GET /admin/sessions (the logs screens' Online now). */
  async adminSessions(auth: AuthContext, q: Query) {
    if (!(await this.canManageSessions(auth))) throw new ProblemException(403, 'action_forbidden', { detail: 'A System Admin or the manage_users grant is needed.' });
    const limit = parseLimit(q.limit);
    const rows = await this.sessionRows(q);
    const items = rows.slice(0, limit).map((r) => ({
      session_id: r.id, user: { id: r.user_id, display_name: r.display_name, employee_id: r.employee_id }, status: r.online ? 'online' : 'idle',
      started_at: r.created_at, last_activity_at: r.last_activity_at, ip: auth.state.isAdmin ? r.ip : null, device: parseDevice(r.user_agent),
      current_screen: r.current_screen, auth_method: r.auth_method === 'm365' ? 'oidc' : r.auth_method, mfa: r.two_factor, is_current: r.id === auth.session.id,
    }));
    return { items, page: { limit, next_cursor: null, total: rows.length } };
  }

  /** POST /sessions/{id}/revoke and POST /admin/sessions/{id}/end: reason and step-up; the security log row comes from the user_sessions trigger. */
  async endSession(auth: AuthContext, id: string, raw: unknown) {
    if (!(await this.canManageSessions(auth))) throw new ProblemException(403, 'action_forbidden', { detail: 'A System Admin or the manage_users grant is needed.' });
    const { reason } = parse(withReason, raw);
    await this.stepUp.require(auth);
    if (!uuidSchema.safeParse(id).success) throw problems.notFound('The session does not exist.');
    if (id === auth.session.id) throw problems.validation([{ path: '/session_id', code: 'own_session', message: 'Use sign out for your own session.' }]);
    const rows = await this.db.tx.$queryRaw<{ user_id: string; display_name: string; employee_id: string | null; live: boolean }[]>(Prisma.sql`
      SELECT s.user_id::text AS user_id, u.display_name, nullif(trim(u.employee_id), '') AS employee_id, (s.revoked_at IS NULL) AS live
      FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ${id}::uuid`);
    const s = rows[0];
    if (!s) throw problems.notFound('The session does not exist.');
    if (!s.live) return { user: { id: s.user_id, display_name: s.display_name, employee_id: s.employee_id }, revoked_count: 0 };
    await this.sessions.revoke(id, auth.user.id, `admin: ${reason}`.slice(0, 300));
    await this.db.tx.$queryRaw(Prisma.sql`SELECT log_audit_write('session_revoked', 'user_session', ${id}::text, NULL, ${JSON.stringify({ user_id: s.user_id })}::jsonb, ${reason}::text)`);
    return { user: { id: s.user_id, display_name: s.display_name, employee_id: s.employee_id }, revoked_count: 1 };
  }

  /** POST /users/{id}/sessions/revoke: every session of the user except the caller's own. */
  async endUserSessions(auth: AuthContext, userId: string, raw: unknown) {
    if (!(await this.canManageSessions(auth))) throw new ProblemException(403, 'action_forbidden', { detail: 'A System Admin or the manage_users grant is needed.' });
    const { reason } = parse(withReason, raw);
    await this.stepUp.require(auth);
    if (!uuidSchema.safeParse(userId).success) throw problems.notFound('The user does not exist.');
    const u = await this.users([userId]);
    const ref = u.get(userId);
    if (!ref) throw problems.notFound('The user does not exist.');
    const n = await this.db.tx.$executeRaw(Prisma.sql`UPDATE user_sessions SET revoked_at = now(), revoked_by = ${auth.user.id}::uuid, revoke_reason = ${`admin: ${reason}`.slice(0, 300)}
      WHERE user_id = ${userId}::uuid AND revoked_at IS NULL AND id <> ${auth.session.id}::uuid`);
    await this.db.tx.$queryRaw(Prisma.sql`SELECT log_audit_write('user_sessions_revoked', 'user', ${userId}::text, NULL, ${JSON.stringify({ revoked_count: n })}::jsonb, ${reason}::text)`);
    return { user: ref, revoked_count: n };
  }

  // ------------------------------------------------------------------ job runs, deployments
  async jobRuns(q: Query) {
    const limit = parseLimit(q.limit);
    const f: Record<string, unknown> = { ...filters(q, ['from', 'to', 'name', 'outcome']), ...this.cursorTs(q, 'uuid') };
    if (f.outcome && !['running', 'ok', 'failed', 'skipped'].includes(String(f.outcome))) throw fieldError('/outcome', 'outcome is running, ok, failed or skipped.');
    const rows = await this.db.tx.$queryRaw<{ id: string; name: string; started_text: string; started_at: Date; finished_at: Date | null; outcome: string; rows: bigint | null; error: string | null; detail: unknown; host: string | null }[]>(Prisma.sql`
      SELECT j.id::text AS id, j.name, log_ts_text(j.started_at) AS started_text, j.started_at, j.finished_at, j.outcome, j.rows, j.error, j.detail, j.host
      FROM log_job_runs_read(${JSON.stringify(f)}::jsonb, ${limit + 1}::int) j ORDER BY j.started_at DESC, j.id DESC`);
    const items = rows.map((r) => ({ id: r.id, name: r.name, started_at: r.started_text, finished_at: r.finished_at, outcome: r.outcome, rows: r.rows === null ? null : Number(r.rows), error: r.error, detail: r.detail ?? null, host: r.host }));
    return this.page(items, limit, (l) => [l.started_at, l.id]);
  }

  async deployments(q: Query) {
    const limit = parseLimit(q.limit);
    const c = decodeCursor(oneParam(q, 'cursor'), 1);
    if (c && !/^[0-9]{1,18}$/.test(c[0] as string)) throw problems.badRequest('The cursor is not valid.');
    const rows = await this.db.tx.$queryRaw<{ id: bigint; deployed_at: Date; version: string; git_sha: string | null; migrations: string[]; deployed_by: string | null; host: string | null }[]>(Prisma.sql`
      SELECT * FROM log_deployments_read(${c ? Number(c[0]) : null}::bigint, ${limit + 1}::int)`);
    const items = rows.map((r) => ({ id: r.id.toString(), at: r.deployed_at, version: r.version, git_sha: r.git_sha, migrations: r.migrations, by: r.deployed_by, host: r.host }));
    return this.page(items, limit, (l) => [l.id]);
  }

  // ------------------------------------------------------------------ security alerts
  async alerts(q: Query) {
    const limit = parseLimit(q.limit);
    const status = oneParam(q, 'status');
    if (status && !['open', 'acknowledged'].includes(status)) throw fieldError('/status', 'status is open or acknowledged.');
    const rule = oneParam(q, 'rule');
    const f: Record<string, unknown> = { ...(status ? { status } : {}), ...(rule ? { rule } : {}) };
    const total = await this.db.tx.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT sec_alerts_count(${JSON.stringify(f)}::jsonb) AS n`);
    Object.assign(f, this.cursorTs(q, 'uuid'));
    const rows = await this.db.tx.$queryRaw<{ id: string; created_text: string; rule: string; severity: string; status: string; title: string; detail: Record<string, unknown> | null;
      user_id: string | null; ip: string | null; acknowledged_at: Date | null; acknowledged_by: string | null; ack_note: string | null }[]>(Prisma.sql`
      SELECT a.id::text AS id, log_ts_text(a.created_at) AS created_text, a.rule, a.severity, a.status, a.title, a.detail, a.user_id::text AS user_id, a.ip,
             a.acknowledged_at, a.acknowledged_by::text AS acknowledged_by, a.ack_note
      FROM sec_alerts_read(${JSON.stringify(f)}::jsonb, ${limit + 1}::int) a ORDER BY a.created_at DESC, a.id DESC`);
    const u = await this.users(rows.flatMap((r) => [r.user_id, r.acknowledged_by]));
    const items = rows.map((r) => ({
      id: r.id, at: r.created_text, rule: r.rule, severity: r.severity, summary: r.title, detail: alertDetail(r.rule, r.detail), data: r.detail, status: r.status,
      user: r.user_id ? u.get(r.user_id) ?? null : null, ip: r.ip, ack_by: r.acknowledged_by ? u.get(r.acknowledged_by)?.display_name ?? null : null,
      ack_by_user: r.acknowledged_by ? u.get(r.acknowledged_by) ?? null : null, ack_at: r.acknowledged_at, ack_note: r.ack_note,
    }));
    return this.page(items, limit, (l) => [l.at, l.id], Number(total[0]?.n ?? 0));
  }

  async ack(id: string, raw: unknown) {
    const { note } = parse(ackInput, raw);
    if (!uuidSchema.safeParse(id).success) throw problems.notFound('The alert does not exist.');
    await this.db.tx.$queryRaw(Prisma.sql`SELECT (sec_alert_ack(${id}::uuid, ${note}::text)).id::text AS id`);
    const r = await this.alerts({ limit: '200' });
    const found = r.items.find((a) => a.id === id);
    if (found) return found;
    throw problems.notFound('The alert does not exist.');
  }

  // ------------------------------------------------------------------ settings
  private async settingsDto(j: Record<string, unknown>): Promise<Record<string, unknown> & { version: number }> {
    const by = typeof j.updated_by === 'string' ? (await this.users([j.updated_by])).get(j.updated_by) ?? null : null;
    return { ...j, version: Number(j.version), updated_by: by };
  }

  private async requireSettingsView(auth: AuthContext): Promise<void> {
    if (auth.state.isAdmin) return;
    const r = await this.db.tx.$queryRaw<{ ok: boolean }[]>(Prisma.sql`SELECT app_has_permission(${auth.user.id}::uuid, 'admin.settings', 'view'::"PermissionAction") AS ok`);
    if (!r[0]?.ok) throw new ProblemException(403, 'module_forbidden', { detail: 'You cannot use the Settings screen.' });
  }

  async retention(auth: AuthContext) {
    await this.requireSettingsView(auth);
    const r = await this.db.tx.$queryRaw<{ j: Record<string, unknown> }[]>`SELECT log_retention_json() AS j`;
    return this.settingsDto(r[0]!.j);
  }

  async setRetention(auth: AuthContext, ifMatch: string | undefined, raw: unknown) {
    const version = parseIfMatch(ifMatch);
    const b = parse(retentionInput, raw);
    const cur = await this.db.tx.$queryRaw<{ j: { system_log_days: number; security_log_days: number } }[]>`SELECT log_retention_json() AS j`;
    const c = cur[0]!.j;
    if (b.system_log_days < c.system_log_days || b.security_log_days < c.security_log_days) await this.stepUp.require(auth);
    const r = await this.db.tx.$queryRaw<{ j: Record<string, unknown> }[]>(Prisma.sql`
      SELECT log_set_retention(${b.system_log_days}::int, ${b.security_log_days}::int, ${b.reason}::text, ${version}::int) AS j`);
    return this.settingsDto(r[0]!.j);
  }

  async alertSettings(auth: AuthContext) {
    await this.requireSettingsView(auth);
    const r = await this.db.tx.$queryRaw<{ j: Record<string, unknown> }[]>`SELECT log_alert_settings_json() AS j`;
    return this.settingsDto(r[0]!.j);
  }

  async setAlertSettings(auth: AuthContext, ifMatch: string | undefined, raw: unknown) {
    const version = parseIfMatch(ifMatch);
    const b = parse(alertInput, raw);
    const { reason, ...rest } = b;
    // weakening any threshold is a reduction of a security control: step-up first (the database checks it again and raises an alert)
    type Win = { count: number; minutes: number };
    const c = (await this.db.tx.$queryRaw<{ j: { failed_sign_ins?: Win; failed_by_ip?: Win; large_export_rows?: number; new_ip?: boolean; severity?: Record<string, string>;
      email_min_severity?: string; trusted_networks?: string[] } }[]>`SELECT log_alert_settings_json() AS j`)[0]!.j;
    const weakened = rest.failed_sign_ins.count > (c.failed_sign_ins?.count ?? Infinity) || rest.failed_sign_ins.minutes < (c.failed_sign_ins?.minutes ?? 0)
      || rest.failed_by_ip.count > (c.failed_by_ip?.count ?? Infinity) || rest.failed_by_ip.minutes < (c.failed_by_ip?.minutes ?? 0)
      || rest.large_export_rows > (c.large_export_rows ?? Infinity) || (c.new_ip !== false && rest.new_ip === false)
      || (rest.email_min_severity !== undefined && SEVERITIES.indexOf(rest.email_min_severity) > SEVERITIES.indexOf((c.email_min_severity ?? 'low') as (typeof SEVERITIES)[number]))
      || Object.entries(rest.severity ?? {}).some(([k, v]) => c.severity?.[k] !== undefined && SEVERITIES.indexOf(v) < SEVERITIES.indexOf(c.severity[k] as (typeof SEVERITIES)[number]))
      || (rest.trusted_networks ?? []).some((n) => !(c.trusted_networks ?? []).includes(n));
    if (weakened) await this.stepUp.require(auth);
    const r = await this.db.tx.$queryRaw<{ j: Record<string, unknown> }[]>(Prisma.sql`
      SELECT log_set_alert_settings(${JSON.stringify(rest)}::jsonb, ${reason}::text, ${version}::int) AS j`);
    return this.settingsDto(r[0]!.j);
  }

  // ------------------------------------------------------------------ monthly activity report
  async activity(q: Query) {
    const month = oneParam(q, 'month');
    if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw fieldError('/month', 'month is YYYY-MM.');
    const r = await this.db.tx.$queryRaw<{ j: { month: string; from: string; to: string; scope: string; includes_security_log: boolean;
      users: { user: NonNullable<UserRef>; actions: number; field_changes: number; approvals: number; sign_ins: number | null; failures: number | null }[];
      sensitive_changes: { id: number; at: string; action: string; entity_type: string; entity_id: string | null; actor_id: string | null; reason: string | null; is_admin_override: boolean; kind: string }[] } }[]>(Prisma.sql`
      SELECT log_activity_report(${`${month}-01`}::date) AS j`);
    const j = r[0]!.j;
    const u = await this.users(j.sensitive_changes.map((s) => s.actor_id));
    return {
      month: j.month, from: j.from, to: j.to, scope: j.scope, includes_security_log: j.includes_security_log,
      users: j.users.map((x) => ({ user: x.user, actions: x.actions, field_changes: x.field_changes, approvals: x.approvals, sign_ins: x.sign_ins, failed_sign_ins: x.failures })),
      sensitive: j.sensitive_changes.map((s) => ({
        id: s.id, at: s.at, actor: s.actor_id ? u.get(s.actor_id) ?? null : null, action: s.action, entity_type: s.entity_type, entity_id: s.entity_id,
        entity_label: s.entity_id ? `${s.entity_type} ${s.entity_id}` : s.entity_type, kind: s.kind, reason: s.reason, is_admin_override: s.is_admin_override,
        summary: s.reason ? `${s.action}: ${s.reason}` : s.action,
      })),
    };
  }

  /** GET /reports/activity?format=xlsx (owner answer Q169): the six sheets; the security log is not part of it. Audited as report.activity_export. */
  async activityXlsx(auth: AuthContext, q: Query): Promise<{ filename: string; body: Buffer }> {
    const rep = await this.activity(q);
    const month = rep.month;
    const r = await this.db.tx.$queryRaw<{ j: { from: string; to: string; time_zone: string; scope: string; regions: 'all' | number[]; modules: WorkbookInput['modules'];
      exports: WorkbookInput['exports']; exceptions: WorkbookInput['exceptions']; exports_truncated: boolean; exceptions_truncated: boolean } }[]>(Prisma.sql`
      SELECT log_activity_workbook(${`${month}-01`}::date) AS j`);
    const j = r[0]!.j;
    const people = await this.users([...j.exports.map((x) => x.actor_id), ...j.exceptions.flatMap((x) => [x.actor_id, x.on_behalf_of])]);
    const regions = await this.db.tx.$queryRaw<{ id: number; name_en: string }[]>`SELECT id, name_en FROM regions ORDER BY id`;
    const body = await activityWorkbook({
      month, from: j.from, to: j.to, timeZone: j.time_zone, scope: j.scope, regions: j.regions, regionNames: new Map(regions.map((x) => [x.id, x.name_en])),
      generatedAt: new Date(), generatedBy: { id: auth.user.id, display_name: auth.user.displayName, employee_id: auth.user.employeeId ?? null },
      users: rep.users.map((u) => ({ user: u.user, actions: u.actions, field_changes: u.field_changes, approvals: u.approvals })),
      modules: j.modules, exports: j.exports, exceptions: j.exceptions, exportsTruncated: j.exports_truncated, exceptionsTruncated: j.exceptions_truncated, people,
    });
    return { filename: `GSDN_ActivityReport_${month}.xlsx`, body };
  }

  // ------------------------------------------------------------------ exports (CSV jobs through document_export_jobs and the object storage)
  private async requireExport(auth: AuthContext, kind: 'audit_export' | 'security_export'): Promise<void> {
    if (auth.state.isAdmin) return;
    const r = await this.db.tx.$queryRaw<{ ok: boolean }[]>(kind === 'audit_export'
      ? Prisma.sql`SELECT app_has_permission(${auth.user.id}::uuid, 'audit', 'export'::"PermissionAction") AS ok`
      : Prisma.sql`SELECT sec_can_read() AND app_has_permission(${auth.user.id}::uuid, 'admin.security_log', 'export'::"PermissionAction") AS ok`);
    if (!r[0]?.ok) throw new ProblemException(403, 'action_forbidden', { detail: 'You need the export grant for this log.' });
  }

  async startExport(auth: AuthContext, kind: 'audit_export' | 'security_export', raw: unknown, idemKey: string | undefined, onStarted: (go: () => void) => void) {
    await this.requireExport(auth, kind);
    const body = kind === 'audit_export' ? parse(exportAuditBody, raw) : parse(exportSecBody, raw);
    const asQuery: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) asQuery[k] = Array.isArray(v) ? v.join(',') : v === undefined ? undefined : String(v);
    const f = filters(asQuery, kind === 'audit_export' ? AUDIT_FILTERS : SEC_FILTERS);
    return this.idem.run(auth.user.id, kind === 'audit_export' ? 'exportAuditLog' : 'exportSecurityLog', idemKey, body, async () => {
      // the reader right is checked now (a forbidden reader gets 403 at once), and the exact count of the rows (owner answer Q170: above the cap the export
      // is refused with the count, never cut; the refusal is audited)
      const counted = await this.db.tx.$queryRaw<{ n: bigint }[]>(kind === 'audit_export'
        ? Prisma.sql`SELECT log_audit_count(${JSON.stringify(f)}::jsonb) AS n`
        : Prisma.sql`SELECT sec_log_count(${JSON.stringify(f)}::jsonb) AS n`);
      const total = Number(counted[0]?.n ?? 0);
      if (total > this.exportMaxRows) {
        await this.db.tx.$queryRaw(Prisma.sql`SELECT log_audit_write(${kind === 'audit_export' ? 'audit_log.export_refused' : 'security_log.export_refused'}::text,
          ${kind === 'audit_export' ? 'audit_log' : 'security_log'}::text, NULL, NULL, ${JSON.stringify({ filters: f, matching_rows: total, max_rows: this.exportMaxRows })}::jsonb, NULL)`);
        throw new ProblemException(422, 'too_many_rows', {
          detail: `${total} rows match, more than ${this.exportMaxRows} per file. Narrow the filters (for example a shorter date range) or export the period in parts.`,
          extra: { row_count: total, max_rows: this.exportMaxRows },
          errors: [{ path: '/from', code: 'too_many_rows', message: 'Choose a shorter period or more filters.' }],
          commit: true,
        });
      }
      const r = await this.db.tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT doc_job_create(${JSON.stringify({ kind, filters: f })}::jsonb)::text AS id`);
      const id = r[0]!.id;
      await this.db.tx.$queryRaw(Prisma.sql`SELECT log_audit_write(${kind === 'audit_export' ? 'audit_log.export_start' : 'security_log.export_start'}::text,
        ${kind === 'audit_export' ? 'audit_log' : 'security_log'}::text, ${id}::text, NULL, ${JSON.stringify({ filters: f })}::jsonb, NULL)`);
      const admin = auth.state.isAdmin;
      const ctx = { session: auth.session.id };
      onStarted(() => this.schedule(id, kind, auth.user.id, admin, f, ctx.session));
      return { id, kind, status: 'queued', progress: 0, result_file_id: null, created_at: new Date(), finished_at: null };
    });
  }

  private schedule(id: string, kind: 'audit_export' | 'security_export', userId: string, admin: boolean, f: Record<string, unknown>, sessionId: string): void {
    const p = this.work(id, kind, userId, admin, f, sessionId).catch((e) => this.log.warn(`export ${id}: ${e instanceof Error ? e.message : String(e)}`)).finally(() => this.running.delete(p));
    this.running.add(p);
  }

  private inContext<T>(userId: string, admin: boolean, sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.db.client.$transaction(async (tx) => {
      // The requester's rights are derived by the database (app_begin); `admin` is no longer sent.
      void admin;
      await applyContext(tx, { ...jobContext('log_export'), userId, sessionId });
      return this.db.runIn(tx, fn);
    }, { maxWait: 10_000, timeout: 600_000 });
  }

  private async work(id: string, kind: 'audit_export' | 'security_export', userId: string, admin: boolean, f: Record<string, unknown>, sessionId: string): Promise<void> {
    await new Promise((r) => setTimeout(r, 25));
    try {
      await this.inContext(userId, admin, sessionId, async () => {
        await this.db.tx.$executeRaw(Prisma.sql`SELECT doc_job_update(${id}::uuid, 'running', 0, NULL, NULL, NULL, NULL)`);
        let header: string[];
        let lines: unknown[][];
        if (kind === 'audit_export') {
          const rows = await this.db.tx.$queryRaw<AuditRow[]>(this.auditSql({ ...f, no_audit: true }, this.exportMaxRows + 1));
          if (rows.length > this.exportMaxRows) throw new Error(`too_many_rows: more than ${this.exportMaxRows} rows match now; narrow the filters`);
          const u = await this.users(rows.flatMap((r) => [r.actor_id, r.on_behalf_of]));
          header = ['id', 'at', 'actor', 'actor_employee_id', 'on_behalf_of', 'action', 'entity_type', 'entity_id', 'site_code', 'region_id', 'module_key', 'reason', 'admin_override',
            'via', 'ip', 'device', 'session_id', 'auth_method', 'mfa', 'request_id', 'before', 'after'];
          lines = rows.map((r) => {
            const d = this.auditDto(r, u);
            return [d.id, d.at, d.actor?.display_name, d.actor?.employee_id, d.on_behalf_of?.display_name, d.action, d.entity_type, d.entity_id, d.site_code, d.region_id, d.module_key, d.reason,
              d.is_admin_override, d.via, d.ip, d.device, d.session_id, d.auth_method, d.mfa, d.request_id, d.before, d.after];
          });
        } else {
          const res = await this.db.tx.$queryRaw<{ id: bigint; at_text: string; event: string; outcome: string; user_id: string | null; identifier_hash: string | null; ip: string | null; user_agent: string | null;
            session_id: string | null; request_id: string | null; detail: unknown }[]>(Prisma.sql`
            SELECT s.*, log_ts_text(s.at) AS at_text FROM sec_log_read(${JSON.stringify({ ...f, no_audit: true })}::jsonb, ${this.exportMaxRows + 1}::int) s ORDER BY s.at DESC, s.id DESC`);
          if (res.length > this.exportMaxRows) throw new Error(`too_many_rows: more than ${this.exportMaxRows} rows match now; narrow the filters`);
          const u = await this.users(res.map((r) => r.user_id));
          header = ['id', 'at', 'event', 'outcome', 'user', 'employee_id', 'identifier_masked', 'ip', 'device', 'session_id', 'request_id', 'details'];
          lines = res.map((r) => [Number(r.id), r.at_text, r.event, r.outcome, r.user_id ? u.get(r.user_id)?.display_name : '', r.user_id ? u.get(r.user_id)?.employee_id : '',
            r.user_id ? '' : r.identifier_hash, r.ip, parseDevice(r.user_agent), r.session_id, r.request_id, r.detail]);
        }
        const csv = '﻿' + [header, ...lines].map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
        const buf = Buffer.from(csv, 'utf8');
        const key = newObjectKey('exports');
        await this.storage.store.putGenerated(key, buf);   // Q195: generated by the PMIS, no user file inside: not sent to the scanner
        await this.db.tx.$executeRaw(Prisma.sql`SELECT doc_job_update(${id}::uuid, 'done', 1, ${lines.length}::int, ${buf.length}::bigint, ${key}::text, NULL)`);
        await this.db.tx.$queryRaw(Prisma.sql`SELECT log_audit_write(${kind === 'audit_export' ? 'audit_log.export_done' : 'security_log.export_done'}::text,
          ${kind === 'audit_export' ? 'audit_log' : 'security_log'}::text, ${id}::text, NULL, ${JSON.stringify({ row_count: lines.length, size_bytes: buf.length, filters: f })}::jsonb, NULL)`);
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message.split('\n')[0] ?? 'failed' : 'failed';
      await this.inContext(userId, admin, sessionId, () => this.db.tx.$executeRaw(Prisma.sql`SELECT doc_job_update(${id}::uuid, 'failed', NULL, NULL, NULL, NULL, ${msg.slice(0, 300)}::text)`)).catch(() => undefined);
      await this.syslog.write('error', 'log export failed', { job_id: id, kind, error: msg });
    }
  }

  async downloadExport(auth: AuthContext, kind: 'audit_export' | 'security_export', id: string) {
    if (!uuidSchema.safeParse(id).success) throw problems.notFound('The export does not exist.');
    const rows = await this.db.tx.$queryRaw<JobRow[]>(Prisma.sql`SELECT * FROM document_export_jobs WHERE id = ${id}::uuid`);
    const j = rows[0];
    if (!j || j.scope?.kind !== kind || j.requested_by !== auth.user.id) throw problems.notFound('The export does not exist.');
    if (j.status !== 'done' || !j.storage_key) throw new ProblemException(409, 'invalid_transition', { detail: `The export is ${j.status}.` });
    if (j.expires_at && j.expires_at.getTime() < Date.now()) throw new ProblemException(410, 'export_expired', { detail: 'The export has expired: start it again.' });
    const name = `GSDN_${kind === 'audit_export' ? 'AuditLog' : 'SecurityLog'}_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.csv`;
    await this.db.tx.$queryRaw(Prisma.sql`SELECT log_audit_write(${kind === 'audit_export' ? 'audit_log.export_download' : 'security_log.export_download'}::text,
      ${kind === 'audit_export' ? 'audit_log' : 'security_log'}::text, ${id}::text, NULL, ${JSON.stringify({ export_id: id, download_name: name, row_count: j.file_count })}::jsonb, NULL)`);
    return {
      file: new StreamableFile(await this.storage.store.get(j.storage_key), { type: 'text/csv; charset=utf-8', disposition: attachmentHeader(name), length: Number(j.size_bytes) }),
      headers: { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' },
    };
  }
}

/** A one-line text for the alert list (the structured data stays in `data`). */
function alertDetail(rule: string, d: Record<string, unknown> | null): string | null {
  if (!d) return null;
  switch (rule) {
    case 'failed_sign_ins': return `At least ${String(d.count_at_least)} failures within ${String(d.minutes)} minutes (key ${String(d.key)}).`;
    case 'failed_sign_ins_ip': return `At least ${String(d.count_at_least)} failures within ${String(d.minutes)} minutes from ${String(d.ip)}.`;
    case 'new_ip': return `Sign-in from ${String(d.ip)}, an address not used by this person before.`;
    case 'large_export': return `${String(d.action)}: ${String(d.rows)} rows (threshold ${String(d.threshold)}).`;
    case 'admin_set_changed': return `${String(d.action)} (audit row ${String(d.audit_id)}).`;
    case 'retention_reduced': return `Retention reduced (audit row ${String(d.audit_id)}).`;
    case 'audit_integrity_failure': return `${String(d.log)} log: ${String(d.break_count)} break(s).`;
    default: return null;
  }
}
