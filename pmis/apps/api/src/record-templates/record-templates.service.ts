import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { mapDbError } from '../common/db-errors';
import { problems } from '../common/problem';
import { oneParam } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';

const KEY = z.string().regex(/^[a-z][a-z0-9_-]{0,80}$/);
const saveSchema = z.object({
  register_key: KEY,
  name: z.string().trim().min(1).max(60),
  record_type: KEY.nullable().optional(),
  data: z.record(z.string().max(100), z.union([z.string().max(2000), z.number(), z.boolean(), z.array(z.string().max(200)).max(100), z.null()])).refine((d) => Object.keys(d).length <= 200, 'At most 200 values.'),
}).strict();

export interface RecordTemplateDto { id: string; register_key: string; name: string; record_type: string | null; data: Record<string, unknown>; created_at: string }

/**
 * Personal record templates (improvement list item 8, migration 0741). The database returns only the caller's own. A template only fills a form: the normal create
 * checks every right, field rule and value, so using one widens nothing. Hidden, never deleted.
 */
@Injectable()
export class RecordTemplatesService {
  constructor(private readonly db: DbService) {}

  private async run<T>(sql: Prisma.Sql): Promise<T> {
    try {
      const rows = await this.db.tx.$queryRaw<{ r: T }[]>(sql);
      return rows[0]?.r as T;
    } catch (e) {
      const p = mapDbError(e);
      if (p) throw p;
      throw e;
    }
  }

  async list(q: Record<string, unknown>): Promise<{ items: RecordTemplateDto[] }> {
    const key = parse(KEY, oneParam(q, 'register_key'));
    return { items: await this.run<RecordTemplateDto[]>(Prisma.sql`SELECT record_tpl_list(${key}::text) AS r`) };
  }

  save(body: unknown): Promise<RecordTemplateDto> {
    const b = parse(saveSchema, body);
    return this.run(Prisma.sql`SELECT record_tpl_save(${b.register_key}::text, ${b.name}::text, ${b.record_type ?? null}::text, ${JSON.stringify(b.data)}::jsonb) AS r`);
  }

  archive(id: string): Promise<RecordTemplateDto> {
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    return this.run(Prisma.sql`SELECT record_tpl_archive(${id}::uuid) AS r`);
  }
}
