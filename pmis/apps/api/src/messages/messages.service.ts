import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth.types';
import { decodeCursor, encodeCursor, parseLimit } from '../common/cursor';
import { problems } from '../common/problem';
import { boolParam, oneParam, Query, TS_TEXT } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import type { UserRef } from '../users/users.repo';

const startSchema = z.object({
  to_user_id: z.string().uuid(),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(5000),
}).strict();
const replySchema = z.object({ body: z.string().trim().min(1).max(5000) }).strict();

export interface MessageContactsDto { manager: UserRef | null; reports: UserRef[]; can_message_anyone: boolean }
export interface MessageItemDto { id: string; author: UserRef; body: string; created_at: Date }
export interface MessageThreadDto {
  id: string;
  subject: string;
  participants: UserRef[];
  original: MessageItemDto;
  replies: MessageItemDto[];
  last_read_at: Date | null;
}
export interface MessageThreadSummaryDto {
  id: string;
  subject: string;
  other: UserRef;
  started_by_me: boolean;
  last_message_at: Date;
  last_message_preview: string;
  last_author: UserRef;
  reply_count: number;
  unread: boolean;
}

const ref = (id: string, name: string, emp: string | null): UserRef => ({ id, display_name: name, employee_id: emp });

interface SummaryRow {
  id: string;
  subject: string;
  started_by_me: boolean;
  last_message_at: Date;
  cursor_ts: string;
  reply_count: bigint;
  unread: boolean;
  other_id: string;
  other_name: string;
  other_emp: string | null;
  last_body: string;
  author_id: string;
  author_name: string;
  author_emp: string | null;
}

@Injectable()
export class MessagesService {
  constructor(private readonly db: DbService) {}

  async contacts(auth: AuthContext): Promise<MessageContactsDto> {
    const mgr = await this.db.tx.$queryRaw<{ id: string; display_name: string; emp: string | null }[]>`
      SELECT m.id::text AS id, m.display_name, trim(m.employee_id) AS emp FROM users u JOIN users m ON m.id = u.manager_id
      WHERE u.id = ${auth.user.id}::uuid AND m.status = 'active'`;
    const reports = await this.db.tx.$queryRaw<{ id: string; display_name: string; emp: string | null }[]>`
      SELECT r.id::text AS id, r.display_name, trim(r.employee_id) AS emp FROM users r
      WHERE r.manager_id = ${auth.user.id}::uuid AND r.status = 'active' ORDER BY r.display_name, r.id::text`;
    const m = mgr[0];
    return {
      manager: m ? ref(m.id, m.display_name, m.emp) : null,
      reports: reports.map((r) => ref(r.id, r.display_name, r.emp)),
      can_message_anyone: auth.state.isAdmin,
    };
  }

  async list(auth: AuthContext, q: Query): Promise<{ items: MessageThreadSummaryDto[]; page: { limit: number; next_cursor: string | null }; unread_total: number }> {
    const limit = parseLimit(oneParam(q, 'limit'));
    const cursor = decodeCursor(oneParam(q, 'cursor'), 2);
    const unreadOnly = boolParam(q, 'unread') === true;
    const me = auth.user.id;
    const unreadSql = Prisma.sql`EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.author_id <> ${me}::uuid
      AND (p.last_read_at IS NULL OR m.created_at > p.last_read_at))`;
    if (cursor && !uuidSchema.safeParse(cursor[1]).success) throw problems.badRequest('The cursor is not valid.');
    const page = cursor
      ? Prisma.sql`AND (t.last_message_at, t.id) < (${cursor[0] as string}::timestamptz, ${cursor[1] as string}::uuid)`
      : Prisma.empty;
    const rows = await this.db.tx.$queryRaw<SummaryRow[]>(Prisma.sql`
      SELECT t.id::text AS id, t.subject, (t.created_by = ${me}::uuid) AS started_by_me, t.last_message_at,
             ${Prisma.raw(TS_TEXT('t.last_message_at'))} AS cursor_ts,
             (SELECT count(*) FROM messages m WHERE m.thread_id = t.id AND NOT m.is_original) AS reply_count,
             ${unreadSql} AS unread,
             o.id::text AS other_id, o.display_name AS other_name, trim(o.employee_id) AS other_emp,
             lm.body AS last_body, la.id::text AS author_id, la.display_name AS author_name, trim(la.employee_id) AS author_emp
      FROM message_threads t
      JOIN message_participants p ON p.thread_id = t.id AND p.user_id = ${me}::uuid
      JOIN message_participants po ON po.thread_id = t.id AND po.user_id <> ${me}::uuid
      JOIN users o ON o.id = po.user_id
      JOIN LATERAL (SELECT m.body, m.author_id FROM messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) lm ON true
      JOIN users la ON la.id = lm.author_id
      WHERE ${unreadOnly ? unreadSql : Prisma.sql`true`} ${page}
      ORDER BY t.last_message_at DESC, t.id DESC LIMIT ${limit + 1}`);
    const total = await this.db.tx.$queryRaw<{ n: bigint }[]>(Prisma.sql`
      SELECT count(*) AS n FROM message_threads t JOIN message_participants p ON p.thread_id = t.id AND p.user_id = ${me}::uuid
      WHERE ${unreadSql}`);
    const items = rows.slice(0, limit).map((r): MessageThreadSummaryDto => ({
      id: r.id,
      subject: r.subject,
      other: ref(r.other_id, r.other_name, r.other_emp),
      started_by_me: r.started_by_me,
      last_message_at: r.last_message_at,
      last_message_preview: r.last_body.length > 140 ? r.last_body.slice(0, 139) + '…' : r.last_body,
      last_author: ref(r.author_id, r.author_name, r.author_emp),
      reply_count: Number(r.reply_count),
      unread: r.unread,
    }));
    const last = rows[limit - 1];
    return {
      items,
      page: { limit, next_cursor: rows.length > limit && last ? encodeCursor([last.cursor_ts, last.id]) : null },
      unread_total: Number(total[0]?.n ?? 0),
    };
  }

  /** The thread as the caller may see it (row-level security): null for a stranger or an unknown id. */
  async thread(auth: AuthContext, id: string): Promise<MessageThreadDto | null> {
    if (!uuidSchema.safeParse(id).success) return null;
    const t = await this.db.tx.$queryRaw<{ id: string; subject: string; last_read_at: Date | null }[]>`
      SELECT t.id::text AS id, t.subject, p.last_read_at FROM message_threads t
      JOIN message_participants p ON p.thread_id = t.id AND p.user_id = ${auth.user.id}::uuid WHERE t.id = ${id}::uuid`;
    const head = t[0];
    if (!head) return null;
    const people = await this.db.tx.$queryRaw<{ id: string; display_name: string; emp: string | null }[]>`
      SELECT u.id::text AS id, u.display_name, trim(u.employee_id) AS emp FROM message_participants p JOIN users u ON u.id = p.user_id
      WHERE p.thread_id = ${id}::uuid ORDER BY (u.id = ${auth.user.id}::uuid) DESC, u.display_name`;
    const msgs = await this.db.tx.$queryRaw<{ id: string; body: string; created_at: Date; is_original: boolean; aid: string; aname: string; aemp: string | null }[]>`
      SELECT m.id::text AS id, m.body, m.created_at, m.is_original, u.id::text AS aid, u.display_name AS aname, trim(u.employee_id) AS aemp
      FROM messages m JOIN users u ON u.id = m.author_id WHERE m.thread_id = ${id}::uuid
      ORDER BY m.is_original DESC, m.created_at DESC, m.id DESC`;
    const item = (m: (typeof msgs)[number]): MessageItemDto => ({ id: m.id, author: ref(m.aid, m.aname, m.aemp), body: m.body, created_at: m.created_at });
    const original = msgs.find((m) => m.is_original);
    if (!original) return null;
    return {
      id: head.id,
      subject: head.subject,
      participants: people.map((p) => ref(p.id, p.display_name, p.emp)),
      original: item(original),
      replies: msgs.filter((m) => !m.is_original).map(item),
      last_read_at: head.last_read_at,
    };
  }

  async get(auth: AuthContext, id: string): Promise<MessageThreadDto> {
    const t = await this.thread(auth, id);
    if (!t) throw problems.notFound();
    return t;
  }

  async start(auth: AuthContext, raw: unknown): Promise<MessageThreadDto> {
    const b = parse(startSchema, raw);
    // msg_start refuses with insufficient_privilege (403 action_forbidden) when the person is not one of my contacts.
    const rows = await this.db.tx.$queryRaw<{ id: string }[]>`SELECT msg_start(${b.to_user_id}::uuid, ${b.subject}::text, ${b.body}::text)::text AS id`;
    return this.get(auth, rows[0]!.id);
  }

  async reply(auth: AuthContext, id: string, raw: unknown): Promise<MessageThreadDto> {
    const b = parse(replySchema, raw);
    if (!(await this.thread(auth, id))) throw problems.notFound();
    await this.db.tx.$executeRaw`SELECT msg_reply(${id}::uuid, ${b.body}::text)`;
    return this.get(auth, id);
  }

  async markRead(auth: AuthContext, id: string): Promise<void> {
    if (!(await this.thread(auth, id))) throw problems.notFound();
    await this.db.tx.$executeRaw`SELECT msg_mark_read(${id}::uuid)`;
  }
}

