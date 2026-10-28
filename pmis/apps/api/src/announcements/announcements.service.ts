import { Injectable, StreamableFile } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth.types';
import { decodeCursor, encodeCursor, parseLimit } from '../common/cursor';
import { pgInfo } from '../common/db-errors';
import { ProblemException, problems } from '../common/problem';
import { oneParam, Query, TS_TEXT } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import type { DepartmentRef, UserRef } from '../users/users.repo';

const ids = (max: number) => z.array(z.string().uuid()).max(max).default([]);
const sendSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(5000),
  audience: z.object({
    all: z.boolean().default(false),
    user_ids: ids(500),
    group_ids: ids(100),
    role_ids: ids(100),
    department_ids: ids(100),
  }).strict(),
}).strict();
const respondSchema = z.object({
  decision: z.enum(['agree', 'disagree']),
  note: z.string().max(2000).nullable().optional(),
}).strict();

export interface AnnouncementSummaryDto {
  id: string;
  title: string;
  created_at: Date;
  created_by: UserRef;
  recipient_count: number;
  agree_count: number;
  disagree_count: number;
  pending_count: number;
}
export interface AnnouncementDetailDto extends AnnouncementSummaryDto {
  body: string;
  audience: {
    all: boolean;
    users: UserRef[];
    groups: { id: string; name: string; is_system_admins: boolean }[];
    roles: { id: string; code: string; name_en: string; name_ar: string | null; parent_role_id: string | null }[];
    departments: DepartmentRef[];
  };
}
export interface AnnouncementResponseDto {
  user: UserRef;
  department: DepartmentRef | null;
  decision: 'agree' | 'disagree' | 'pending';
  note: string | null;
  responded_at: Date | null;
}
export interface PendingAnnouncementDto {
  id: string;
  title: string;
  body: string;
  created_at: Date;
  created_by: UserRef;
}

interface HeadRow {
  id: string;
  title: string;
  body: string;
  audience_all: boolean;
  created_at: Date;
  cursor_ts: string;
  by_id: string;
  by_name: string;
  by_emp: string | null;
  can_read: boolean;
  recipient_count: bigint;
  agree_count: bigint;
  disagree_count: bigint;
}

const HEAD = Prisma.sql`a.id::text AS id, a.title, a.body, a.audience_all, a.created_at, ${Prisma.raw(TS_TEXT('a.created_at'))} AS cursor_ts,
  cb.id::text AS by_id, cb.display_name AS by_name, trim(cb.employee_id) AS by_emp, ann_can_read_results(a.id) AS can_read,
  (SELECT count(*) FROM announcement_recipients r WHERE r.announcement_id = a.id) AS recipient_count,
  (SELECT count(*) FROM announcement_responses s WHERE s.announcement_id = a.id AND s.decision = 'agree') AS agree_count,
  (SELECT count(*) FROM announcement_responses s WHERE s.announcement_id = a.id AND s.decision = 'disagree') AS disagree_count`;

const ref = (id: string, name: string, emp: string | null): UserRef => ({ id, display_name: name, employee_id: emp });

/** Counts are only meaningful for the sender and System Admins; a recipient sees the row-level-security slice, so they get zeros. */
function summary(r: HeadRow): AnnouncementSummaryDto {
  const recipients = r.can_read ? Number(r.recipient_count) : 0;
  const agree = r.can_read ? Number(r.agree_count) : 0;
  const disagree = r.can_read ? Number(r.disagree_count) : 0;
  return {
    id: r.id,
    title: r.title,
    created_at: r.created_at,
    created_by: ref(r.by_id, r.by_name, r.by_emp),
    recipient_count: recipients,
    agree_count: agree,
    disagree_count: disagree,
    pending_count: recipients - agree - disagree,
  };
}

/** Spreadsheet formula characters at the start of a cell are neutralised (CSV injection). */
function csvCell(v: string | null | undefined): string {
  let s = v ?? '';
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

@Injectable()
export class AnnouncementsService {
  constructor(private readonly db: DbService) {}

  async send(raw: unknown): Promise<AnnouncementSummaryDto> {
    const b = parse(sendSchema, raw);
    const a = b.audience;
    // ann_send refuses with insufficient_privilege (403) for non-admins and region-limited delegates, and raises
    // 'no active recipient' (422 no_recipients) when the audience is empty.
    const rows = await this.db.tx.$queryRaw<{ id: string }[]>`SELECT ann_send(${b.title}::text, ${b.body}::text, ${a.all}::boolean,
      ${a.user_ids}::uuid[], ${a.group_ids}::uuid[], ${a.role_ids}::uuid[], ${a.department_ids}::uuid[])::text AS id`;
    const head = await this.head(rows[0]!.id);
    if (!head) throw new ProblemException(500, 'internal_error', {});
    return summary(head);
  }

  async list(q: Query): Promise<{ items: AnnouncementSummaryDto[]; page: { limit: number; next_cursor: string | null; total: number } }> {
    const limit = parseLimit(oneParam(q, 'limit'));
    const cursor = decodeCursor(oneParam(q, 'cursor'), 2);
    if (cursor && !uuidSchema.safeParse(cursor[1]).success) throw problems.badRequest('The cursor is not valid.');
    const page = cursor ? Prisma.sql`AND (a.created_at, a.id) < (${cursor[0] as string}::timestamptz, ${cursor[1] as string}::uuid)` : Prisma.empty;
    // Row-level security also lets recipients see the row; the list is "mine to manage" only.
    const rows = await this.db.tx.$queryRaw<HeadRow[]>(Prisma.sql`SELECT ${HEAD} FROM announcements a JOIN users cb ON cb.id = a.created_by
      WHERE ann_can_read_results(a.id) ${page} ORDER BY a.created_at DESC, a.id DESC LIMIT ${limit + 1}`);
    const total = await this.db.tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM announcements a WHERE ann_can_read_results(a.id)`;
    const last = rows[limit - 1];
    return {
      items: rows.slice(0, limit).map(summary),
      page: { limit, next_cursor: rows.length > limit && last ? encodeCursor([last.cursor_ts, last.id]) : null, total: Number(total[0]?.n ?? 0) },
    };
  }

  async get(id: string): Promise<AnnouncementDetailDto> {
    const r = await this.head(id);
    if (!r) throw problems.notFound();
    const base = summary(r);
    const empty = { all: r.audience_all, users: [], groups: [], roles: [], departments: [] } as AnnouncementDetailDto['audience'];
    if (!r.can_read) return { ...base, body: r.body, audience: empty };
    const users = await this.db.tx.$queryRaw<{ id: string; display_name: string; emp: string | null }[]>`
      SELECT u.id::text AS id, u.display_name, trim(u.employee_id) AS emp FROM announcement_targets t JOIN users u ON u.id = t.target_id
      WHERE t.announcement_id = ${id}::uuid AND t.kind = 'user' ORDER BY u.display_name, u.id::text`;
    const groups = await this.db.tx.$queryRaw<{ id: string; name: string; is_system_admins: boolean }[]>`
      SELECT g.id::text AS id, g.name, g.is_system_admins FROM announcement_targets t JOIN groups g ON g.id = t.target_id
      WHERE t.announcement_id = ${id}::uuid AND t.kind = 'group' ORDER BY g.name, g.id::text`;
    const roles = await this.db.tx.$queryRaw<{ id: string; code: string; name_en: string; name_ar: string | null; parent_role_id: string | null }[]>`
      SELECT r.id::text AS id, r.code, r.name_en, r.name_ar, r.parent_role_id::text AS parent_role_id FROM announcement_targets t
      JOIN roles r ON r.id = t.target_id WHERE t.announcement_id = ${id}::uuid AND t.kind = 'role' ORDER BY r.name_en, r.id::text`;
    const departments = await this.db.tx.$queryRaw<DepartmentRef[]>`
      SELECT d.id::text AS id, d.code, d.name_en, d.name_ar FROM announcement_targets t JOIN departments d ON d.id = t.target_id
      WHERE t.announcement_id = ${id}::uuid AND t.kind = 'department' ORDER BY d.name_en, d.id::text`;
    return {
      ...base,
      body: r.body,
      audience: { all: r.audience_all, users: users.map((u) => ref(u.id, u.display_name, u.emp)), groups, roles, departments },
    };
  }

  async responses(id: string, q: Query): Promise<{ items: AnnouncementResponseDto[]; page: { limit: number; next_cursor: string | null; total: number } }> {
    const limit = parseLimit(oneParam(q, 'limit'));
    const cursor = decodeCursor(oneParam(q, 'cursor'), 2);
    const decision = oneParam(q, 'decision');
    if (decision !== undefined && !['agree', 'disagree', 'pending'].includes(decision)) {
      throw problems.validation([{ path: '/decision', code: 'invalid', message: 'decision is agree, disagree or pending.' }]);
    }
    await this.requireReader(id);
    const filter = decision === undefined ? Prisma.empty : decision === 'pending' ? Prisma.sql`AND s.user_id IS NULL` : Prisma.sql`AND s.decision = ${decision}`;
    const page = cursor ? Prisma.sql`AND (u.display_name, u.id::text) > (${cursor[0] as string}, ${cursor[1] as string})` : Prisma.empty;
    const rows = await this.responseRows(id, filter, page, limit + 1);
    const total = await this.db.tx.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT count(*) AS n FROM announcement_recipients r
      LEFT JOIN announcement_responses s ON s.announcement_id = r.announcement_id AND s.user_id = r.user_id
      WHERE r.announcement_id = ${id}::uuid ${filter}`);
    const last = rows[limit - 1];
    return {
      items: rows.slice(0, limit).map((r) => r.dto),
      page: { limit, next_cursor: rows.length > limit && last ? encodeCursor([last.dto.user.display_name, last.dto.user.id]) : null, total: Number(total[0]?.n ?? 0) },
    };
  }

  async exportCsv(auth: AuthContext, id: string, requestId: string | undefined): Promise<{ file: StreamableFile; name: string }> {
    await this.requireReader(id);
    const rows = await this.responseRows(id, Prisma.empty, Prisma.empty, null);
    const lines = [['employee_id', 'name', 'department', 'decision', 'note', 'responded_at']];
    for (const { dto } of rows) {
      lines.push([dto.user.employee_id ?? '', dto.user.display_name, dto.department?.name_en ?? '', dto.decision, dto.note ?? '',
        dto.responded_at ? dto.responded_at.toISOString() : '']);
    }
    const csv = '﻿' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
    await this.db.tx.$executeRaw`INSERT INTO audit_log (action, entity_type, entity_id, after, actor_id, ip, request_id)
      VALUES ('announcement_exported', 'announcement', ${id}, ${JSON.stringify({ rows: rows.length })}::jsonb, ${auth.user.id}::uuid, ${auth.ip}::text, ${requestId ?? null}::text)`;
    return { file: new StreamableFile(Buffer.from(csv, 'utf8')), name: `announcement-${id}-responses.csv` };
  }

  async respond(auth: AuthContext, id: string, raw: unknown): Promise<void> {
    const b = parse(respondSchema, raw);
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    // The recipient row is visible to its owner; a stranger (or the sender) is told it does not exist.
    const mine = await this.db.tx.$queryRaw<{ answered: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM announcement_responses s WHERE s.announcement_id = r.announcement_id AND s.user_id = r.user_id) AS answered
      FROM announcement_recipients r WHERE r.announcement_id = ${id}::uuid AND r.user_id = ${auth.user.id}::uuid`;
    if (!mine[0]) throw problems.notFound('This announcement is not addressed to you.');
    if (mine[0].answered) throw new ProblemException(409, 'duplicate', { detail: 'You already answered this announcement.' });
    const note = b.note?.trim() ?? '';
    if (b.decision === 'disagree' && note.length < 3) {
      throw new ProblemException(422, 'note_required', {
        detail: 'Disagreeing needs a note of at least 3 characters.',
        errors: [{ path: '/note', code: 'note_required', message: 'Write why you disagree (at least 3 characters).' }],
      });
    }
    try {
      await this.db.tx.$executeRaw`SELECT ann_respond(${id}::uuid, ${b.decision}::text, ${note === '' ? null : note}::text)`;
    } catch (e) {
      const info = pgInfo(e);
      if (info?.sqlstate === '23505') throw new ProblemException(409, 'duplicate', { detail: 'You already answered this announcement.' });
      if (info?.sqlstate === '42501') throw problems.notFound('This announcement is not addressed to you.');
      throw e;
    }
  }

  async pending(auth: AuthContext): Promise<{ items: PendingAnnouncementDto[] }> {
    const rows = await this.db.tx.$queryRaw<{ id: string; title: string; body: string; created_at: Date; by_id: string; by_name: string; by_emp: string | null }[]>`
      SELECT a.id::text AS id, a.title, a.body, a.created_at, cb.id::text AS by_id, cb.display_name AS by_name, trim(cb.employee_id) AS by_emp
      FROM announcement_recipients r JOIN announcements a ON a.id = r.announcement_id JOIN users cb ON cb.id = a.created_by
      WHERE r.user_id = ${auth.user.id}::uuid
        AND NOT EXISTS (SELECT 1 FROM announcement_responses s WHERE s.announcement_id = r.announcement_id AND s.user_id = r.user_id)
      ORDER BY a.created_at, a.id`;
    return { items: rows.map((r) => ({ id: r.id, title: r.title, body: r.body, created_at: r.created_at, created_by: ref(r.by_id, r.by_name, r.by_emp) })) };
  }

  private async head(id: string): Promise<HeadRow | null> {
    if (!uuidSchema.safeParse(id).success) return null;
    const rows = await this.db.tx.$queryRaw<HeadRow[]>(Prisma.sql`SELECT ${HEAD} FROM announcements a JOIN users cb ON cb.id = a.created_by WHERE a.id = ${id}::uuid`);
    return rows[0] ?? null;
  }

  /** Sender or System Admin; anyone else (including a recipient) is told the results do not exist. */
  private async requireReader(id: string): Promise<void> {
    const h = await this.head(id);
    if (!h || !h.can_read) throw problems.notFound();
  }

  private async responseRows(id: string, filter: Prisma.Sql, page: Prisma.Sql, limit: number | null): Promise<{ dto: AnnouncementResponseDto }[]> {
    const rows = await this.db.tx.$queryRaw<{
      uid: string; name: string; emp: string | null; dept_id: string | null; dept_code: string | null; dept_en: string | null; dept_ar: string | null;
      decision: string | null; note: string | null; responded_at: Date | null;
    }[]>(Prisma.sql`
      SELECT u.id::text AS uid, u.display_name AS name, trim(u.employee_id) AS emp, d.id::text AS dept_id, d.code AS dept_code,
             d.name_en AS dept_en, d.name_ar AS dept_ar, s.decision, s.note, s.responded_at
      FROM announcement_recipients r JOIN users u ON u.id = r.user_id LEFT JOIN departments d ON d.id = u.department_id
      LEFT JOIN announcement_responses s ON s.announcement_id = r.announcement_id AND s.user_id = r.user_id
      WHERE r.announcement_id = ${id}::uuid ${filter} ${page}
      ORDER BY u.display_name, u.id::text ${limit === null ? Prisma.empty : Prisma.sql`LIMIT ${limit}`}`);
    return rows.map((r) => ({
      dto: {
        user: ref(r.uid, r.name, r.emp),
        department: r.dept_id ? { id: r.dept_id, code: r.dept_code ?? '', name_en: r.dept_en ?? '', name_ar: r.dept_ar } : null,
        decision: (r.decision ?? 'pending') as AnnouncementResponseDto['decision'],
        note: r.note,
        responded_at: r.responded_at,
      },
    }));
  }
}
