import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { SyslogService } from '../auth/syslog.service';
import { UserStateService } from '../auth/user-state.service';
import { decodeCursor, encodeCursor, likePattern, parseLimit } from '../common/cursor';
import { mapDbError } from '../common/db-errors';
import { contentVersion } from '../common/etag';
import { problems } from '../common/problem';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';

const reasonSchema = z.string().trim().min(3).max(1000);
const addSchema = z.object({ user_ids: z.array(z.string().uuid()).min(1).max(500), reason: reasonSchema }).strict();

interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  is_system_admins: boolean;
  is_active: boolean;
  member_count: bigint;
  matrix_cell_count: bigint;
  members_key: string | null;
}

export interface GroupDto {
  id: string;
  name: string;
  is_system_admins: boolean;
  description: string | null;
  is_active: boolean;
  member_count: number;
  matrix_cell_count: number;
  version: number;
}

export interface GroupDetailDto extends GroupDto {
  members: { user: { id: string; display_name: string; employee_id: string | null }; status: string; added_at: Date }[];
}

interface BulkIssue { ref: string; code: string; message?: string }
export interface BulkResultDto {
  bulk_action_id: string;
  done: { id: string }[];
  skipped: BulkIssue[];
  failed: BulkIssue[];
}

const GROUP_SELECT = Prisma.sql`g.id::text AS id, g.name, g.description, g.is_system_admins, g.is_active,
  (SELECT count(*) FROM group_members gm WHERE gm.group_id = g.id) AS member_count,
  (SELECT count(DISTINCT a.cell_id) FROM matrix_cell_assignees a WHERE a.kind = 'group' AND a.ref_id = g.id) AS matrix_cell_count,
  (SELECT string_agg(gm.user_id::text, ',' ORDER BY gm.user_id) FROM group_members gm WHERE gm.group_id = g.id) AS members_key`;

const toGroup = (r: GroupRow): GroupDto => ({
  id: r.id,
  name: r.name,
  is_system_admins: r.is_system_admins,
  description: r.description,
  is_active: r.is_active,
  member_count: Number(r.member_count),
  matrix_cell_count: Number(r.matrix_cell_count),
  // groups have no version column: the version is derived from what can change (name, description, active, members)
  version: contentVersion([r.name, r.description, r.is_active, r.members_key]),
});

@Injectable()
export class GroupsService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly stepUp: StepUpService,
    private readonly states: UserStateService,
    private readonly syslog: SyslogService,
  ) {}

  async list(auth: AuthContext, q: Record<string, unknown>): Promise<{ items: GroupDto[]; page: { limit: number; next_cursor: string | null; total: number } }> {
    await this.access.requireModuleView(auth, 'admin.groups');
    const str = (k: string): string | undefined => {
      const v = q[k];
      if (v === undefined) return undefined;
      if (typeof v !== 'string') throw problems.validation([{ path: `/${k}`, code: 'invalid', message: `${k} must be a single value.` }]);
      return v;
    };
    const limit = parseLimit(str('limit'));
    const cursor = decodeCursor(str('cursor'), 2);
    const text = str('q')?.trim();
    const where = text ? Prisma.sql`g.name ILIKE ${likePattern(text)}` : Prisma.sql`true`;
    const page = cursor ? Prisma.sql`AND (g.name, g.id::text) > (${cursor[0] as string}, ${cursor[1] as string})` : Prisma.empty;
    const rows = await this.db.tx.$queryRaw<GroupRow[]>(Prisma.sql`SELECT ${GROUP_SELECT} FROM groups g WHERE ${where} ${page}
      ORDER BY g.name, g.id::text LIMIT ${limit + 1}`);
    const total = await this.db.tx.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT count(*) AS n FROM groups g WHERE ${where}`);
    const items = rows.slice(0, limit).map(toGroup);
    const last = rows[limit - 1];
    return { items, page: { limit, next_cursor: rows.length > limit && last ? encodeCursor([last.name, last.id]) : null, total: Number(total[0]?.n ?? 0) } };
  }

  async detail(id: string): Promise<GroupDetailDto | null> {
    if (!uuidSchema.safeParse(id).success) return null;
    const rows = await this.db.tx.$queryRaw<GroupRow[]>(Prisma.sql`SELECT ${GROUP_SELECT} FROM groups g WHERE g.id = ${id}::uuid`);
    const row = rows[0];
    if (!row) return null;
    const members = await this.db.tx.groupMember.findMany({
      where: { group_id: id },
      include: { user: { select: { id: true, display_name: true, employee_id: true, status: true } } },
      orderBy: [{ user: { display_name: 'asc' } }, { user_id: 'asc' }],
    });
    return {
      ...toGroup(row),
      members: members.map((m) => ({
        user: { id: m.user.id, display_name: m.user.display_name, employee_id: m.user.employee_id?.trim() ?? null },
        status: m.user.status,
        added_at: m.added_at,
      })),
    };
  }

  async get(auth: AuthContext, id: string): Promise<GroupDetailDto> {
    await this.access.requireModuleView(auth, 'admin.groups');
    const d = await this.detail(id);
    if (!d) throw problems.notFound();
    return d;
  }

  /** One user at a time inside a savepoint: a refusal for one user does not undo the others. */
  async addMembers(auth: AuthContext, groupId: string, raw: unknown): Promise<BulkResultDto> {
    const body = parse(addSchema, raw);
    await this.access.requireAdmin('groups', 'edit');
    await this.stepUp.require(auth);
    if (!uuidSchema.safeParse(groupId).success || !(await this.groupExists(groupId))) throw problems.notFound();

    const result: BulkResultDto = { bulk_action_id: randomUUID(), done: [], skipped: [], failed: [] };
    for (const userId of [...new Set(body.user_ids)]) {
      const u = await this.db.tx.user.findUnique({ where: { id: userId }, select: { status: true } });
      if (!u) {
        result.failed.push({ ref: userId, code: 'not_found', message: 'No such user.' });
        continue;
      }
      if (u.status === 'pending_assignment') {
        result.failed.push({ ref: userId, code: 'pending_assignment', message: 'A pending user cannot join a group.' });
        continue;
      }
      const member = await this.db.tx.groupMember.findUnique({ where: { group_id_user_id: { group_id: groupId, user_id: userId } } });
      if (member) {
        result.skipped.push({ ref: userId, code: 'already_assigned', message: 'Already a member.' });
        continue;
      }
      await this.db.tx.$executeRaw`SAVEPOINT bulk_item`;
      try {
        await this.db.tx.$executeRaw`SELECT idm_group_add_member(${groupId}::uuid, ${userId}::uuid, ${body.reason}::text)`;
        await this.db.tx.$executeRaw`RELEASE SAVEPOINT bulk_item`;
        result.done.push({ id: userId });
      } catch (e) {
        await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT bulk_item`;
        const p = mapDbError(e);
        if (!p) throw e;
        result.failed.push({ ref: userId, code: p.code, message: p.opts.detail });
      }
    }
    this.states.invalidate(...result.done.map((d) => d.id));
    return result;
  }

  async removeMember(auth: AuthContext, groupId: string, userId: string, rawReason: unknown): Promise<void> {
    await this.access.requireAdmin('groups', 'edit');
    const parsedReason = reasonSchema.safeParse(rawReason);
    if (!parsedReason.success) throw problems.validation([{ path: '/reason', code: 'invalid', message: 'reason is required (3 to 1000 characters).' }]);
    const reason = parsedReason.data;
    await this.stepUp.require(auth);
    if (!uuidSchema.safeParse(groupId).success || !uuidSchema.safeParse(userId).success || !(await this.groupExists(groupId))) throw problems.notFound();
    const member = await this.db.tx.groupMember.findUnique({ where: { group_id_user_id: { group_id: groupId, user_id: userId } } });
    if (!member) throw problems.notFound('That user is not a member of the group.');
    await this.db.tx.$executeRaw`SELECT idm_group_remove_member(${groupId}::uuid, ${userId}::uuid, ${reason}::text)`;
    // The last-admin rule is a deferred constraint; check it now so the answer is 409 last_admin and nothing is committed.
    await this.db.tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    this.states.invalidate(userId);
    await this.syslog.write('info', 'group_member_removed', { group: groupId, user: userId }, auth.user.id);
  }

  private async groupExists(id: string): Promise<boolean> {
    return (await this.db.tx.group.count({ where: { id } })) > 0;
  }
}
