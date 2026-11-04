import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { problems } from '../common/problem';
import { isCalendarDate } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';

type Json = Record<string, unknown>;
export const DELAY_PARTIES = ['gecol', 'hlc', 'client', 'contractor', 'external', 'aljeel'] as const;
const day = z.string().refine(isCalendarDate, 'Use YYYY-MM-DD.');
const reason = z.string().trim().min(3).max(1000);
const addSchema = z.object({
  from_date: day, to_date: day, party: z.enum(DELAY_PARTIES), external_party_id: z.string().uuid().nullable().optional(), reason,
  evidence: z.string().trim().max(2000).nullable().optional(),
}).strict();
const voidSchema = z.object({ reason }).strict();
const decideSchema = z.object({
  decision: z.enum(['approve', 'reject']), note: z.string().trim().max(1000).nullable().optional(), external_party_id: z.string().uuid().nullable().optional(),
}).strict();

interface Row {
  id: string; from_date: string; to_date: string; party: string; external_party_id: string | null; ext_name: string | null; reason: string; created_at: Date;
  by_id: string; by_name: string | null; by_emp: string | null; voided_at: Date | null; void_reason: string | null; vby_id: string | null; vby_name: string | null; vby_emp: string | null;
  status: 'proposed' | 'approved' | 'rejected'; evidence: string | null; decided_at: Date | null; decision_note: string | null;
  dby_id: string | null; dby_name: string | null; dby_emp: string | null;
}

/**
 * Delay attribution periods of a task (owner answers Q122, migration 0046; Q182 and Q184, migration 0059). L1 or L2 of the task, a System Admin or a
 * holder of `dashboard.delay` edit in the task's region proposes a period (from, to, the responsible party, a reason, optional evidence); it has no
 * effect until L2, a System Admin or the delegate approves it, never the proposer. Approving a `contractor` or `external` period needs the named
 * external party. A period is voided with a reason, never deleted. The database checks every right and rule and writes the audit rows
 * (delay_period_propose / delay_period_decide / delay_period_void).
 */
@Injectable()
export class DelayPeriodsService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
  ) {}

  /** The task, when the caller may see it in the Site Register (404 otherwise, VI-02). */
  private async task(rawId: string): Promise<{ id: string; region_id: number; due_date: string | null }> {
    const id = parse(uuidSchema, rawId);
    const regions = await this.access.requireRegions('sites', 'view');
    const r = await this.db.tx.$queryRaw<{ id: string; region_id: number; due_date: string | null }[]>`
      SELECT id::text AS id, region_id, due_date::text AS due_date FROM task_instances WHERE id = ${id}::uuid`;
    const t = r[0];
    if (!t || (regions !== null && !regions.includes(t.region_id))) throw problems.notFound('The task does not exist or is not visible to you.');
    return t;
  }

  private async rows(taskId: string): Promise<Json[]> {
    const rows = await this.db.tx.$queryRaw<Row[]>`
      SELECT p.id::text AS id, p.from_date::text AS from_date, p.to_date::text AS to_date, p.party, p.external_party_id::text AS external_party_id, ep.name AS ext_name,
        p.reason, p.created_at, p.created_by::text AS by_id, u.display_name AS by_name, u.employee_id AS by_emp,
        p.voided_at, p.void_reason, p.voided_by::text AS vby_id, v.display_name AS vby_name, v.employee_id AS vby_emp,
        p.status, p.evidence, p.decided_at, p.decision_note, p.decided_by::text AS dby_id, dd.display_name AS dby_name, dd.employee_id AS dby_emp
      FROM task_delay_periods p LEFT JOIN external_parties ep ON ep.id = p.external_party_id LEFT JOIN users u ON u.id = p.created_by LEFT JOIN users v ON v.id = p.voided_by
        LEFT JOIN users dd ON dd.id = p.decided_by
      WHERE p.task_id = ${taskId}::uuid ORDER BY p.from_date, p.created_at`;
    return rows.map((r) => ({
      id: r.id, task_id: taskId, from_date: r.from_date, to_date: r.to_date, party: r.party, external_party_id: r.external_party_id, external_party_name: r.ext_name,
      reason: r.reason, created_at: r.created_at.toISOString(), created_by: { id: r.by_id, display_name: r.by_name ?? '', employee_id: r.by_emp?.trim() ?? null },
      voided: r.voided_at !== null, voided_at: r.voided_at?.toISOString() ?? null, void_reason: r.void_reason,
      voided_by: r.vby_id ? { id: r.vby_id, display_name: r.vby_name ?? '', employee_id: r.vby_emp?.trim() ?? null } : null,
      status: r.status, evidence: r.evidence,
      proposed_by: { id: r.by_id, display_name: r.by_name ?? '', employee_id: r.by_emp?.trim() ?? null },
      decided_by: r.dby_id ? { id: r.dby_id, display_name: r.dby_name ?? '', employee_id: r.dby_emp?.trim() ?? null } : null,
      decided_at: r.decided_at?.toISOString() ?? null, decision_note: r.decision_note,
      // Q184: an approved contractor / external period without its external party (only from before 0059) does not count
      counts: r.status === 'approved' && r.voided_at === null && !((r.party === 'contractor' || r.party === 'external') && r.external_party_id === null),
    }));
  }

  async list(_auth: AuthContext, rawTask: string): Promise<Json> {
    const t = await this.task(rawTask);
    const can = await this.db.tx.$queryRaw<{ ok: boolean; prop: boolean; me: string | null }[]>`
      SELECT delay_period_can_edit(${t.id}::uuid) AS ok, delay_period_can_propose(${t.id}::uuid) AS prop, app_actor()::text AS me`;
    const parties = await this.db.tx.$queryRaw<{ id: string; name: string; type: string }[]>`
      SELECT id::text AS id, name, type::text AS type FROM external_parties ORDER BY name LIMIT 500`;
    const c = can[0];
    return {
      task_id: t.id, due_date: t.due_date,
      // can_edit (0.11.0) = can_decide: approve, reject and void; can_propose (0.12.7): L1 too
      can_edit: c?.ok === true, can_decide: c?.ok === true, can_propose: c?.prop === true, me: c?.me ?? null,
      parties: [...DELAY_PARTIES], external_parties: parties, items: await this.rows(t.id),
    };
  }

  async add(_auth: AuthContext, rawTask: string, raw: unknown): Promise<Json> {
    const t = await this.task(rawTask);
    const b = parse(addSchema, raw);
    const r = await this.db.tx.$queryRaw<{ r: Json }[]>(Prisma.sql`
      SELECT delay_period_propose(${t.id}::uuid, ${b.from_date}::date, ${b.to_date}::date, ${b.party}::text, ${b.external_party_id ?? null}::uuid, ${b.reason}::text,
        ${b.evidence ?? null}::text) AS r`);
    return (await this.rows(t.id)).find((x) => x.id === r[0]!.r.id) as Json;
  }

  /** POST .../{period_id}/decision (Q182): approve or reject a proposal; never the proposer's own; a rejection needs a note. */
  async decide(_auth: AuthContext, rawTask: string, rawPeriod: string, raw: unknown): Promise<Json> {
    const t = await this.task(rawTask);
    const pid = parse(uuidSchema, rawPeriod);
    const b = parse(decideSchema, raw);
    const own = await this.db.tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM task_delay_periods WHERE id = ${pid}::uuid AND task_id = ${t.id}::uuid`;
    if (Number(own[0]?.n ?? 0) === 0) throw problems.notFound('The period does not exist on this task.');
    await this.db.tx.$queryRaw(Prisma.sql`SELECT delay_period_decide(${pid}::uuid, ${b.decision}::text, ${b.note ?? null}::text, ${b.external_party_id ?? null}::uuid)`);
    return (await this.rows(t.id)).find((x) => x.id === pid) as Json;
  }

  async void(_auth: AuthContext, rawTask: string, rawPeriod: string, raw: unknown): Promise<Json> {
    const t = await this.task(rawTask);
    const pid = parse(uuidSchema, rawPeriod);
    const b = parse(voidSchema, raw);
    const own = await this.db.tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM task_delay_periods WHERE id = ${pid}::uuid AND task_id = ${t.id}::uuid`;
    if (Number(own[0]?.n ?? 0) === 0) throw problems.notFound('The period does not exist on this task.');
    await this.db.tx.$queryRaw(Prisma.sql`SELECT delay_period_void(${pid}::uuid, ${b.reason}::text)`);
    return (await this.rows(t.id)).find((x) => x.id === pid) as Json;
  }
}
