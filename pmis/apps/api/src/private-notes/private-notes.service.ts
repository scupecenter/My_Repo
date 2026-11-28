import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { problems } from '../common/problem';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';

const putBody = z.object({ body: z.string().max(4000) }).strict();
const TYPES = ['task', 'register_record'] as const;

export interface PrivateNoteDto { entity_type: string; entity_id: string; body: string; updated_at: string | null }

/** Private notes (migration 0668, contract 0.15.597): the caller's own note on a task or a register record; the database only ever reads and writes the caller's row. */
@Injectable()
export class PrivateNotesService {
  constructor(private readonly db: DbService) {}

  private check(type: string, id: string): void {
    if (!(TYPES as readonly string[]).includes(type) || !z.string().uuid().safeParse(id).success) throw problems.notFound();
  }

  async get(type: string, id: string): Promise<PrivateNoteDto> {
    this.check(type, id);
    const rows = await this.db.tx.$queryRaw<{ r: PrivateNoteDto }[]>(Prisma.sql`SELECT private_note_get(${type}::text, ${id}::uuid) AS r`);
    return rows[0]!.r;
  }

  async set(type: string, id: string, raw: unknown): Promise<PrivateNoteDto> {
    this.check(type, id);
    const b = parse(putBody, raw);
    const rows = await this.db.tx.$queryRaw<{ r: PrivateNoteDto }[]>(Prisma.sql`SELECT private_note_set(${type}::text, ${id}::uuid, ${b.body}::text) AS r`);
    return rows[0]!.r;
  }
}
