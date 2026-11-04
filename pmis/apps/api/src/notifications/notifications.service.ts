import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { decodeTypedCursor, encodeCursor, parseLimit } from '../common/cursor';
import { ProblemException, problems } from '../common/problem';
import { TS_TEXT, boolParam, oneParam } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';

/** The kinds the contract lists; any other kind written by the database is shown as `system`. */
const KINDS = new Set([
  'task_assigned', 'task_returned', 'task_approved', 'approval_due', 'reassigned', 'absence_alert', 'idle_task_alert', 'no_holder', 'holiday_tentative',
  'delegation', 'mfa_exemption', 'template_updated', 'import_batch', 'system', 'mention', 'task_rejected', 'no_eligible_holder', 'register_assigned',
  'register_rejected', 'gate_closed_again', 'sla_negative_duration', 'followed_change', 'email_change_requested', 'email_change_decided', 'security_alert',
  'levels_converted', 'permit_transferred',
]);

const snoozeSchema = z
  .object({ until: z.union([z.string().datetime({ offset: true }), z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()]) })
  .strict();

interface Row {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  task_id: string | null;
  link: string | null;
  created_at: Date;
  read_at: Date | null;
  snoozed_until: Date | null;
  ts?: string;
}

export interface NotificationDto {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  entity_type: string | null;
  entity_id: string | null;
  type_code: null;
  link: string | null;
  created_at: Date;
  read_at: Date | null;
  snoozed_until: Date | null;
}

const COLS = Prisma.sql`n.id::text AS id, n.kind, n.title, n.body, n.task_id::text AS task_id, n.link, n.created_at, n.read_at, n.snoozed_until`;

function dto(r: Row): NotificationDto {
  return {
    id: r.id,
    kind: KINDS.has(r.kind) ? r.kind : 'system',
    title: r.title,
    body: r.body,
    entity_type: r.task_id ? 'task' : null,
    entity_id: r.task_id,
    type_code: null,
    link: r.link,
    created_at: r.created_at,
    read_at: r.read_at,
    snoozed_until: r.snoozed_until,
  };
}

/**
 * X1: the inbox. Row-level security limits every statement to the caller's own rows; the explicit user_id filter repeats it.
 * A notification that points at a task or a register record (region_id, module_key, filled by the database when it is written) is shown only while the caller
 * can still read that module in that region: a region or module taken away later hides it, its count and its title. Every change is audited (one audit row per call).
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly db: DbService, private readonly access: AccessService) {}

  /** The notifications of `me` that the caller may still see (personal ones have no module). */
  private async visible(me: string): Promise<Prisma.Sql> {
    const mods = await this.db.tx.$queryRaw<{ m: string }[]>(Prisma.sql`SELECT DISTINCT n.module_key AS m FROM notifications n WHERE n.user_id = ${me}::uuid AND n.module_key IS NOT NULL`);
    const parts: Prisma.Sql[] = [Prisma.sql`n.module_key IS NULL`];
    for (const { m } of mods) {
      const regs = await this.access.regions(m, 'view');
      if (regs === null) parts.push(Prisma.sql`n.module_key = ${m}`);
      else if (regs.length > 0) parts.push(Prisma.sql`(n.module_key = ${m} AND (n.region_id IS NULL OR n.region_id = ANY(${regs}::int[])))`);
    }
    return Prisma.sql`(${Prisma.join(parts, ' OR ')})`;
  }

  async list(auth: AuthContext, q: Record<string, unknown>) {
    const limit = parseLimit(oneParam(q, 'limit'));
    const cursor = decodeTypedCursor(oneParam(q, 'cursor'), ['ts', 'uuid']);
    const unreadOnly = boolParam(q, 'unread_only') === true;
    const snoozed = oneParam(q, 'snoozed') ?? 'hide';
    if (!['hide', 'only', 'include'].includes(snoozed)) throw problems.validation([{ path: '/snoozed', code: 'invalid', message: 'snoozed is hide, only or include.' }]);
    const kind = oneParam(q, 'kind');
    if (kind && !KINDS.has(kind)) throw problems.validation([{ path: '/kind', code: 'invalid', message: 'Unknown notification kind.' }]);
    const me = auth.user.id;
    const seen = await this.visible(me);
    const conds: Prisma.Sql[] = [Prisma.sql`n.user_id = ${me}::uuid`, Prisma.sql`n.channel = 'in_app'`, seen];
    if (unreadOnly) conds.push(Prisma.sql`n.read_at IS NULL`);
    if (snoozed === 'hide') conds.push(Prisma.sql`(n.snoozed_until IS NULL OR n.snoozed_until <= now())`);
    if (snoozed === 'only') conds.push(Prisma.sql`n.snoozed_until > now()`);
    if (kind) conds.push(Prisma.sql`n.kind = ${kind}`);
    if (cursor) conds.push(Prisma.sql`(n.created_at, n.id) < (${cursor[0] as string}::timestamptz, ${cursor[1] as string}::uuid)`);
    const rows = await this.db.tx.$queryRaw<Row[]>(Prisma.sql`
      SELECT ${COLS}, ${Prisma.raw(TS_TEXT('n.created_at'))} AS ts FROM notifications n WHERE ${Prisma.join(conds, ' AND ')}
      ORDER BY n.created_at DESC, n.id DESC LIMIT ${limit + 1}`);
    const unread = await this.db.tx.$queryRaw<{ n: bigint }[]>(Prisma.sql`
      SELECT count(*) AS n FROM notifications n WHERE n.user_id = ${me}::uuid AND n.channel = 'in_app' AND n.read_at IS NULL AND (n.snoozed_until IS NULL OR n.snoozed_until <= now()) AND ${seen}`);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(dto),
      page: { limit, next_cursor: rows.length > limit && last?.ts ? encodeCursor([last.ts, last.id]) : null },
      unread_count: Number(unread[0]?.n ?? 0),
    };
  }

  private async audit(auth: AuthContext, action: string, id: string | null, before: unknown, after: unknown): Promise<void> {
    void auth;
    await this.db.tx.$queryRaw(Prisma.sql`SELECT log_audit_write(${action}::text, 'notification', ${id}::text, ${JSON.stringify(before)}::jsonb, ${JSON.stringify(after)}::jsonb, NULL)`);
  }

  private async change(auth: AuthContext, id: string, action: string, set: Prisma.Sql): Promise<NotificationDto> {
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    const seen = await this.visible(auth.user.id);
    const old = await this.db.tx.$queryRaw<Row[]>(Prisma.sql`SELECT ${COLS} FROM notifications n WHERE n.id = ${id}::uuid AND n.user_id = ${auth.user.id}::uuid AND n.channel = 'in_app' AND ${seen}`);
    if (!old[0]) throw problems.notFound('The notification does not exist.');
    await this.db.tx.$executeRaw(Prisma.sql`UPDATE notifications SET ${set} WHERE id = ${id}::uuid AND user_id = ${auth.user.id}::uuid`);
    const row = (await this.db.tx.$queryRaw<Row[]>(Prisma.sql`SELECT ${COLS} FROM notifications n WHERE n.id = ${id}::uuid`))[0] as Row;
    await this.audit(auth, action, id, { read_at: old[0].read_at, snoozed_until: old[0].snoozed_until }, { read_at: row.read_at, snoozed_until: row.snoozed_until });
    return dto(row);
  }

  read(auth: AuthContext, id: string): Promise<NotificationDto> {
    return this.change(auth, id, 'notification_read', Prisma.sql`read_at = coalesce(read_at, now())`);
  }

  unread(auth: AuthContext, id: string): Promise<NotificationDto> {
    return this.change(auth, id, 'notification_unread', Prisma.sql`read_at = NULL`);
  }

  async snooze(auth: AuthContext, id: string, raw: unknown): Promise<NotificationDto> {
    const b = parse(snoozeSchema, raw);
    if (b.until === null) return this.change(auth, id, 'notification_snooze', Prisma.sql`snoozed_until = NULL`);
    // A plain date means the start of that day in Tripoli time; it must be in the future and within a year.
    const at = /^\d{4}-\d{2}-\d{2}$/.test(b.until) ? Prisma.sql`(${b.until}::date)::timestamp AT TIME ZONE 'Africa/Tripoli'` : Prisma.sql`${b.until}::timestamptz`;
    const ok = await this.db.tx.$queryRaw<{ ok: boolean }[]>(Prisma.sql`SELECT (${at} > now() AND ${at} <= now() + interval '1 year') AS ok`);
    if (!ok[0]?.ok) throw new ProblemException(422, 'validation_failed', { detail: 'The snooze date must be in the future and within one year.', errors: [{ path: '/until', code: 'invalid', message: 'Choose a later date, within one year.' }] });
    return this.change(auth, id, 'notification_snooze', Prisma.sql`snoozed_until = ${at}`);
  }

  async readAll(auth: AuthContext): Promise<void> {
    const seen = await this.visible(auth.user.id);
    const n = await this.db.tx.$executeRaw(Prisma.sql`UPDATE notifications n SET read_at = now()
      WHERE n.user_id = ${auth.user.id}::uuid AND n.channel = 'in_app' AND n.read_at IS NULL AND (n.snoozed_until IS NULL OR n.snoozed_until <= now()) AND ${seen}`);
    if (n > 0) await this.audit(auth, 'notification_read_all', null, null, { count: n });
  }
}
