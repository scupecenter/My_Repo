import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { decodeCursor, encodeCursor, parseLimit } from '../common/cursor';
import { parseIfMatch } from '../common/etag';
import { ProblemException, problems } from '../common/problem';
import { boolParam, oneParam } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';

const reason = z.string().trim().min(3).max(1000);
const confirmImpact = z.string().max(200).optional();
const code = z.string().trim().min(1).max(40);
const nameEn = z.string().trim().min(1).max(200);
const nameAr = z.string().trim().max(200).nullable();

const createDraftBody = z.object({ parent_version: z.number().int().min(1), reason }).strict();
const publishBody = z.object({ reason, confirm_text: z.string().max(200), confirm_master_impact: confirmImpact }).strict();
const milestoneBody = z.object({
  name_en: nameEn.optional(), name_ar: nameAr.optional(), counts_in_project_status: z.boolean().optional(),
  custom: z.record(z.unknown()).optional(), reason, confirm_master_impact: confirmImpact,
}).strict().refine((b) => Object.keys(b).some((k) => !['reason', 'confirm_master_impact'].includes(k)), { message: 'send at least one field to change', path: ['name_en'] });
const gateBody = z.object({
  name_en: nameEn.optional(), name_ar: nameAr.optional(), conditions: z.array(z.object({ type: z.string(), ref: z.string().optional(), accept_na: z.boolean().optional() }).strict()).max(30).optional(),
  sla_min_wd: z.number().int().min(0).optional(), sla_max_wd: z.number().int().min(0).optional(),
  custom: z.record(z.unknown()).optional(), reason, confirm_master_impact: confirmImpact,
}).strict().refine((b) => Object.keys(b).some((k) => !['reason', 'confirm_master_impact'].includes(k)), { message: 'send at least one field to change', path: ['name_en'] });
const taskCreateBody = z.object({
  stage_code: code, code: z.string().trim().max(40), name_en: z.string().trim().max(400), name_ar: z.string().trim().max(400).nullable().optional(),
  counts_toward_milestone: z.boolean().optional(), has_documents: z.boolean().optional(), after_task_code: code.nullable().optional(),
  predecessors: z.array(code).max(100).optional(), reason, confirm_master_impact: confirmImpact,
}).strict();
const taskPatchBody = z.object({
  name_en: z.string().trim().max(400).optional(), name_ar: z.string().trim().max(400).nullable().optional(), counts_toward_milestone: z.boolean().optional(),
  is_active: z.boolean().optional(), stage_code: code.optional(), reason, confirm_master_impact: confirmImpact,
}).strict().refine((b) => Object.keys(b).some((k) => !['reason', 'confirm_master_impact'].includes(k)), { message: 'send at least one field to change', path: ['name_en'] });
const insertFields = {
  stage_code: code, code: z.string().trim().max(40), name_en: z.string().trim().max(400), name_ar: z.string().trim().max(400).nullable().optional(),
  counts_toward_milestone: z.boolean().optional(), has_documents: z.boolean().optional(), after_task_code: code.nullable().optional(),
  predecessors: z.array(code).max(100).optional(), successors: z.array(code).max(100).optional(), remove_direct_links: z.boolean().optional(),
};
const insertPreviewBody = z.object({
  stage_code: code, predecessors: z.array(code).max(100).optional(), successors: z.array(code).max(100).optional(), remove_direct_links: z.boolean().optional(),
  counts_toward_milestone: z.boolean().optional(),
}).strict();
const taskInsertBody = z.object({ ...insertFields, add_to_open_sites: z.boolean().optional(), reason, confirm_master_impact: confirmImpact }).strict();
const successorsBody = z.object({ successors: z.array(code).max(100), reason }).strict();
const selection = z.object({
  site_ids: z.array(uuidSchema).max(1000).optional(),
  filter: z.object({ region_id: z.array(z.number().int()).optional(), from_version: z.number().int().optional(), overall_status: z.array(z.string()).optional() }).strict().optional(),
}).strict();

const structureBody = z.object({
  milestones: z.array(z.object({ code, name_en: nameEn.optional(), name_ar: nameAr.optional(), is_active: z.boolean().optional(), counts_in_project_status: z.boolean().optional() }).strict()).max(60),
  gates: z.array(z.object({
    code, name_en: nameEn.optional(), name_ar: nameAr.optional(), from_milestone: code.optional(), to_milestone: code.optional(), is_active: z.boolean().optional(),
    conditions: z.array(z.object({ type: z.string(), ref: z.string().optional(), accept_na: z.boolean().optional() }).strict()).max(30).optional(),
    sla_min_wd: z.number().int().min(0).optional(), sla_max_wd: z.number().int().min(0).optional(),
  }).strict()).max(80),
  task_moves: z.array(z.object({ task_code: code, stage_code: code }).strict()).max(500).optional(),
  reason, confirm_master_impact: confirmImpact,
}).strict();
const migrateBody = z.object({ preview_hash: z.string().min(8).max(100), selection, reason, confirm_master_impact: confirmImpact }).strict();
const revertBody = z.object({ reason }).strict();
const predecessorsBody = z.object({ predecessors: z.array(code).max(100), reason }).strict();
const orderBody = z.object({ task_codes: z.array(code).max(500), reason }).strict();
type Json = Record<string, unknown>;

/**
 * Migration 0090 (owner decision 4 of 2026-11-12): the workflow editor. Every write is a definer door (admin_wf_*) that checks the System Admin or the all-regions
 * delegation, the reason, the ETag (version_etag), the structural freeze and the audit. The API adds the step-up and the typed confirmation of the publish.
 */
@Injectable()
export class WorkflowEditorService {
  constructor(private readonly db: DbService, private readonly access: AccessService, private readonly stepUp: StepUpService) {}

  private async one(sql: Prisma.Sql): Promise<Json> {
    const rows = await this.db.tx.$queryRaw<{ r: Json | null }[]>(sql);
    return rows[0]?.r ?? {};
  }

  /** Permission first (403 for anyone else), then the ETag (428), then the step-up (401), so nothing is written before they pass. */
  private async gate(auth: AuthContext, module: string, action: 'create' | 'edit' | 'administer', ifMatch: string | undefined): Promise<number | null> {
    await this.access.requireAdmin(module, action);
    const etag = parseIfMatch(ifMatch);
    await this.stepUp.require(auth);
    return etag;
  }

  async list(): Promise<Json> {
    return { items: (await this.one(Prisma.sql`SELECT workflow_versions_json() AS r`)) as unknown as Json[] };
  }

  async get(version: number): Promise<Json> {
    const r = await this.one(Prisma.sql`SELECT workflow_version_json(${version}::int) AS r`);
    if (!r || Object.keys(r).length === 0) throw problems.notFound('The workflow version does not exist.');
    return r;
  }

  async taskDefinitions(q: Record<string, unknown>): Promise<Json> {
    const v = oneParam(q, 'workflow_version');
    if (v !== undefined && !/^[1-9][0-9]{0,8}$/.test(v)) throw problems.validation([{ path: '/workflow_version', code: 'invalid', message: 'A version number.' }]);
    const inactive = boolParam(q, 'include_inactive') ?? false;
    const r = await this.db.tx.$queryRaw<{ r: unknown }[]>(Prisma.sql`SELECT wf_task_definitions_json(${v === undefined ? null : Number(v)}::int, ${inactive}::boolean) AS r`);
    if (r[0]?.r === null || r[0]?.r === undefined) throw problems.notFound('The workflow version does not exist.');
    return { items: r[0].r as unknown as Json[] };
  }

  async createDraft(auth: AuthContext, raw: unknown): Promise<Json> {
    const b = parse(createDraftBody, raw);
    await this.access.requireAdmin('workflow_versions', 'create');
    await this.stepUp.require(auth);
    return this.one(Prisma.sql`SELECT admin_wf_create_draft(${b.parent_version}::int, ${b.reason}::text) AS r`);
  }

  async createTask(auth: AuthContext, version: number, ifMatch: string | undefined, raw: unknown): Promise<Json> {
    const b = parse(taskCreateBody, raw);
    const etag = await this.gate(auth, 'task_definitions', 'create', ifMatch);
    return this.one(Prisma.sql`SELECT admin_wf_task_create(${version}::int, ${etag}::int, ${b.stage_code}::text, ${b.code}::text, ${b.name_en}::text, ${b.name_ar ?? null}::text,
      ${b.counts_toward_milestone ?? null}::boolean, ${b.has_documents ?? null}::boolean, ${b.after_task_code ?? null}::text, ${b.predecessors ?? []}::text[], ${b.reason}::text,
      ${b.confirm_master_impact ?? null}::text) AS r`);
  }

  async updateTask(auth: AuthContext, version: number, task: string, ifMatch: string | undefined, raw: unknown): Promise<Json> {
    const b = parse(taskPatchBody, raw);
    const etag = await this.gate(auth, 'task_definitions', 'edit', ifMatch);
    const { reason: why, confirm_master_impact: confirm, ...patch } = b;
    return this.one(Prisma.sql`SELECT admin_wf_task_update(${version}::int, ${etag}::int, ${task}::text, ${JSON.stringify(patch)}::jsonb, ${why}::text, ${confirm ?? null}::text) AS r`);
  }

  async setPredecessors(auth: AuthContext, version: number, task: string, ifMatch: string | undefined, raw: unknown): Promise<Json> {
    const b = parse(predecessorsBody, raw);
    const etag = await this.gate(auth, 'task_definitions', 'edit', ifMatch);
    return this.one(Prisma.sql`SELECT admin_wf_task_predecessors(${version}::int, ${etag}::int, ${task}::text, ${b.predecessors}::text[], ${b.reason}::text) AS r`);
  }

  /** Phase 2 (migration 0094): the preview of the affected chain of an insert; nothing is written. */
  async previewInsert(version: number, raw: unknown): Promise<Json> {
    const b = parse(insertPreviewBody, raw);
    await this.access.requireAdmin('task_definitions', 'create');
    return this.one(Prisma.sql`SELECT admin_wf_task_insert_preview(${version}::int, ${b.stage_code}::text, ${b.predecessors ?? []}::text[], ${b.successors ?? []}::text[],
      ${b.remove_direct_links ?? false}::boolean, ${b.counts_toward_milestone ?? true}::boolean) AS r`);
  }

  /** A new task between existing tasks, with the cascade rewiring and (optionally) the open sites, in one transaction. */
  async insertTask(auth: AuthContext, version: number, ifMatch: string | undefined, raw: unknown): Promise<Json> {
    const b = parse(taskInsertBody, raw);
    const etag = await this.gate(auth, 'task_definitions', 'create', ifMatch);
    return this.one(Prisma.sql`SELECT admin_wf_task_insert(${version}::int, ${etag}::int, ${b.stage_code}::text, ${b.code}::text, ${b.name_en}::text, ${b.name_ar ?? null}::text,
      ${b.counts_toward_milestone ?? null}::boolean, ${b.has_documents ?? null}::boolean, ${b.after_task_code ?? null}::text, ${b.predecessors ?? []}::text[], ${b.successors ?? []}::text[],
      ${b.remove_direct_links ?? false}::boolean, ${b.add_to_open_sites ?? false}::boolean, ${b.reason}::text, ${b.confirm_master_impact ?? null}::text) AS r`);
  }

  async setSuccessors(auth: AuthContext, version: number, task: string, ifMatch: string | undefined, raw: unknown): Promise<Json> {
    const b = parse(successorsBody, raw);
    const etag = await this.gate(auth, 'task_definitions', 'edit', ifMatch);
    return this.one(Prisma.sql`SELECT admin_wf_task_successors(${version}::int, ${etag}::int, ${task}::text, ${b.successors}::text[], ${b.reason}::text) AS r`);
  }

  /** The structural edit of a draft: the complete list of milestones and gates (the order is the list order), and tasks moved between milestones. */
  async replaceStructure(auth: AuthContext, version: number, ifMatch: string | undefined, raw: unknown): Promise<Json> {
    const b = parse(structureBody, raw);
    const etag = await this.gate(auth, 'workflow_versions', 'edit', ifMatch);
    const { reason: why, confirm_master_impact: confirm, ...structure } = b;
    return this.one(Prisma.sql`SELECT admin_wf_structure_replace(${version}::int, ${etag}::int, ${JSON.stringify(structure)}::jsonb, ${why}::text, ${confirm ?? null}::text) AS r`);
  }

  /** The move of the previewed sites: the hash of the preview must still match (422 stale_preview otherwise). One transaction. */
  async migrate(auth: AuthContext, version: number, raw: unknown): Promise<Json> {
    const b = parse(migrateBody, raw);
    await this.access.requireAdmin('workflow_versions', 'administer');
    await this.stepUp.require(auth);
    return this.one(Prisma.sql`SELECT admin_wf_migrate_sites(admin_wf_migration_sites(${JSON.stringify(b.selection)}::jsonb, ${version}::int), ${version}::int, ${b.preview_hash}::text,
      ${b.reason}::text, ${b.confirm_master_impact ?? null}::text) AS r`);
  }

  async revertMigration(auth: AuthContext, id: string, raw: unknown): Promise<Json> {
    if (!uuidSchema.safeParse(id).success) throw problems.notFound('The migration does not exist.');
    const b = parse(revertBody, raw);
    await this.access.requireAdmin('workflow_versions', 'administer');
    await this.stepUp.require(auth);
    return this.one(Prisma.sql`SELECT admin_wf_revert_migration(${id}::uuid, ${b.reason}::text) AS r`);
  }

  async reorder(auth: AuthContext, version: number, stage: string, ifMatch: string | undefined, raw: unknown): Promise<Json> {
    const b = parse(orderBody, raw);
    const etag = await this.gate(auth, 'task_definitions', 'edit', ifMatch);
    return this.one(Prisma.sql`SELECT admin_wf_task_order(${version}::int, ${etag}::int, ${stage}::text, ${b.task_codes}::text[], ${b.reason}::text) AS r`);
  }

  /** The light door answers the whole version; the contract answers the node, so pick it. */
  async milestone(auth: AuthContext, version: number, node: string, ifMatch: string | undefined, raw: unknown): Promise<{ node: Json; etag: number }> {
    const b = parse(milestoneBody, raw);
    const etag = await this.gate(auth, 'workflow_versions', 'edit', ifMatch);
    const { reason: why, confirm_master_impact: confirm, ...patch } = b;
    const v = await this.one(Prisma.sql`SELECT admin_wf_milestone_light(${version}::int, ${etag}::int, ${node}::text, ${JSON.stringify(patch)}::jsonb, ${why}::text, ${confirm ?? null}::text) AS r`);
    return { node: ((v.milestones as Json[]) ?? []).find((m) => m.code === node) ?? {}, etag: Number(v.version_etag) };
  }

  async gate_(auth: AuthContext, version: number, node: string, ifMatch: string | undefined, raw: unknown): Promise<{ node: Json; etag: number }> {
    const b = parse(gateBody, raw);
    const etag = await this.gate(auth, 'workflow_versions', 'edit', ifMatch);
    const { reason: why, confirm_master_impact: confirm, ...patch } = b;
    const v = await this.one(Prisma.sql`SELECT admin_wf_gate_light(${version}::int, ${etag}::int, ${node}::text, ${JSON.stringify(patch)}::jsonb, ${why}::text, ${confirm ?? null}::text) AS r`);
    return { node: ((v.gates as Json[]) ?? []).find((g) => g.code === node) ?? {}, etag: Number(v.version_etag) };
  }

  /** Typed confirmation (CLAUDE.md): `v<version>`. Checked before the step-up so a typo costs no password prompt. */
  async publish(auth: AuthContext, version: number, ifMatch: string | undefined, raw: unknown): Promise<Json> {
    const b = parse(publishBody, raw);
    await this.access.requireAdmin('workflow_versions', 'administer');
    if (b.confirm_text !== `v${version}`) {
      throw new ProblemException(422, 'confirmation_mismatch', { detail: `Type v${version} to confirm.`, errors: [{ path: '/confirm_text', code: 'confirmation_mismatch' }] });
    }
    const etag = await this.gate(auth, 'workflow_versions', 'administer', ifMatch);
    return this.one(Prisma.sql`SELECT admin_wf_publish(${version}::int, ${etag}::int, ${b.reason}::text, ${b.confirm_master_impact ?? null}::text) AS r`);
  }

  async preview(version: number, raw: unknown): Promise<Json> {
    const sel = parse(selection, raw);
    await this.access.requireAdmin('workflow_versions', 'administer');
    return this.one(Prisma.sql`SELECT admin_wf_migration_preview(admin_wf_migration_sites(${JSON.stringify(sel)}::jsonb, ${version}::int), ${version}::int) AS r`);
  }

  async migrations(q: Record<string, unknown>): Promise<Json> {
    await this.access.requireAdmin('workflow_versions', 'administer');
    const site = oneParam(q, 'site_id');
    if (site !== undefined && !uuidSchema.safeParse(site).success) throw problems.validation([{ path: '/site_id', code: 'invalid', message: 'A site id.' }]);
    const to = oneParam(q, 'to_version');
    if (to !== undefined && !/^[1-9][0-9]{0,8}$/.test(to)) throw problems.validation([{ path: '/to_version', code: 'invalid', message: 'A version number.' }]);
    const limit = parseLimit(oneParam(q, 'limit'));
    const cursor = decodeCursor(oneParam(q, 'cursor'), 1);
    const offset = cursor ? Number(cursor[0]) : 0;
    if (!Number.isInteger(offset) || offset < 0) throw problems.badRequest('The cursor is not valid.');
    const r = await this.one(Prisma.sql`SELECT wf_site_migrations_json(${site ?? null}::uuid, ${to === undefined ? null : Number(to)}::int, ${limit + 1}::int, ${offset}::int) AS r`);
    const items = (r.items as Json[]) ?? [];
    return { items: items.slice(0, limit), page: { limit, next_cursor: items.length > limit ? encodeCursor([String(offset + limit)]) : null, total: r.total ?? null } };
  }
}
