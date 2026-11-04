import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { AccessService } from "../access/access.service";
import type { AuthContext } from "../auth/auth.types";
import { StepUpService } from "../auth/step-up.service";
import {
  decodeCursor,
  encodeCursor,
  likePattern,
  parseLimit,
} from "../common/cursor";
import { mapDbError } from "../common/db-errors";
import { parseIfMatch } from "../common/etag";
import { ProblemException, problems } from "../common/problem";
import { TS_TEXT, boolParam, oneParam, Query } from "../common/query";
import { parse, uuidSchema } from "../common/zod";
import { DbService } from "../db/db.service";
import { TaskViewService } from "../workflow/task-view.service";

const reason = z.string().trim().min(3).max(1000);
// Q107 (migration 0053): a need rule is confirmed only when the owner gave its quantity; otherwise it is pending configuration and never counts.
const quantityRule = z
  .object({
    per: z.enum(["te_site", "rf_sector", "mw_half_link"]).optional(),
    wl_vendor: z.enum(["Cambium", "Intracom"]).optional(),
    group: z
      .string()
      .regex(/^[A-Z0-9][A-Z0-9_-]{0,39}$/)
      .optional(),
  })
  .strict();
const appliesWhen = z
  .object({
    scope: z.array(z.enum(["te_full", "router_only"])).max(2).optional(),
    delivery_scenario: z
      .array(
        z.enum(["new_build", "expansion", "hot_swap", "cold_swap", "relocation"]),
      )
      .max(5)
      .optional(),
    region_ids: z.array(z.number().int().min(1).max(9999)).max(20).optional(),
  })
  .strict();
const needRule = z
  .object({
    id: z.string().uuid().optional(),
    need_unit: z.string().trim().min(1).max(80),
    quantity: z.number().min(0).nullable().optional(),
    status: z.enum(["confirmed", "pending_configuration"]).optional(),
    quantity_rule: quantityRule.nullable().optional(),
    applies_when: appliesWhen.nullable().optional(),
  })
  .strict()
  .refine((r) => r.status !== "confirmed" || typeof r.quantity === "number", {
    message: "A confirmed need has a quantity.",
    path: ["quantity"],
  });
const itemFields = {
  name_en: z.string().trim().min(2).max(200),
  name_ar: z.string().trim().min(1).max(200).nullable(),
  uom: z.string().trim().min(1).max(20),
  category: z.string().trim().min(1).max(60).nullable(),
  serial_tracked: z.boolean(),
  manufacturer: z.string().trim().min(1).max(200).nullable(),
  contract_qty: z.number().min(0).nullable(),
  planned_delivery_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  progress_item_code: z.string().trim().min(1).max(60).nullable(),
  need_rules: z.array(needRule).max(50),
  code_source: z.enum(["master", "internal_provisional"]),
  is_active: z.boolean(),
};
const itemCreate = z
  .object({
    ...itemFields,
    code: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,40}$/),
    reason,
  })
  .partial({
    name_ar: true,
    serial_tracked: true,
    category: true,
    manufacturer: true,
    contract_qty: true,
    planned_delivery_date: true,
    progress_item_code: true,
    need_rules: true,
    code_source: true,
    is_active: true,
  })
  .strict();
const itemPatch = z
  .object({ ...itemFields, reason })
  .partial({
    name_en: true,
    name_ar: true,
    uom: true,
    category: true,
    serial_tracked: true,
    manufacturer: true,
    contract_qty: true,
    planned_delivery_date: true,
    progress_item_code: true,
    need_rules: true,
    code_source: true,
    is_active: true,
  })
  .strict()
  .refine((b) => Object.keys(b).length >= 2, {
    message: "Change at least one field.",
    path: [],
  });

const MOVEMENT_TYPES = [
  "te_dn",
  "cw_dn",
  "te_rn",
  "cw_rn",
  "pl",
  "open",
  "adj",
] as const;
const line = z
  .object({
    item_id: z.string().uuid(),
    qty: z.number().refine((n) => n !== 0, "The quantity cannot be zero."),
    qty_approved: z.number().positive().nullable().optional(),
    condition: z.enum(["Good", "Faulty", "Damaged"]).nullable().optional(),
    serials: z.array(z.string().trim().min(1).max(80)).max(5000).optional(),
  })
  .strict();
const movementInput = z
  .object({
    record_type: z.enum(MOVEMENT_TYPES),
    site_id: z.string().uuid().optional(),
    doc_no: z.string().trim().min(1).max(80).optional(),
    doc_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    txn_status: z
      .enum(["Approved", "Dispatched", "Received", "Cancelled"])
      .optional(),
    condition: z.enum(["Good", "Faulty", "Damaged"]).optional(),
    reason: z.string().trim().min(1).max(200).optional(),
    remark: z.string().trim().min(1).max(2000).optional(),
    lines: z.array(line).min(1).max(500),
  })
  .strict();
// Q270 (migration 0067): a quarantine exit takes quarantined stock out again. repaired = back to the available stock (ADJ), written_off = gone (ADJ),
// returned_to_supplier = out to the vendor (DN to the vendor, record type sup_dn). A reason is required; the document is approved by L2 like any other.
const EXIT_KINDS = ["repaired", "written_off", "returned_to_supplier"] as const;
const exitLine = z
  .object({
    item_id: z.string().uuid(),
    qty: z.number().positive(),
    serials: z.array(z.string().trim().min(1).max(80)).max(5000).optional(),
  })
  .strict();
const exitInput = z
  .object({
    exit_kind: z.enum(EXIT_KINDS),
    reason: z.string().trim().min(3).max(500),
    doc_no: z.string().trim().min(1).max(80).optional(),
    doc_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    remark: z.string().trim().min(1).max(2000).optional(),
    lines: z.array(exitLine).min(1).max(500),
  })
  .strict();
const cancelInput = z
  .object({ reason, confirm_text: z.string().optional() })
  .passthrough();

interface ItemRow {
  id: string;
  code: string;
  name_en: string;
  name_ar: string | null;
  uom: string;
  category: string | null;
  serial_tracked: boolean;
  manufacturer: string | null;
  contract_qty: number | null;
  planned_delivery_date: string | null;
  progress_item_code: string | null;
  is_active: boolean;
  version: number;
  as_built_item_code: string | null;
  code_source: string;
  need_rules: unknown;
}

const ITEM_SELECT = Prisma.sql`
  SELECT i.id::text AS id, i.item_code AS code, i.name AS name_en, i.name_ar, i.unit AS uom, i.item_group AS category, i.serialised AS serial_tracked, i.manufacturer,
    i.contract_qty::float8 AS contract_qty, i.planned_delivery_date::text AS planned_delivery_date, i.progress_item_code, i.code_source, i.is_active, i.version,
    (SELECT ab.code FROM as_built_items ab WHERE ab.warehouse_item_id = i.id) AS as_built_item_code,
    coalesce((SELECT jsonb_agg(jsonb_build_object('id', n.id, 'need_unit', n.need_unit, 'quantity', n.quantity::float8, 'status', n.status, 'quantity_rule', n.quantity_rule, 'applies_when', n.applies_when)
                              ORDER BY n.sort_order, n.id) FROM warehouse_item_need_rules n WHERE n.item_id = i.id), '[]'::jsonb) AS need_rules
  FROM warehouse_items i`;

interface MovementRow {
  id: string;
  record_type: string;
  kind: string;
  status: string;
  site_id: string | null;
  site_code: string | null;
  region_id: number | null;
  form_id: string | null;
  cancel_reason: string | null;
  created_by: string | null;
  created_at: Date;
  posted_at: Date | null;
  version: number;
  doc_no: string | null;
  register_record_id: string | null;
  reserved: boolean;
  doc_no_locked: boolean;
  sequence_key: string | null;
  doc_date: string | null;
  exit_kind: string | null;
  exit_reason: string | null;
  lines: unknown;
  ts: string;
}

const MOVEMENT_SELECT = Prisma.sql`
  SELECT m.id::text AS id, m.record_type, m.kind, m.status, m.site_id::text AS site_id, s.site_code, m.region_id, m.form_id::text AS form_id, m.cancel_reason,
    m.created_by::text AS created_by, m.created_at, m.posted_at, m.version,
    (SELECT r.data ->> 'doc_no' FROM register_records r WHERE r.entity_id = m.entity_id ORDER BY r.version_no DESC LIMIT 1) AS doc_no,
    (SELECT r.id::text FROM register_records r WHERE r.entity_id = m.entity_id ORDER BY r.version_no DESC LIMIT 1) AS register_record_id,
    (m.status = 'posted' AND m.doc_no IS NOT NULL) AS doc_no_locked, m.sequence_key, m.exit_kind,
    CASE WHEN m.exit_kind IS NULL THEN NULL ELSE (SELECT r.data ->> 'exit_reason' FROM register_records r WHERE r.entity_id = m.entity_id ORDER BY r.version_no DESC LIMIT 1) END AS exit_reason,
    coalesce(m.doc_date::text, (SELECT r.data ->> 'doc_date' FROM register_records r WHERE r.entity_id = m.entity_id ORDER BY r.version_no DESC LIMIT 1)) AS doc_date,
    (m.status = 'pending' AND (m.kind = 'issue' OR (m.kind = 'adjustment' AND EXISTS (SELECT 1 FROM wh_movement_lines x WHERE x.movement_id = m.id AND x.qty < 0)))) AS reserved,
    coalesce((SELECT jsonb_agg(jsonb_build_object('item_id', l.item_id, 'item_code', w.item_code, 'description', w.name, 'uom', w.unit, 'qty', l.qty::float8,
                'qty_approved', l.qty_approved::float8, 'condition', l.condition, 'serials', to_jsonb(l.serials)) ORDER BY l.sort_order)
              FROM wh_movement_lines l JOIN warehouse_items w ON w.id = l.item_id WHERE l.movement_id = m.id), '[]'::jsonb) AS lines,
    ${Prisma.raw(TS_TEXT("m.created_at"))} AS ts
  FROM wh_movements m LEFT JOIN sites s ON s.id = m.site_id`;

/**
 * Warehouse (spec 3.8, CLAUDE.md "Warehouse link"): the item master (data, edited by the System Admin or a delegate), derived stock, and the movements
 * (DN / RN / PL / OPEN / ADJ documents with lines). A movement is a record of the Warehouse register: it is submitted, reviewed and approved through
 * /registers/warehouse/records/{id}/...; the stock posts on the final approval and a void releases the reservation.
 */
@Injectable()
export class WarehouseService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly stepUp: StepUpService,
    private readonly view: TaskViewService,
  ) {}

  /** The database decides; a savepoint keeps the request transaction usable after a refusal. */
  private async call<T>(auth: AuthContext, sql: Prisma.Sql): Promise<T> {
    await this.db.tx.$executeRaw`SAVEPOINT wh_call`;
    try {
      const rows = await this.db.tx.$queryRaw<{ r: T }[]>(sql);
      const r = rows[0]?.r;
      if (r === undefined || r === null)
        throw new ProblemException(500, "internal_error", {});
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT wh_call`;
      return r;
    } catch (e) {
      if (e instanceof ProblemException) throw e;
      const p = mapDbError(e);
      if (!p) throw e;
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT wh_call`;
      if (p.code === "step_up_required") {
        throw new ProblemException(401, "step_up_required", {
          detail: "Confirm your password to continue.",
          step_up_method:
            auth.session.authMethod === "local" ? "password" : "m365",
        });
      }
      throw p;
    }
  }

  // ------------------------------------------------------------------ item master
  async listItems(
    auth: AuthContext,
    q: Query,
  ): Promise<{
    items: ItemRow[];
    page: { limit: number; next_cursor: string | null };
  }> {
    await this.access.requireModuleView(auth, "warehouse");
    const limit = parseLimit(oneParam(q, "limit"));
    const cursor = decodeCursor(oneParam(q, "cursor"), 1);
    const conds: Prisma.Sql[] = [Prisma.sql`true`];
    const text = oneParam(q, "q");
    if (text)
      conds.push(
        Prisma.sql`(i.item_code ILIKE ${likePattern(text)} OR i.name ILIKE ${likePattern(text)} OR i.name_ar ILIKE ${likePattern(text)})`,
      );
    const category = oneParam(q, "category");
    if (category) conds.push(Prisma.sql`i.item_group = ${category}`);
    if (!boolParam(q, "include_inactive")) conds.push(Prisma.sql`i.is_active`);
    if (cursor)
      conds.push(Prisma.sql`i.item_code COLLATE "C" > ${cursor[0] as string}`);
    const rows = await this.db.tx.$queryRaw<ItemRow[]>(
      Prisma.sql`${ITEM_SELECT} WHERE ${Prisma.join(conds, " AND ")} ORDER BY i.item_code COLLATE "C" LIMIT ${limit + 1}`,
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page,
      page: {
        limit,
        next_cursor:
          rows.length > limit && last ? encodeCursor([last.code]) : null,
      },
    };
  }

  async getItem(auth: AuthContext, rawId: string): Promise<ItemRow> {
    await this.access.requireModuleView(auth, "warehouse");
    const id = parse(uuidSchema, rawId);
    const rows = await this.db.tx.$queryRaw<ItemRow[]>(
      Prisma.sql`${ITEM_SELECT} WHERE i.id = ${id}::uuid`,
    );
    if (!rows[0]) throw problems.notFound("The item does not exist.");
    return rows[0];
  }

  private toPatch(b: Record<string, unknown>): Record<string, unknown> {
    const patch = { ...b };
    delete patch.reason;
    return patch;
  }

  async createItem(auth: AuthContext, raw: unknown): Promise<ItemRow> {
    await this.access.requireAdmin("warehouse_items", "edit");
    const b = parse(itemCreate, raw);
    if (!b.name_en || !b.uom) {
      throw problems.validation([
        ...(!b.name_en
          ? [
              {
                path: "/name_en",
                code: "required",
                message: "The name is required.",
              },
            ]
          : []),
        ...(!b.uom
          ? [
              {
                path: "/uom",
                code: "required",
                message: "The unit is required.",
              },
            ]
          : []),
      ]);
    }
    const out = await this.call<{ id: string }>(
      auth,
      Prisma.sql`SELECT admin_save_warehouse_item(NULL::uuid, ${JSON.stringify(this.toPatch(b))}::jsonb, ${b.reason}::text, NULL::int) AS r`,
    );
    return this.getItem(auth, out.id);
  }

  async updateItem(
    auth: AuthContext,
    rawId: string,
    ifMatch: string | undefined,
    raw: unknown,
  ): Promise<ItemRow> {
    const version = parseIfMatch(ifMatch);
    await this.access.requireAdmin("warehouse_items", "edit");
    const id = parse(uuidSchema, rawId);
    const b = parse(itemPatch, raw);
    const exists = await this.db.tx.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT id::text FROM warehouse_items WHERE id = ${id}::uuid`,
    );
    if (!exists[0]) throw problems.notFound("The item does not exist.");
    await this.call(
      auth,
      Prisma.sql`SELECT admin_save_warehouse_item(${id}::uuid, ${JSON.stringify(this.toPatch(b))}::jsonb, ${b.reason}::text, ${version}::int) AS r`,
    );
    return this.getItem(auth, id);
  }

  // ------------------------------------------------------------------ stock
  async stock(
    auth: AuthContext,
    q: Query,
  ): Promise<{
    items: unknown[];
    page: { limit: number; next_cursor: string | null };
  }> {
    const regs = await this.access.requireRegions("warehouse", "view");
    const limit = parseLimit(oneParam(q, "limit"));
    const cursor = decodeCursor(oneParam(q, "cursor"), 1);
    const item = oneParam(q, "item_id");
    const site = oneParam(q, "site_id");
    if (item !== undefined && !uuidSchema.safeParse(item).success)
      throw problems.validation([
        { path: "/item_id", code: "invalid", message: "item_id is a uuid." },
      ]);
    if (site !== undefined) {
      if (!uuidSchema.safeParse(site).success)
        throw problems.validation([
          { path: "/site_id", code: "invalid", message: "site_id is a uuid." },
        ]);
      const s = await this.db.tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT id::text FROM sites WHERE id = ${site}::uuid ${regs === null ? Prisma.empty : Prisma.sql`AND region_id = ANY(${regs}::int[])`}`,
      );
      if (!s[0])
        throw problems.notFound(
          "The site does not exist or is not visible to you.",
        );
    }
    const text = oneParam(q, "q");
    const conds: Prisma.Sql[] = [Prisma.sql`true`];
    if (text)
      conds.push(
        Prisma.sql`(i.item_code ILIKE ${likePattern(text)} OR i.name ILIKE ${likePattern(text)})`,
      );
    if (cursor)
      conds.push(Prisma.sql`i.item_code COLLATE "C" > ${cursor[0] as string}`);
    const rows = await this.db.tx.$queryRaw<
      {
        item_id: string;
        item_code: string;
        item_name: string;
        uom: string;
        on_hand: number;
        reserved: number;
        pending_issue: number;
        pending_return: number;
        available: number;
        quarantine: number;
        quarantine_pending: number;
      }[]
    >(Prisma.sql`
      SELECT s.item_id::text AS item_id, i.item_code, i.name AS item_name, i.unit AS uom, s.on_hand::float8 AS on_hand, s.reserved::float8 AS reserved,
        s.pending_issue::float8 AS pending_issue, s.pending_return::float8 AS pending_return, s.available::float8 AS available, s.quarantine::float8 AS quarantine,
        s.quarantine_pending::float8 AS quarantine_pending
      FROM wh_stock_levels(${item ?? null}::uuid, ${site ?? null}::uuid) s JOIN warehouse_items i ON i.id = s.item_id
      WHERE ${Prisma.join(conds, " AND ")} ORDER BY i.item_code COLLATE "C" LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({ ...r, site_id: site ?? null })),
      page: {
        limit,
        next_cursor:
          rows.length > limit && last ? encodeCursor([last.item_code]) : null,
      },
    };
  }

  // ------------------------------------------------------------------ movements
  private async dto(rows: MovementRow[]): Promise<Record<string, unknown>[]> {
    const refs = await this.view.userRefs([
      ...new Set(rows.map((r) => r.created_by).filter((x): x is string => !!x)),
    ]);
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      record_type: r.record_type,
      status: r.status,
      site_id: r.site_id,
      site_code: r.site_code,
      form_id: r.form_id,
      doc_no: r.doc_no,
      doc_no_locked: r.doc_no_locked,
      sequence_key: r.sequence_key,
      doc_date: r.doc_date,
      exit_kind: r.exit_kind,
      exit_reason: r.exit_reason,
      register_record_id: r.register_record_id,
      lines: r.lines,
      reserved: r.reserved,
      cancel_reason: r.cancel_reason,
      ...(r.created_by && refs.get(r.created_by)
        ? { created_by: refs.get(r.created_by) }
        : {}),
      created_at: r.created_at,
      posted_at: r.posted_at,
      version: r.version,
    }));
  }

  private visible(regs: number[] | null): Prisma.Sql {
    return regs === null
      ? Prisma.sql`true`
      : Prisma.sql`(m.is_global OR m.region_id = ANY(${regs}::int[]))`;
  }

  async listMovements(
    auth: AuthContext,
    q: Query,
  ): Promise<{
    items: unknown[];
    page: { limit: number; next_cursor: string | null };
  }> {
    const regs = await this.access.requireRegions("warehouse", "view");
    void auth;
    const limit = parseLimit(oneParam(q, "limit"));
    const cursor = decodeCursor(oneParam(q, "cursor"), 2);
    const conds: Prisma.Sql[] = [this.visible(regs)];
    const site = oneParam(q, "site_id");
    if (site !== undefined) {
      if (!uuidSchema.safeParse(site).success)
        throw problems.validation([
          { path: "/site_id", code: "invalid", message: "site_id is a uuid." },
        ]);
      conds.push(Prisma.sql`m.site_id = ${site}::uuid`);
    }
    const kind = oneParam(q, "kind");
    if (kind !== undefined) {
      if (!["issue", "return", "receipt", "adjustment", "quarantine_exit"].includes(kind))
        throw problems.validation([
          {
            path: "/kind",
            code: "invalid",
            message:
              "kind is issue, return, receipt, adjustment or quarantine_exit.",
          },
        ]);
      conds.push(Prisma.sql`m.kind = ${kind}`);
    }
    const status = oneParam(q, "status");
    if (status !== undefined) {
      if (!["pending", "posted", "cancelled"].includes(status))
        throw problems.validation([
          {
            path: "/status",
            code: "invalid",
            message: "status is pending, posted or cancelled.",
          },
        ]);
      conds.push(Prisma.sql`m.status = ${status}`);
    }
    const item = oneParam(q, "item_id");
    if (item !== undefined) {
      if (!uuidSchema.safeParse(item).success)
        throw problems.validation([
          { path: "/item_id", code: "invalid", message: "item_id is a uuid." },
        ]);
      conds.push(
        Prisma.sql`EXISTS (SELECT 1 FROM wh_movement_lines x WHERE x.movement_id = m.id AND x.item_id = ${item}::uuid)`,
      );
    }
    if (cursor)
      conds.push(
        Prisma.sql`(m.created_at, m.id) < (${cursor[0] as string}::timestamptz, ${cursor[1] as string}::uuid)`,
      );
    const rows = await this.db.tx.$queryRaw<MovementRow[]>(
      Prisma.sql`${MOVEMENT_SELECT} WHERE ${Prisma.join(conds, " AND ")} ORDER BY m.created_at DESC, m.id DESC LIMIT ${limit + 1}`,
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: await this.dto(page),
      page: {
        limit,
        next_cursor:
          rows.length > limit && last ? encodeCursor([last.ts, last.id]) : null,
      },
    };
  }

  async getMovement(
    auth: AuthContext,
    rawId: string,
  ): Promise<Record<string, unknown>> {
    const regs = await this.access.requireRegions("warehouse", "view");
    void auth;
    if (!uuidSchema.safeParse(rawId).success)
      throw problems.notFound(
        "The movement does not exist or is not visible to you.",
      );
    const rows = await this.db.tx.$queryRaw<MovementRow[]>(
      Prisma.sql`${MOVEMENT_SELECT} WHERE m.id = ${rawId}::uuid AND ${this.visible(regs)}`,
    );
    if (!rows[0])
      throw problems.notFound(
        "The movement does not exist or is not visible to you.",
      );
    return (await this.dto(rows))[0] as Record<string, unknown>;
  }

  async createMovement(
    auth: AuthContext,
    raw: unknown,
  ): Promise<Record<string, unknown>> {
    await this.access.requireModuleView(auth, "warehouse");
    const b = parse(movementInput, raw);
    const isSiteDoc = ["te_dn", "cw_dn", "te_rn", "cw_rn"].includes(
      b.record_type,
    );
    if (isSiteDoc && !b.site_id)
      throw problems.validation([
        {
          path: "/site_id",
          code: "required",
          message: "A delivery or return note needs a site.",
        },
      ]);
    if (!isSiteDoc && b.site_id)
      throw problems.validation([
        {
          path: "/site_id",
          code: "not_site_scoped",
          message: "PL, OPEN and ADJ documents have no site.",
        },
      ]);
    const data: Record<string, unknown> = {};
    for (const k of [
      "doc_no",
      "doc_date",
      "txn_status",
      "condition",
      "reason",
      "remark",
    ] as const)
      if (b[k] !== undefined) data[k] = b[k];
    const id = await this.call<string>(
      auth,
      Prisma.sql`SELECT wh_create_movement(${b.record_type}::text, ${b.site_id ?? null}::uuid, ${JSON.stringify(data)}::jsonb, ${JSON.stringify(b.lines)}::jsonb)::text AS r`,
    );
    return this.getMovement(auth, id);
  }

  /** Q270: POST /warehouse/quarantine-exits. The database checks the grant, the quarantined quantity and the serials; L2 approves through the register record. */
  async createQuarantineExit(
    auth: AuthContext,
    raw: unknown,
  ): Promise<Record<string, unknown>> {
    await this.access.requireModuleView(auth, "warehouse");
    const b = parse(exitInput, raw);
    const data: Record<string, unknown> = { exit_reason: b.reason };
    for (const k of ["doc_no", "doc_date", "remark"] as const)
      if (b[k] !== undefined) data[k] = b[k];
    const id = await this.call<string>(
      auth,
      Prisma.sql`SELECT wh_create_quarantine_exit(${b.exit_kind}::text, ${JSON.stringify(data)}::jsonb, ${JSON.stringify(b.lines)}::jsonb)::text AS r`,
    );
    return this.getMovement(auth, id);
  }

  async cancelMovement(
    auth: AuthContext,
    rawId: string,
    ifMatch: string | undefined,
    raw: unknown,
  ): Promise<Record<string, unknown>> {
    const version = parseIfMatch(ifMatch);
    const body = parse(cancelInput, raw ?? {});
    await this.getMovement(auth, rawId);
    await this.stepUp.require(auth);
    await this.call<boolean>(
      auth,
      Prisma.sql`SELECT true AS r FROM (SELECT wh_cancel_movement(${rawId}::uuid, ${version}::int, ${body.reason}::text)) v`,
    );
    return this.getMovement(auth, rawId);
  }
}
