import { Injectable } from "@nestjs/common";
import { AccessService } from "../access/access.service";
import type { AuthContext } from "../auth/auth.types";
import { DbService } from "../db/db.service";
import { parse } from "../common/zod";
import { changeLogQuerySchema } from "./change-log.schema";

/**
 * Settings review gap 6 (contract 0.15.433): who changed the Dashboard settings or the Goals settings, when, why and what. Reads the audit rows those saves already write
 * through settings_change_log (migration 0576): nothing new is written. Needs the Settings screen (admin.settings view), the same right as the screens themselves.
 */
@Injectable()
export class ChangeLogService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
  ) {}

  /** GET /settings/change-log?scope=dashboard|goals&limit=50 */
  async get(auth: AuthContext, q: Record<string, unknown>) {
    await this.access.requireModuleView(auth, "admin.settings");
    const { scope, limit = 50 } = parse(changeLogQuerySchema, q);
    const r = await this.db.tx.$queryRaw<
      { j: unknown[] }[]
    >`SELECT settings_change_log(${scope}::text, ${limit}::int) AS j`;
    return { scope, items: r[0]!.j };
  }
}
