import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { mapDbError } from "../common/db-errors";
import { problems } from "../common/problem";
import { oneParam } from "../common/query";
import { DbService } from "../db/db.service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Time in stage (0.15.482, migration 0623): per site and the slowest stages ranked. Read only; the database applies the caller's regions. */
@Injectable()
export class StageTimesService {
  constructor(private readonly db: DbService) {}

  site(siteId: string): Promise<unknown> {
    if (!UUID.test(siteId)) throw problems.notFound();
    return this.call(Prisma.sql`SELECT site_stage_times(${siteId}::uuid) AS j`);
  }

  report(q: Record<string, unknown>): Promise<unknown> {
    const r = oneParam(q, "region_id");
    if (r !== undefined && r !== "" && !/^[0-9]{1,6}$/.test(r)) throw problems.validation([{ path: "/region_id", code: "invalid", message: "A region id." }]);
    const region = r ? Number(r) : null;
    return this.call(Prisma.sql`SELECT stage_times_report(${region}::integer) AS j`);
  }

  private async call(sql: Prisma.Sql): Promise<unknown> {
    try {
      const rows = await this.db.tx.$queryRaw<{ j: unknown }[]>(sql);
      return rows[0]?.j ?? null;
    } catch (e) {
      const p = mapDbError(e);
      if (p) throw p;
      throw e;
    }
  }
}
