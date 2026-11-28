import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AccessService } from "../access/access.service";
import type { AuthContext } from "../auth/auth.types";
import { parseIfMatch } from "../common/etag";
import { parse } from "../common/zod";
import { DbService } from "../db/db.service";
import { snapshotWeekdayPutSchema } from "./snapshot-weekday.schema";

interface WeekdayJson {
  weekday: number;
  version: number;
  updated_at: string | null;
  updated_by: string | null;
}

/**
 * Settings review gap 3 (contract 0.15.430): the weekday of the weekly dashboard snapshot (setting dashboard.snapshot_weekday, 0 = Sunday ... 6 = Saturday).
 * Reads need dashboard.view. The write goes through admin_save_snapshot_weekday (admin.settings edit for all regions, reason, If-Match, audited). The nightly
 * job keeps reading the same setting; snapshots already stored are never moved.
 */
@Injectable()
export class SnapshotWeekdayService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
  ) {}

  private async dto(j: WeekdayJson) {
    let updated_by: {
      id: string;
      display_name: string;
      employee_id: string | null;
    } | null = null;
    if (j.updated_by) {
      const u = await this.db.tx.$queryRaw<
        { display_name: string; employee_id: string | null }[]
      >`SELECT display_name, employee_id FROM users WHERE id = ${j.updated_by}::uuid`;
      updated_by = {
        id: j.updated_by,
        display_name: u[0]?.display_name ?? "",
        employee_id: u[0]?.employee_id?.trim() ?? null,
      };
    }
    return {
      version: j.version,
      weekday: j.weekday,
      updated_at: j.updated_at,
      updated_by,
    };
  }

  /** GET /settings/dashboard/snapshot-schedule */
  async get(auth: AuthContext) {
    await this.access.requireModuleView(auth, "dashboard");
    const r = await this.db.tx.$queryRaw<
      { j: WeekdayJson }[]
    >`SELECT snapshot_weekday_json() AS j`;
    return this.dto(r[0]!.j);
  }

  /** PUT /settings/dashboard/snapshot-schedule */
  async put(_auth: AuthContext, ifMatch: string | undefined, raw: unknown) {
    await this.access.requireAdmin("admin.settings", "edit");
    const version = parseIfMatch(ifMatch);
    const b = parse(snapshotWeekdayPutSchema, raw);
    const r = await this.db.tx.$queryRaw<{ j: WeekdayJson }[]>(Prisma.sql`
      SELECT admin_save_snapshot_weekday(${b.weekday}::int, ${b.reason}::text, ${version}::int) AS j`);
    return this.dto(r[0]!.j);
  }
}
