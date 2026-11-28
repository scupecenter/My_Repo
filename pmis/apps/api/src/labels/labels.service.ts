import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { mapDbError } from '../common/db-errors';
import { problems } from '../common/problem';
import { oneParam } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';

export const LABEL_COLOURS = ['red', 'orange', 'amber', 'green', 'teal', 'blue', 'purple', 'pink', 'grey'] as const;
const KIND = z.enum(['site', 'register_record']);
const createSchema = z.object({ name: z.string().trim().min(1).max(40), colour: z.enum(LABEL_COLOURS) }).strict();
const patchSchema = z.object({ name: z.string().trim().min(1).max(40).optional(), colour: z.enum(LABEL_COLOURS).optional() }).strict().refine((v) => Object.keys(v).length > 0, 'send at least one field');
const assignSchema = z.object({ kind: KIND, ref_id: uuidSchema, context: z.string().regex(/^[a-z][a-z0-9_-]{0,80}$/).optional() }).strict();

export interface LabelDto { id: string; name: string; colour: string; is_active: boolean; link_count: number }
export interface LabelLinkDto { ref_id: string; context: string | null; label_ids: string[] }

/**
 * Personal coloured labels on records (improvement list item 2, migration 0740). A label is its owner's: the database (label_* functions, row-level security)
 * returns only the caller's own labels and links, so nothing about another person is ever visible and no permission is widened. Labels are hidden, never deleted.
 */
@Injectable()
export class LabelsService {
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

  private id(id: string): string {
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    return id;
  }

  async list(): Promise<{ items: LabelDto[] }> {
    return { items: await this.run<LabelDto[]>(Prisma.sql`SELECT label_list() AS r`) };
  }

  create(body: unknown): Promise<LabelDto> {
    const b = parse(createSchema, body);
    return this.run(Prisma.sql`SELECT label_save(NULL::uuid, ${b.name}::text, ${b.colour}::text) AS r`);
  }

  update(id: string, body: unknown): Promise<LabelDto> {
    const b = parse(patchSchema, body);
    return this.run(Prisma.sql`SELECT label_save(${this.id(id)}::uuid, ${b.name ?? null}::text, ${b.colour ?? null}::text) AS r`);
  }

  archive(id: string): Promise<LabelDto> {
    return this.run(Prisma.sql`SELECT label_archive(${this.id(id)}::uuid) AS r`);
  }

  assign(id: string, body: unknown, on: boolean): Promise<{ label_id: string; kind: string; ref_id: string; on: boolean; context: string | null }> {
    const b = parse(assignSchema, body);
    return this.run(Prisma.sql`SELECT label_assign(${this.id(id)}::uuid, ${b.kind}::text, ${b.ref_id}::uuid, ${on}::boolean, ${b.context ?? null}::text) AS r`);
  }

  async links(q: Record<string, unknown>): Promise<{ items: LabelLinkDto[] }> {
    const kind = parse(KIND, oneParam(q, 'kind'));
    const ref = oneParam(q, 'ref_id');
    if (ref !== undefined && !uuidSchema.safeParse(ref).success) throw problems.notFound();
    return { items: await this.run<LabelLinkDto[]>(Prisma.sql`SELECT label_links(${kind}::text, ${ref ?? null}::uuid) AS r`) };
  }
}
