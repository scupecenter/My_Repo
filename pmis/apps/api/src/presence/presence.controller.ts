import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { mapDbError } from '../common/db-errors';
import { problems } from '../common/problem';
import { DbService } from '../db/db.service';

/**
 * Soft "… is editing this record" notice (contract 0.15.246, migration 0345; owner request 2026-11-27, research item 17). Advisory only, never
 * a lock. The editor's heartbeat keeps a row fresh (2 minutes); the list shows the other current editors of the entity. V1: kind `record`.
 */
@Controller('presence')
export class PresenceController {
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

  private static readonly KINDS = new Set(['record']);
  private static readonly UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  private static args(body: unknown): { kind: string; id: string } {
    const b = (body ?? {}) as { kind?: unknown; entity_id?: unknown };
    if (typeof b.kind !== 'string' || !PresenceController.KINDS.has(b.kind)) throw problems.validation([{ path: '/kind', code: 'invalid' }]);
    if (typeof b.entity_id !== 'string' || !PresenceController.UUID.test(b.entity_id)) throw problems.validation([{ path: '/entity_id', code: 'invalid' }]);
    return { kind: b.kind, id: b.entity_id };
  }

  @Post('editing')
  @HttpCode(200)
  ping(@Body() body: unknown) {
    const { kind, id } = PresenceController.args(body);
    return this.run(Prisma.sql`SELECT edit_presence_ping(${kind}::text, ${id}::uuid) AS r`);
  }

  @Post('editing/stop')
  @HttpCode(200)
  stop(@Body() body: unknown) {
    const { kind, id } = PresenceController.args(body);
    return this.run(Prisma.sql`SELECT edit_presence_stop(${kind}::text, ${id}::uuid) AS r`);
  }

  @Get('editing')
  async list(@Query() q: Record<string, unknown>) {
    const { kind, id } = PresenceController.args(q);
    const editors = await this.run<{ id: string; display_name: string; employee_id: string | null; since: string }[]>(
      Prisma.sql`SELECT edit_presence_list(${kind}::text, ${id}::uuid) AS r`,
    );
    return { editors };
  }
}
