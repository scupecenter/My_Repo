import { Injectable } from "@nestjs/common";
import { AccessService } from "../access/access.service";
import type { AuthContext } from "../auth/auth.types";
import { parseIfMatch } from "../common/etag";
import { parse } from "../common/zod";
import { DbService } from "../db/db.service";
import { goalsPutSchema } from "./goals.schema";

interface GoalsJson {
  version: number;
  goals: unknown[];
  updated_at: string | null;
  updated_by: string | null;
  catalogue: unknown;
}

/**
 * Goals with automatic progress (contract 0.15.150). The list and the progress need dashboard.view (the sites counted are the ones the caller may
 * read, row-level security). The write goes through admin_save_goals: admin.settings edit for all regions, reason, If-Match, audited.
 */
@Injectable()
export class GoalsService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
  ) {}

  private async dto(j: GoalsJson) {
    let updated_by: { id: string; display_name: string } | null = null;
    if (j.updated_by) {
      const u = await this.db.tx.$queryRaw<
        { display_name: string }[]
      >`SELECT display_name FROM users WHERE id = ${j.updated_by}::uuid`;
      updated_by = { id: j.updated_by, display_name: u[0]?.display_name ?? "" };
    }
    return {
      version: j.version,
      goals: j.goals,
      catalogue: j.catalogue,
      updated_at: j.updated_at,
      updated_by,
    };
  }

  /** GET /settings/goals */
  async get(auth: AuthContext) {
    await this.access.requireModuleView(auth, "dashboard");
    const r = await this.db.tx.$queryRaw<
      { j: GoalsJson }[]
    >`SELECT goals_json() AS j`;
    return this.dto(r[0]!.j);
  }

  /** PUT /settings/goals */
  async put(_auth: AuthContext, ifMatch: string | undefined, raw: unknown) {
    await this.access.requireAdmin("admin.settings", "edit");
    const version = parseIfMatch(ifMatch);
    const b = parse(goalsPutSchema, raw);
    const r = await this.db.tx.$queryRaw<{ j: GoalsJson }[]>`
      SELECT admin_save_goals(${JSON.stringify({ goals: b.goals })}::jsonb, ${b.reason}::text, ${version}::int) AS j`;
    return this.dto(r[0]!.j);
  }

  /** GET /goals/progress */
  async progress(auth: AuthContext) {
    await this.access.requireModuleView(auth, "dashboard");
    const r = await this.db.tx.$queryRaw<
      { j: unknown[] }[]
    >`SELECT goals_progress() AS j`;
    return { goals: r[0]!.j };
  }
}
