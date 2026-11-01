import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { AccessService } from "../access/access.service";
import type { AuthContext } from "../auth/auth.types";
import { likePattern } from "../common/cursor";
import { mapDbError } from "../common/db-errors";
import { parseIfMatch } from "../common/etag";
import { ProblemException, problems } from "../common/problem";
import { boolParam, oneParam, Query } from "../common/query";
import { parse, uuidSchema } from "../common/zod";
import { DbService } from "../db/db.service";

const reason = z.string().trim().min(3).max(1000);
const fields = {
  name_en: z.string().trim().min(2).max(200),
  name_ar: z.string().trim().min(1).max(200).nullable(),
  unit: z.string().trim().min(1).max(20),
  master_column: z
    .string()
    .regex(/^[A-Z]{1,3}$/)
    .nullable(),
  warehouse_item_code: z
    .string()
    .regex(/^[A-Z0-9][A-Z0-9_-]{1,40}$/)
    .nullable(),
  sort_order: z.number().int().min(0).max(10000),
  is_active: z.boolean(),
};
const create = z
  .object({
    ...fields,
    code: z.string().regex(/^[A-Z0-9][A-Z0-9_]{1,29}$/),
    section: z.enum(["cw", "te"]),
    reason,
  })
  .partial({
    name_ar: true,
    unit: true,
    master_column: true,
    warehouse_item_code: true,
    sort_order: true,
    is_active: true,
  })
  .strict();
const patch = z
  .object({ ...fields, reason })
  .partial({
    name_en: true,
    name_ar: true,
    unit: true,
    master_column: true,
    warehouse_item_code: true,
    sort_order: true,
    is_active: true,
  })
  .strict()
  .refine((b) => Object.keys(b).length >= 2, {
    message: "Change at least one field.",
    path: [],
  });

interface Row {
  id: string;
  code: string;
  section: string;
  name_en: string;
  name_ar: string | null;
  unit: string;
  master_column: string | null;
  warehouse_item_code: string | null;
  field_code: string;
  sort_order: number;
  is_active: boolean;
  version: number;
}

const SELECT = Prisma.sql`
  SELECT a.id::text AS id, a.code, a.section, a.name_en, a.name_ar, a.unit, a.master_column, w.item_code AS warehouse_item_code, 'q_' || lower(a.code) AS field_code,
    a.sort_order, a.is_active, a.version
  FROM as_built_items a LEFT JOIN warehouse_items w ON w.id = a.warehouse_item_id`;

/**
 * The As-Built item list (CLAUDE.md "Items and work fields are data"): the CW quantities and the TE configuration items are rows, not columns. Each active
 * item is a number field of the As-Built register (field_code), so it appears in the form, in the records, in templates and in the Master-format export
 * (master_column). Written by the System Admin or a delegate of fields.edit, with a reason; nothing is deleted.
 */
@Injectable()
export class AsBuiltItemsService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
  ) {}

  async list(auth: AuthContext, q: Query): Promise<{ items: Row[] }> {
    await this.access.requireModuleView(auth, "as_built");
    const conds: Prisma.Sql[] = [Prisma.sql`true`];
    const section = oneParam(q, "section");
    if (section !== undefined) {
      if (section !== "cw" && section !== "te")
        throw problems.validation([
          {
            path: "/section",
            code: "invalid",
            message: "section is cw or te.",
          },
        ]);
      conds.push(Prisma.sql`a.section = ${section}`);
    }
    const text = oneParam(q, "q");
    if (text)
      conds.push(
        Prisma.sql`(a.code ILIKE ${likePattern(text)} OR a.name_en ILIKE ${likePattern(text)})`,
      );
    if (!boolParam(q, "include_inactive")) conds.push(Prisma.sql`a.is_active`);
    const rows = await this.db.tx.$queryRaw<Row[]>(
      Prisma.sql`${SELECT} WHERE ${Prisma.join(conds, " AND ")} ORDER BY a.section, a.sort_order, a.code`,
    );
    return { items: rows };
  }

  async get(auth: AuthContext, rawId: string): Promise<Row> {
    await this.access.requireModuleView(auth, "as_built");
    const id = parse(uuidSchema, rawId);
    const rows = await this.db.tx.$queryRaw<Row[]>(
      Prisma.sql`${SELECT} WHERE a.id = ${id}::uuid`,
    );
    if (!rows[0]) throw problems.notFound("The item does not exist.");
    return rows[0];
  }

  private async save(
    id: string | null,
    patchBody: Record<string, unknown>,
    why: string,
    version: number | null,
  ): Promise<string> {
    await this.db.tx.$executeRaw`SAVEPOINT ab_call`;
    try {
      const r = await this.db.tx.$queryRaw<{ r: { id: string } }[]>(
        Prisma.sql`SELECT admin_save_as_built_item(${id}::uuid, ${JSON.stringify(patchBody)}::jsonb, ${why}::text, ${version}::int) AS r`,
      );
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT ab_call`;
      return (r[0] as { r: { id: string } }).r.id;
    } catch (e) {
      if (e instanceof ProblemException) throw e;
      const p = mapDbError(e);
      if (!p) throw e;
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT ab_call`;
      throw p;
    }
  }

  async createItem(auth: AuthContext, raw: unknown): Promise<Row> {
    await this.access.requireAdmin("fields", "edit");
    const { reason: why, ...b } = parse(create, raw);
    if (!b.name_en)
      throw problems.validation([
        {
          path: "/name_en",
          code: "required",
          message: "The name is required.",
        },
      ]);
    return this.get(auth, await this.save(null, b, why, null));
  }

  async updateItem(
    auth: AuthContext,
    rawId: string,
    ifMatch: string | undefined,
    raw: unknown,
  ): Promise<Row> {
    const version = parseIfMatch(ifMatch);
    await this.access.requireAdmin("fields", "edit");
    const id = parse(uuidSchema, rawId);
    const { reason: why, ...b } = parse(patch, raw);
    await this.get(auth, id);
    return this.get(auth, await this.save(id, b, why, version));
  }
}
