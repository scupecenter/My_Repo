import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { ProblemException, problems } from '../common/problem';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { RegistersService } from '../registers/registers.service';

/**
 * L5 cross-module triggers (migration 0629, contract 0.15.488). A trigger never writes a record: the daily job proposes (before and after value) and an entry
 * holder of the target row makes the new version with the existing mechanism (new version, then the field patch, as that person: grants, Matrix and approval
 * chain apply). The database owns the rules, the dry run, the proposals and the audit; this service shapes the calls and does the two register calls of "apply".
 */
const fieldCode = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/);
const saveSchema = z.object({
  register_key: z.string().max(80),
  field_code: fieldCode,
  source_field: fieldCode,
  target_field: fieldCode,
  enabled: z.boolean().optional(),
  reason: z.string().trim().min(3).max(1000),
}).strict();

interface ProposalRow { id: string; status: string; target_register: string; target_record: string; target_version: number; target_field: string; after: string }

@Injectable()
export class LinkTriggersService {
  constructor(private readonly db: DbService, private readonly access: AccessService, private readonly registers: RegistersService) {}

  private async requireAdmin(): Promise<void> {
    if (!(await this.access.isSystemAdmin())) throw new ProblemException(403, 'action_forbidden', { detail: 'Only a System Admin manages the link triggers.' });
  }

  async get(): Promise<unknown> {
    await this.requireAdmin();
    return (await this.db.tx.$queryRaw<{ j: unknown }[]>(Prisma.sql`SELECT link_triggers_json() AS j`))[0]!.j;
  }

  async save(id: string | null, raw: unknown): Promise<{ id: string }> {
    await this.requireAdmin();
    if (id !== null && !uuidSchema.safeParse(id).success) throw problems.notFound();
    const b = parse(saveSchema, raw);
    return (await this.db.tx.$queryRaw<{ j: { id: string } }[]>(Prisma.sql`
      SELECT link_trigger_save(${id}::uuid, ${b.register_key}::text, ${b.field_code}::text, ${b.source_field}::text, ${b.target_field}::text, ${b.enabled ?? null}::boolean, ${b.reason}::text) AS j`))[0]!.j;
  }

  /** The dry run: what a run would propose now. Writes nothing. */
  async preview(id: string): Promise<unknown> {
    await this.requireAdmin();
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    return (await this.db.tx.$queryRaw<{ j: unknown }[]>(Prisma.sql`SELECT link_trigger_preview(${id}::uuid) AS j`))[0]!.j;
  }

  async proposals(q: Record<string, unknown>): Promise<{ items: unknown[] }> {
    const status = typeof q.status === 'string' && ['open', 'applied', 'dismissed', 'all'].includes(q.status) ? q.status : 'open';
    return { items: (await this.db.tx.$queryRaw<{ j: unknown[] }[]>(Prisma.sql`SELECT link_trigger_proposals_json(${status}::text) AS j`))[0]!.j };
  }

  private async one(id: string): Promise<ProposalRow> {
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    const rows = (await this.db.tx.$queryRaw<{ j: ProposalRow[] }[]>(Prisma.sql`SELECT link_trigger_proposals_json('all') AS j`))[0]!.j;
    const p = rows.find((x) => x.id === id);
    if (!p) throw problems.notFound();
    return p;
  }

  /** Apply: a new version of the approved target record, with the proposed value, made by the caller through the register service (the Matrix and the approval chain follow). */
  async apply(auth: AuthContext, id: string): Promise<{ id: string; status: string; new_record: string }> {
    const p = await this.one(id);
    if (p.status !== 'open') throw new ProblemException(409, 'invalid_transition', { detail: 'The proposal is closed already.' });
    const made = await this.registers.newVersion(auth, p.target_register, p.target_record, `"${p.target_version}"`);
    const rid = String(made.id);
    await this.registers.update(auth, p.target_register, rid, `"${String(made.version)}"`, { data: { [p.target_field]: p.after } });
    await this.db.tx.$queryRaw(Prisma.sql`SELECT link_trigger_proposal_close(${id}::uuid, 'applied'::text, ${rid}::uuid) AS j`);
    return { id, status: 'applied', new_record: rid };
  }

  async dismiss(id: string): Promise<{ id: string; status: string }> {
    await this.one(id);
    await this.db.tx.$queryRaw(Prisma.sql`SELECT link_trigger_proposal_close(${id}::uuid, 'dismissed'::text, NULL::uuid) AS j`);
    return { id, status: 'dismissed' };
  }
}
