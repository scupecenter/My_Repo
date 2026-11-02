import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { checkIfMatch, contentVersion } from '../common/etag';
import { IdempotencyService } from '../common/idempotency.service';
import { problems, ProblemException } from '../common/problem';
import { oneParam, Query } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';

type Json = Record<string, unknown>;
const NIL_USER = '00000000-0000-0000-0000-000000000000';
const CODES = ['project_status', 'health_index', 'delay_attribution'] as const;
const reason = z.string().trim().min(3).max(1000);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.').refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Not a date.');
/** 0 to 100 with at most 3 decimals (the column is numeric(7,3)). */
const weight = z.number().min(0).max(100).refine((n) => Math.abs(Math.round(n * 1000) - n * 1000) < 1e-6, 'At most 3 decimals.');
const code = z.string().regex(/^[A-Za-z0-9._-]{1,20}$/);
const itemSchema = z.object({
  code, name_en: z.string().min(1).max(200), name_ar: z.string().max(200).nullable().optional(), weight,
  unit: z.string().max(40).nullable().optional(), measure_rule: z.string().max(500).nullable().optional(), source: z.string().max(200).nullable().optional(),
}).strict();
const activitySchema = z.object({
  code, name_en: z.string().min(1).max(200), name_ar: z.string().max(200).nullable().optional(), weight, items: z.array(itemSchema).max(200).optional(),
}).strict();
const createSchema = z.object({ code: z.enum(CODES), base_set_id: z.string().uuid().optional(), reason }).strict();
const putSchema = z.object({ reason, activities: z.array(activitySchema).min(1).max(50) }).strict();
const publishSchema = z.object({ effective_date: isoDate, reason }).strict();

const userRef = (id: string | null, name: string | null, emp: string | null): Json | undefined =>
  id === null ? undefined : { id, display_name: id === NIL_USER ? 'System (seed)' : (name ?? ''), employee_id: emp?.trim() ?? null };

/**
 * Weight sets: Project Status, health index, delay attribution (contract 0.2.6). Reads need the Settings screen; every write goes through the audited
 * admin_* functions (reason, the 100% rule at publish, one open draft per code, effective date, step-up on publish).
 */
@Injectable()
export class WeightsService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly stepUp: StepUpService,
    private readonly idem: IdempotencyService,
  ) {}

  /** The set as the API returns it, with who changed it. */
  private async dto(rawId: string): Promise<{ body: Json; version: number }> {
    const id = parse(uuidSchema, rawId);
    const r = await this.db.tx.$queryRaw<{ j: Json | null }[]>`SELECT weight_set_json(${id}::uuid) AS j`;
    const j = r[0]?.j;
    if (!j) throw problems.notFound('The weight set does not exist.');
    const by = j.changed_by as string | null;
    let who: Json | undefined;
    if (by) {
      const u = await this.db.tx.$queryRaw<{ display_name: string; employee_id: string | null }[]>`SELECT display_name, employee_id FROM users WHERE id = ${by}::uuid`;
      who = userRef(by, u[0]?.display_name ?? null, u[0]?.employee_id ?? null);
    }
    const body = { ...j, ...(who ? { changed_by: who } : { changed_by: undefined }) };
    return { body, version: contentVersion(j.activities) };
  }

  async list(auth: AuthContext, q: Query): Promise<Json> {
    await this.access.requireModuleView(auth, 'admin.settings');
    const code_ = oneParam(q, 'code');
    const status = oneParam(q, 'status');
    if (code_ !== undefined && !(CODES as readonly string[]).includes(code_)) throw problems.validation([{ path: '/code', code: 'invalid', message: 'Unknown weight set code.' }]);
    if (status !== undefined && status !== 'draft' && status !== 'published') throw problems.validation([{ path: '/status', code: 'invalid', message: 'status is draft or published.' }]);
    const ids = await this.db.tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id::text AS id FROM weight_sets WHERE true ${code_ ? Prisma.sql`AND code::text = ${code_}` : Prisma.empty} ${status ? Prisma.sql`AND status::text = ${status}` : Prisma.empty}
      ORDER BY code::text, version DESC`);
    const items: Json[] = [];
    for (const { id } of ids) items.push((await this.dto(id)).body);
    return { items };
  }

  async get(auth: AuthContext, id: string): Promise<{ body: Json; version: number }> {
    await this.access.requireModuleView(auth, 'admin.settings');
    return this.dto(id);
  }

  async create(_auth: AuthContext, raw: unknown): Promise<{ body: Json; version: number }> {
    await this.access.requireAdmin('weights', 'edit');
    const b = parse(createSchema, raw);
    const r = await this.db.tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT admin_save_weight_set(NULL::uuid, ${b.code}::text, ${b.base_set_id ?? null}::uuid, ${b.reason}::text, NULL::jsonb, NULL::jsonb)::text AS id`);
    return this.dto(r[0]!.id);
  }

  private async draftOrThrow(rawId: string): Promise<{ id: string; status: string }> {
    const id = parse(uuidSchema, rawId);
    const r = await this.db.tx.$queryRaw<{ id: string; status: string }[]>`SELECT id::text AS id, status::text AS status FROM weight_sets WHERE id = ${id}::uuid`;
    if (!r[0]) throw problems.notFound('The weight set does not exist.');
    return r[0];
  }

  async replace(_auth: AuthContext, rawId: string, ifMatch: string | undefined, raw: unknown): Promise<{ body: Json; version: number }> {
    await this.access.requireAdmin('weights', 'edit');
    const cur = await this.draftOrThrow(rawId);
    if (cur.status !== 'draft') throw new ProblemException(409, 'invalid_transition', { detail: 'Only a draft can be changed.' });
    const before = await this.dto(cur.id);
    checkIfMatch(ifMatch, before.version);
    const b = parse(putSchema, raw);
    await this.db.tx.$queryRaw(Prisma.sql`SELECT admin_save_weight_set(${cur.id}::uuid, NULL::text, NULL::uuid, ${b.reason}::text, ${JSON.stringify(b.activities)}::jsonb, ${JSON.stringify(before.body.activities)}::jsonb)`);
    return this.dto(cur.id);
  }

  async preview(_auth: AuthContext, rawId: string): Promise<unknown> {
    await this.access.requireAdmin('weights', 'edit');
    const cur = await this.draftOrThrow(rawId);
    const r = await this.db.tx.$queryRaw<{ r: unknown }[]>`SELECT admin_preview_weight_set(${cur.id}::uuid) AS r`;
    return r[0]!.r;
  }

  async publish(auth: AuthContext, rawId: string, ifMatch: string | undefined, key: string | undefined, raw: unknown): Promise<unknown> {
    await this.access.requireAdmin('weights', 'edit');
    await this.stepUp.require(auth);
    return this.idem.run(auth.user.id, 'publishWeightSet', key, { id: rawId, raw }, async () => {
      const cur = await this.draftOrThrow(rawId);
      if (cur.status !== 'draft') throw new ProblemException(409, 'invalid_transition', { detail: 'Only a draft can be published.' });
      const before = await this.dto(cur.id);
      checkIfMatch(ifMatch, before.version);
      const b = parse(publishSchema, raw);
      const r = await this.db.tx.$queryRaw<{ r: { set_id: string; previous_set_id: string | null } }[]>(Prisma.sql`
        SELECT admin_publish_weight_set(${cur.id}::uuid, ${b.effective_date}::date, ${b.reason}::text, ${JSON.stringify(before.body.activities)}::jsonb) AS r`);
      return { weight_set: (await this.dto(cur.id)).body, previous_set_id: r[0]!.r.previous_set_id, recalculation_job_id: null };
    });
  }
}
