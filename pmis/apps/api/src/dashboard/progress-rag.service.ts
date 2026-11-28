import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AccessService } from "../access/access.service";
import type { AuthContext } from "../auth/auth.types";
import { parseIfMatch } from "../common/etag";
import { parse } from "../common/zod";
import { DbService } from "../db/db.service";
import { progressRagPutSchema } from "./progress-rag.schema";

interface RagJson {
  items: unknown[];
  version: number;
  updated_at: string | null;
  updated_by: string | null;
}

/**
 * Settings review gap 5 (contract 0.15.432): green and amber thresholds of the SPI, the progress against plan and the weekly velocity (setting dashboard.progress_rag).
 * A figure is coloured only after an admin turns it on and saves it, so nothing changes on deploy. Reads need dashboard.view. The write goes through
 * admin_save_progress_rag (admin.settings edit for all regions, reason, If-Match, audited). The colour is worked out when the figure is drawn.
 */
@Injectable()
export class ProgressRagService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
  ) {}

  private async dto(j: RagJson) {
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
      items: j.items,
      updated_at: j.updated_at,
      updated_by,
    };
  }

  /** GET /settings/dashboard/progress-rag */
  async get(auth: AuthContext) {
    await this.access.requireModuleView(auth, "dashboard");
    const r = await this.db.tx.$queryRaw<
      { j: RagJson }[]
    >`SELECT progress_rag_json() AS j`;
    return this.dto(r[0]!.j);
  }

  /** PUT /settings/dashboard/progress-rag */
  async put(_auth: AuthContext, ifMatch: string | undefined, raw: unknown) {
    await this.access.requireAdmin("admin.settings", "edit");
    const version = parseIfMatch(ifMatch);
    const b = parse(progressRagPutSchema, raw);
    const r = await this.db.tx.$queryRaw<{ j: RagJson }[]>(Prisma.sql`
      SELECT admin_save_progress_rag(${JSON.stringify(b.items)}::jsonb, ${b.reason}::text, ${version}::int) AS j`);
    return this.dto(r[0]!.j);
  }
}
