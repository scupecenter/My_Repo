import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AccessService } from "../access/access.service";
import type { AuthContext } from "../auth/auth.types";
import { parseIfMatch } from "../common/etag";
import { parse } from "../common/zod";
import { DbService } from "../db/db.service";
import { psDeliverablesPutSchema } from "./ps-deliverables.schema";

interface PsItemJson {
  item_code: string;
  name_en: string;
  name_ar: string | null;
  weight: number | string;
  kind: string | null;
  mode: "auto" | "manual";
  accepted: number | null;
  total: number | null;
  source: "deliverables" | "manual";
}
interface PsJson {
  items: PsItemJson[];
  version: number;
  updated_at: string | null;
  updated_by: string | null;
}

/**
 * F4 follow-up 1 (contract 0.15.470): the Project Status items HLD, DOC, NMS-S, BILL, PILOT, NMS-I, NMS-A and TRN can read their figure from the Deliverables
 * register (accepted / non-cancelled). Reads need dashboard.view. The write goes through admin_save_ps_deliverables (admin.settings edit for all regions, reason,
 * If-Match, audited). Manual values are never changed or deleted: an item set to "manual" shows its manual value again.
 */
@Injectable()
export class PsDeliverablesService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
  ) {}

  private async dto(j: PsJson) {
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
      items: j.items.map((i) => ({ ...i, weight: Number(i.weight) })),
      updated_at: j.updated_at,
      updated_by,
    };
  }

  /** GET /settings/dashboard/ps-deliverables */
  async get(auth: AuthContext) {
    await this.access.requireModuleView(auth, "dashboard");
    const r = await this.db.tx.$queryRaw<
      { j: PsJson }[]
    >`SELECT ps_deliverables_json() AS j`;
    return this.dto(r[0]!.j);
  }

  /** PUT /settings/dashboard/ps-deliverables */
  async put(_auth: AuthContext, ifMatch: string | undefined, raw: unknown) {
    await this.access.requireAdmin("admin.settings", "edit");
    const version = parseIfMatch(ifMatch);
    const b = parse(psDeliverablesPutSchema, raw);
    const items = JSON.stringify(
      b.items.map((i) => ({
        item_code: i.item_code,
        kind: i.kind ?? null,
        mode: i.mode,
      })),
    );
    const r = await this.db.tx.$queryRaw<{ j: PsJson }[]>(Prisma.sql`
      SELECT admin_save_ps_deliverables(${items}::jsonb, ${b.reason}::text, ${version}::int) AS j`);
    return this.dto(r[0]!.j);
  }
}
