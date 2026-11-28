import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AccessService } from "../access/access.service";
import type { AuthContext } from "../auth/auth.types";
import { mapDbError } from "../common/db-errors";
import { parseIfMatch } from "../common/etag";
import { parse } from "../common/zod";
import { DbService } from "../db/db.service";
import { siteHealthQuerySchema, siteHealthWeightsPutSchema } from "./site-health.schema";

/**
 * Site health score (contract 0.15.591, migration 0714): one number and colour per site from four factors (tasks on time, documents, open snags,
 * delay periods). Bands are the existing setting dashboard.health_bands, weights are dashboard.site_health_weights (Settings > Dashboard).
 * Reads need dashboard.view and show only sites of the caller's dashboard regions; the weights are written with admin.settings, a reason and If-Match.
 */
@Injectable()
export class SiteHealthService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
  ) {}

  private async one<T>(sql: Prisma.Sql): Promise<T> {
    try {
      const rows = await this.db.tx.$queryRaw<{ r: T }[]>(sql);
      return rows[0]?.r as T;
    } catch (e) {
      const p = mapDbError(e);
      if (p) throw p;
      throw e;
    }
  }

  /** GET /dashboard/site-health */
  async list(auth: AuthContext, raw: unknown) {
    const regions = await this.access.requireRegions("dashboard", "view");
    const q = parse(siteHealthQuerySchema, raw);
    return this.one<unknown>(Prisma.sql`SELECT site_health_scores(${regions}::int[], ${q.region_id ?? null}::int, ${q.band ?? null}::text, ${q.q ?? null}::text, ${q.limit}::int, ${q.offset}::int) AS r`);
  }

  /** GET /dashboard/site-health/{site_id} */
  async detail(auth: AuthContext, siteId: string) {
    const regions = await this.access.requireRegions("dashboard", "view");
    return this.one<unknown>(Prisma.sql`SELECT site_health_detail(${siteId}::uuid, ${regions}::int[]) AS r`);
  }

  private async weightsDto(j: Record<string, unknown>) {
    let updated_by: { id: string; display_name: string; employee_id: string | null } | null = null;
    if (j.updated_by) {
      const u = await this.db.tx.$queryRaw<{ display_name: string; employee_id: string | null }[]>`SELECT display_name, employee_id FROM users WHERE id = ${j.updated_by as string}::uuid`;
      updated_by = { id: j.updated_by as string, display_name: u[0]?.display_name ?? "", employee_id: u[0]?.employee_id?.trim() ?? null };
    }
    return { version: j.version as number, tasks: j.tasks as number, docs: j.docs as number, snags: j.snags as number, delay: j.delay as number, updated_at: (j.updated_at as string | null) ?? null, updated_by };
  }

  /** GET /settings/dashboard/site-health-weights */
  async getWeights(auth: AuthContext) {
    await this.access.requireModuleView(auth, "dashboard");
    return this.weightsDto(await this.one<Record<string, unknown>>(Prisma.sql`SELECT site_health_weights_json() AS r`));
  }

  /** PUT /settings/dashboard/site-health-weights */
  async putWeights(_auth: AuthContext, ifMatch: string | undefined, raw: unknown) {
    await this.access.requireAdmin("admin.settings", "edit");
    const version = parseIfMatch(ifMatch);
    const b = parse(siteHealthWeightsPutSchema, raw);
    return this.weightsDto(
      await this.one<Record<string, unknown>>(Prisma.sql`SELECT admin_save_site_health_weights(${b.tasks}::int, ${b.docs}::int, ${b.snags}::int, ${b.delay}::int, ${b.reason}::text, ${version}::int) AS r`),
    );
  }
}
