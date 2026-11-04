import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { AccessService } from "../access/access.service";
import type { AuthContext } from "../auth/auth.types";
import { decodeCursor, encodeCursor, parseLimit } from "../common/cursor";
import { mapDbError } from "../common/db-errors";
import { parseIfMatch } from "../common/etag";
import { ProblemException, problems } from "../common/problem";
import { oneParam, Query } from "../common/query";
import { parse, uuidSchema } from "../common/zod";
import { DbService } from "../db/db.service";

const reason = z.string().trim().min(3).max(1000);
const RECORD_TYPES = [
  "te_dn",
  "cw_dn",
  "te_rn",
  "cw_rn",
  "pl",
  "open",
  "adj",
] as const;
const FORM_KINDS = ["dn", "rn", "pac", "fac", "snag_list"] as const;
const seqFields = {
  region_code: z
    .string()
    .regex(/^[A-Z]{1,6}$/)
    .nullable(),
  pattern: z.string().min(6).max(80),
  reset: z.enum(["never", "yearly"]),
  next_value: z.number().int().min(1).max(999_999_999),
  is_active: z.boolean(),
};
const seqCreate = z
  .object({
    ...seqFields,
    key: z.string().regex(/^[A-Z0-9][A-Z0-9-]{1,40}$/),
    form_kind: z.enum(FORM_KINDS).nullable().optional(),
    record_type: z.enum(RECORD_TYPES).nullable().optional(),
    region_id: z.number().int().min(1).nullable().optional(),
    reason,
  })
  .partial({ region_code: true, reset: true, next_value: true, is_active: true })
  .strict();
const seqPatch = z
  .object({ ...seqFields, reason })
  .partial({
    region_code: true,
    pattern: true,
    reset: true,
    next_value: true,
    is_active: true,
  })
  .strict()
  .refine((b) => Object.keys(b).length >= 2, {
    message: "Change at least one field.",
    path: [],
  });
const vendorPut = z
  .object({ wl_vendor: z.enum(["Cambium", "Intracom"]).nullable(), reason })
  .strict();
const NEED_STATUSES = [
  "complete",
  "short",
  "pending_configuration",
  "not_applicable",
];

/**
 * Migration 0053 (work package P7: Q105, Q106, Q107, D6): the numbering service (`/number-sequences`), the TE dispatch view of each site (the Q65 date and
 * the need-based PMIS status, side by side), the region WL vendors (Setting tblRegionVendor, D58) and the list of the owner data still missing.
 */
@Injectable()
export class WarehouseConfigService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
  ) {}

  private async call<T>(sql: Prisma.Sql): Promise<T> {
    await this.db.tx.$executeRaw`SAVEPOINT whc_call`;
    try {
      const rows = await this.db.tx.$queryRaw<{ r: T }[]>(sql);
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT whc_call`;
      const r = rows[0]?.r;
      if (r === undefined || r === null)
        throw new ProblemException(500, "internal_error", {});
      return r;
    } catch (e) {
      if (e instanceof ProblemException) throw e;
      const p = mapDbError(e);
      if (!p) throw e;
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT whc_call`;
      throw p;
    }
  }

  // ------------------------------------------------------------------ numbering (Q106)
  private async requireSettingsView(auth: AuthContext): Promise<void> {
    if (await this.access.isAdmin("settings", "edit")) return;
    await this.access.requireAnyModuleView(auth, [
      "admin.settings",
      "settings",
      "warehouse",
    ]);
  }

  async listSequences(auth: AuthContext): Promise<{ items: unknown[] }> {
    await this.requireSettingsView(auth);
    const rows = await this.db.tx.$queryRaw<{ j: unknown }[]>(
      Prisma.sql`SELECT doc_sequence_json(key) AS j FROM doc_sequences ORDER BY key COLLATE "C"`,
    );
    return { items: rows.map((r) => r.j) };
  }

  async createSequence(
    raw: unknown,
  ): Promise<Record<string, unknown> & { version: number }> {
    await this.access.requireAdmin("settings", "edit");
    const b = parse(seqCreate, raw);
    const { key, reason: why, ...patch } = b;
    return this.call(
      Prisma.sql`SELECT admin_save_doc_sequence(${key}::text, true, ${JSON.stringify(patch)}::jsonb, ${why}::text, NULL::int) AS r`,
    );
  }

  async updateSequence(
    key: string,
    ifMatch: string | undefined,
    raw: unknown,
  ): Promise<Record<string, unknown> & { version: number }> {
    const version = parseIfMatch(ifMatch);
    await this.access.requireAdmin("settings", "edit");
    const b = parse(seqPatch, raw);
    const { reason: why, ...patch } = b;
    return this.call(
      Prisma.sql`SELECT admin_save_doc_sequence(${key}::text, false, ${JSON.stringify(patch)}::jsonb, ${why}::text, ${version}::int) AS r`,
    );
  }

  // ------------------------------------------------------------------ region WL vendor (D58)
  async listRegionVendors(auth: AuthContext): Promise<{ items: unknown[] }> {
    await this.access.requireModuleView(auth, "warehouse");
    const rows = await this.db.tx.$queryRaw<unknown[]>(Prisma.sql`
      SELECT r.id AS region_id, r.name_en AS region_name, v.wl_vendor, coalesce(v.version, 0) AS version
      FROM regions r LEFT JOIN warehouse_region_vendors v ON v.region_id = r.id ORDER BY r.id`);
    return { items: rows };
  }

  async putRegionVendor(
    rawRegion: string,
    ifMatch: string | undefined,
    raw: unknown,
  ): Promise<{ region_id: number; wl_vendor: string | null; version: number }> {
    const version =
      ifMatch === undefined || ifMatch.trim() === ""
        ? null
        : parseIfMatch(ifMatch);
    await this.access.requireAdmin("warehouse_items", "edit");
    if (!/^[1-9][0-9]{0,3}$/.test(rawRegion))
      throw problems.notFound("Unknown region.");
    const b = parse(vendorPut, raw);
    return this.call(
      Prisma.sql`SELECT admin_save_region_vendor(${Number(rawRegion)}::int, ${b.wl_vendor}::text, ${b.reason}::text, ${version}::int) AS r`,
    );
  }

  // ------------------------------------------------------------------ owner data still missing (Q107)
  async configGaps(auth: AuthContext): Promise<unknown> {
    await this.access.requireModuleView(auth, "warehouse");
    const rows = await this.db.tx.$queryRaw<{ j: unknown }[]>(
      Prisma.sql`SELECT wh_config_gaps() AS j`,
    );
    return rows[0]?.j;
  }

  // ------------------------------------------------------------------ TE dispatch (D6)
  async dispatchList(
    q: Query,
  ): Promise<{
    items: unknown[];
    page: { limit: number; next_cursor: string | null };
  }> {
    const regs = await this.access.requireRegions("warehouse", "view");
    const limit = parseLimit(oneParam(q, "limit"));
    const cursor = decodeCursor(oneParam(q, "cursor"), 1);
    const status = oneParam(q, "need_status");
    if (status !== undefined && !NEED_STATUSES.includes(status))
      throw problems.validation([
        {
          path: "/need_status",
          code: "invalid",
          message: "complete, short, pending_configuration or not_applicable.",
        },
      ]);
    const region = oneParam(q, "region_id");
    if (region !== undefined && !/^[1-9][0-9]{0,3}$/.test(region))
      throw problems.validation([
        {
          path: "/region_id",
          code: "invalid",
          message: "region_id is a number.",
        },
      ]);
    const conds: Prisma.Sql[] = [
      Prisma.sql`s.is_active`,
      // Q281: a site whose overall status is Cancelled is left out of the list (and of any need total built from it); its own site page still shows it
      Prisma.sql`s.overall_status <> 'cancelled'`,
      Prisma.sql`(s.scope_te_full = 'yes' OR s.scope_te_ip_router_only = 'yes')`,
    ];
    if (regs !== null)
      conds.push(Prisma.sql`s.region_id = ANY(${regs}::int[])`);
    if (region !== undefined)
      conds.push(Prisma.sql`s.region_id = ${Number(region)}::int`);
    const text = oneParam(q, "q");
    if (text)
      conds.push(
        Prisma.sql`strpos(lower(s.site_code), lower(${text}::text)) > 0`,
      );
    if (cursor)
      conds.push(
        Prisma.sql`s.site_code COLLATE "C" > ${cursor[0] as string}::text`,
      );
    const where = Prisma.join(conds, " AND ");
    const rows = await this.db.tx.$queryRaw<
      { site_code: string; d: Record<string, unknown> | null }[]
    >(
      status === undefined
        ? Prisma.sql`
          SELECT x.site_code, wh_site_dispatch(x.id) - 'lines' AS d
          FROM (SELECT s.id, s.site_code FROM sites s WHERE ${where} ORDER BY s.site_code COLLATE "C" LIMIT ${limit + 1}) x
          ORDER BY x.site_code COLLATE "C"`
        : Prisma.sql`
          SELECT y.site_code, y.d FROM (
            SELECT s.site_code, wh_site_dispatch(s.id) - 'lines' AS d FROM sites s WHERE ${where}) y
          WHERE y.d ->> 'need_status' = ${status}::text
          ORDER BY y.site_code COLLATE "C" LIMIT ${limit + 1}`,
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => r.d).filter((d) => d !== null),
      page: {
        limit,
        next_cursor:
          rows.length > limit && last ? encodeCursor([last.site_code]) : null,
      },
    };
  }

  async dispatchSite(rawSite: string): Promise<unknown> {
    const regs = await this.access.requireRegions("warehouse", "view");
    if (!uuidSchema.safeParse(rawSite).success)
      throw problems.notFound(
        "The site does not exist or is not visible to you.",
      );
    const rows = await this.db.tx.$queryRaw<{ d: unknown }[]>(Prisma.sql`
      SELECT wh_site_dispatch(s.id) AS d FROM sites s
      WHERE s.id = ${rawSite}::uuid ${regs === null ? Prisma.empty : Prisma.sql`AND s.region_id = ANY(${regs}::int[])`}`);
    if (!rows[0]?.d)
      throw problems.notFound(
        "The site does not exist or is not visible to you.",
      );
    return rows[0].d;
  }
}
