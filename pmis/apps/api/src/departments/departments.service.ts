import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { pgInfo } from '../common/db-errors';
import { ProblemException, problems } from '../common/problem';
import { boolParam, Query } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';

const inputSchema = z.object({
  code: z.string().trim().regex(/^[A-Za-z0-9_]{2,20}$/),
  name_en: z.string().trim().min(1).max(120),
  name_ar: z.string().trim().max(120).nullable().optional(),
  is_active: z.boolean().optional(),
  reason: z.string().trim().min(3).max(1000),
}).strict();

export interface DepartmentDto {
  id: string;
  code: string;
  name_en: string;
  name_ar: string | null;
  is_active: boolean;
  member_count: number;
}

interface Row { id: string; code: string; name_en: string; name_ar: string | null; is_active: boolean; member_count: bigint }

const toDto = (r: Row): DepartmentDto => ({
  id: r.id, code: r.code, name_en: r.name_en, name_ar: r.name_ar, is_active: r.is_active, member_count: Number(r.member_count),
});

const SELECT = Prisma.sql`d.id::text AS id, d.code, d.name_en, d.name_ar, d.is_active,
  (SELECT count(*) FROM users u WHERE u.department_id = d.id) AS member_count`;

@Injectable()
export class DepartmentsService {
  constructor(private readonly db: DbService, private readonly access: AccessService) {}

  async list(auth: AuthContext, q: Query): Promise<{ items: DepartmentDto[] }> {
    const wantInactive = boolParam(q, 'include_inactive') === true;
    // Inactive departments only for people who may manage users; for everyone else the flag is ignored.
    const includeInactive = wantInactive && (await this.access.hasGrant(auth, 'admin.users', 'view'));
    const where = includeInactive ? Prisma.sql`true` : Prisma.sql`d.is_active`;
    const rows = await this.db.tx.$queryRaw<Row[]>(Prisma.sql`SELECT ${SELECT} FROM departments d WHERE ${where} ORDER BY d.name_en, d.id::text`);
    return { items: rows.map(toDto) };
  }

  async find(id: string): Promise<DepartmentDto | null> {
    if (!uuidSchema.safeParse(id).success) return null;
    const rows = await this.db.tx.$queryRaw<Row[]>(Prisma.sql`SELECT ${SELECT} FROM departments d WHERE d.id = ${id}::uuid`);
    return rows[0] ? toDto(rows[0]) : null;
  }

  async create(raw: unknown): Promise<DepartmentDto> {
    const body = parse(inputSchema, raw);
    await this.access.requireAdmin('users', 'edit');
    const id = await this.save(null, body, body.name_ar ?? null);
    const d = await this.find(id);
    if (!d) throw new ProblemException(500, 'internal_error', {});
    return d;
  }

  async update(id: string, raw: unknown): Promise<DepartmentDto> {
    const body = parse(inputSchema, raw);
    await this.access.requireAdmin('users', 'edit');
    const current = await this.find(id);
    if (!current) throw problems.notFound();
    // PATCH: an omitted name_ar keeps the stored one; null clears it.
    await this.save(id, body, body.name_ar === undefined ? current.name_ar : body.name_ar);
    const d = await this.find(id);
    if (!d) throw new ProblemException(500, 'internal_error', {});
    return d;
  }

  private async save(id: string | null, b: z.infer<typeof inputSchema>, nameAr: string | null): Promise<string> {
    try {
      const rows = await this.db.tx.$queryRaw<{ id: string }[]>`SELECT idm_department_save(${id}::uuid, ${b.code}::text, ${b.name_en}::text,
        ${nameAr}::text, ${b.is_active ?? null}::boolean, ${b.reason}::text)::text AS id`;
      return rows[0]!.id;
    } catch (e) {
      if (pgInfo(e)?.sqlstate === '23505') {
        throw new ProblemException(409, 'duplicate', {
          detail: 'Another department already uses this code.',
          errors: [{ path: '/code', code: 'duplicate', message: 'This code is already used.' }],
        });
      }
      throw e;
    }
  }
}
