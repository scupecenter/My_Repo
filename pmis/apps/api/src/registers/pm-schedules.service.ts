import { Injectable } from "@nestjs/common";
import { AccessService } from "../access/access.service";
import type { AuthContext } from "../auth/auth.types";
import { parseIfMatch } from "../common/etag";
import { ProblemException, problems } from "../common/problem";
import { parse } from "../common/zod";
import { DbService } from "../db/db.service";
import { pmSchedulesPutSchema } from "./pm-schedules.schema";
import { RegistersService } from "./registers.service";

interface Sched {
  id: string;
  register_key: string;
  site_id?: string;
  record_type?: string;
  data: Record<string, unknown>;
  next_due: string;
  active?: boolean;
  [k: string]: unknown;
}
interface PmJson {
  version: number;
  schedules: Sched[];
  updated_at: string | null;
  updated_by: string | null;
  today: string;
  catalogue: unknown;
}

/**
 * Recurring preventive-maintenance schedules (contract 0.15.161). They create DRAFTS only: nothing is created by a timer. A person presses "Create draft"
 * on a due schedule and the draft is saved through the register's own create path as that person (RegistersService.create: the register's rights,
 * region rules and field rules apply unchanged; the record starts in entry and goes through the normal review and approval). The list shows a caller only
 * the schedules of registers the caller may view. The write of the schedules needs admin.settings edit for all regions (admin_save_pm_schedules).
 */
@Injectable()
export class PmSchedulesService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly registers: RegistersService,
  ) {}

  private async dto(j: PmJson, visible: Set<string> | null) {
    let updated_by: { id: string; display_name: string } | null = null;
    if (j.updated_by) {
      const u = await this.db.tx.$queryRaw<{ display_name: string }[]>`SELECT display_name FROM users WHERE id = ${j.updated_by}::uuid`;
      updated_by = { id: j.updated_by, display_name: u[0]?.display_name ?? "" };
    }
    const schedules = visible ? j.schedules.filter((s) => visible.has(s.register_key)) : j.schedules;
    return { version: j.version, schedules, today: j.today, catalogue: j.catalogue, updated_at: j.updated_at, updated_by };
  }

  /** The register keys the caller may view, or null for an administrator who may edit the settings (sees every schedule). */
  private async visibleKeys(auth: AuthContext): Promise<Set<string> | null> {
    if (await this.access.hasGrant(auth, "admin.settings", "edit")) return null;
    const defs = await this.db.tx.$queryRaw<{ register_key: string; module_key: string }[]>`
      SELECT register_key, module_key FROM register_definitions WHERE is_active AND enabled`;
    const out = new Set<string>();
    for (const d of defs) if (await this.access.hasGrant(auth, d.module_key, "view")) out.add(d.register_key);
    return out;
  }

  /** GET /settings/pm-schedules */
  async get(auth: AuthContext) {
    const visible = await this.visibleKeys(auth);
    const r = await this.db.tx.$queryRaw<{ j: PmJson }[]>`SELECT pm_schedules_json() AS j`;
    return this.dto(r[0]!.j, visible);
  }

  /** PUT /settings/pm-schedules */
  async put(_auth: AuthContext, ifMatch: string | undefined, raw: unknown) {
    await this.access.requireAdmin("admin.settings", "edit");
    const version = parseIfMatch(ifMatch);
    const b = parse(pmSchedulesPutSchema, raw);
    const r = await this.db.tx.$queryRaw<{ j: PmJson }[]>`
      SELECT admin_save_pm_schedules(${JSON.stringify({ schedules: b.schedules })}::jsonb, ${b.reason}::text, ${version}::int) AS j`;
    return this.dto(r[0]!.j, null);
  }

  /** POST /pm-schedules/{id}/generate: one draft record as the caller, then the next due date moves on. */
  async generate(auth: AuthContext, id: string) {
    const visible = await this.visibleKeys(auth);
    const cur = (await this.db.tx.$queryRaw<{ j: PmJson }[]>`SELECT pm_schedules_json() AS j`)[0]!.j;
    const s = cur.schedules.find((x) => x.id === id);
    if (!s || (visible && !visible.has(s.register_key))) throw problems.notFound();
    if (s.active === false) throw new ProblemException(409, "invalid_transition", { detail: "This schedule is switched off." });
    if (s.next_due > cur.today) throw new ProblemException(409, "invalid_transition", { detail: "This schedule is not due yet." });
    const rec = await this.registers.create(auth, s.register_key, {
      ...(s.site_id ? { site_id: s.site_id } : {}),
      ...(s.record_type ? { record_type: s.record_type } : {}),
      data: s.data ?? {},
    });
    const recId = String(rec.id);
    const after = (await this.db.tx.$queryRaw<{ j: PmJson }[]>`SELECT pm_schedule_mark_generated(${id}::text, ${recId}::uuid) AS j`)[0]!.j;
    const next = after.schedules.find((x) => x.id === id);
    return { record_id: recId, register_key: s.register_key, next_due: next?.next_due ?? null };
  }
}
