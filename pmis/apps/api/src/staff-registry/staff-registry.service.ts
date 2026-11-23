import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { parseIfMatch } from '../common/etag';
import { ProblemException } from '../common/problem';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';

type Json = Record<string, unknown>;

const reason = z.string().trim().min(3).max(1000);
const field = z.enum(['email', 'phone']);
export const STAFF_PHONE_RE = /^\+218 9[0-9] [0-9]{3} [0-9]{4}$/;
const EMPLOYEE_ID = /^[0-9]{4}$/;

/** MatrixAssignee as the screen sends it back: only kind and ref_id count; the label and the person's data are read again by the database. */
const assignee = z
  .object({
    kind: z.enum(['user', 'role', 'group']),
    ref_id: z.string().uuid(),
    label: z.string().max(300).optional(),
    employee_id: z.string().max(10).nullable().optional(),
    user_id: z.string().uuid().optional(),
    account_status: z.enum(['active', 'deactivated', 'deleted']).optional(),
    member_count: z.number().int().min(0).optional(),
  })
  .strict();
const fieldVisibility = z.object({ default_visible: z.boolean(), allow: z.array(assignee).max(500), deny: z.array(assignee).max(500) }).strict();
const visibilityBody = z
  .object({
    fields: z
      .object({ email: fieldVisibility.optional(), phone: fieldVisibility.optional() })
      .strict()
      .refine((f) => f.email !== undefined || f.phone !== undefined, { message: 'Give the settings of email, phone or both.' }),
    reason,
  })
  .strict();

/** StaffMemberPatch: StaffMemberFields + reason, at least one field. The employee ID and the status never change here. */
const patchBody = z
  .object({
    name_en: z.string().trim().min(2).max(200).optional(),
    name_ar: z.string().trim().min(2).max(200).optional(),
    email: z.string().trim().max(254).email().optional(),
    phone: z.string().regex(STAFF_PHONE_RE, 'The registry format is +218 9X XXX XXXX.').optional(),
    position: z.string().trim().min(1).max(200).optional(),
    team: z.enum(['cw', 'te', 'both', 'none']).optional(),
    main_role: z.string().trim().max(200).nullable().optional(),
    region: z.enum(['Tripoli', 'Middle', 'WM', 'Zawia', 'Benghazi', 'GM', 'Sebha', 'All']).optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    hidden_fields: z.array(field).max(2).optional(),
    reason,
  })
  .strict();

/**
 * Staff registry (B13; migration 0142, contract 0.15.56): the hover card for any signed-in employee, the field-visibility settings of email and phone, and the
 * edit of a row (including hiding a field for one employee). The database decides everything (people_* doors, owner pmis_definer): who may administer (System
 * Admin or an all-regions holder of users.edit), the visibility of each field for the caller, the version, the uniqueness and the audit row. Nothing here logs
 * a phone or an email.
 */
@Injectable()
export class StaffRegistryService {
  constructor(private readonly db: DbService, private readonly stepUp: StepUpService) {}

  private async one(sql: Prisma.Sql): Promise<Json> {
    const rows = await this.db.tx.$queryRaw<{ r: Json }[]>(sql);
    return rows[0]?.r ?? {};
  }

  /** 403 before any step-up for a caller who cannot administer the registry. */
  private async requireAdmin(): Promise<void> {
    const rows = await this.db.tx.$queryRaw<{ ok: boolean }[]>`SELECT people_staff_can_admin() AS ok`;
    if (rows[0]?.ok !== true) {
      throw new ProblemException(403, 'action_forbidden', { detail: 'Only a System Admin or an all-regions holder of users.edit administers the staff registry.' });
    }
  }

  private static notFound(): ProblemException {
    return new ProblemException(404, 'not_found', { detail: 'This employee ID is not in the staff registry.' });
  }

  /** GET /staff-registry/{employee_id} */
  card(employeeId: string): Promise<Json> {
    if (!EMPLOYEE_ID.test(employeeId)) throw StaffRegistryService.notFound();
    return this.one(Prisma.sql`SELECT people_staff_card(${employeeId}::text) AS r`);
  }

  /** GET /staff-registry/visibility */
  async visibility(): Promise<Json> {
    await this.requireAdmin();
    return this.one(Prisma.sql`SELECT people_staff_visibility_get() AS r`);
  }

  /** PUT /staff-registry/visibility */
  async setVisibility(auth: AuthContext, ifMatch: string | undefined, raw: unknown): Promise<Json> {
    const b = parse(visibilityBody, raw);
    await this.requireAdmin();
    const etag = parseIfMatch(ifMatch);
    await this.stepUp.require(auth);
    const fields: Json = {};
    for (const f of ['email', 'phone'] as const) {
      const v = b.fields[f];
      if (!v) continue;
      const refs = (l: typeof v.allow) => l.map((a) => ({ kind: a.kind, ref_id: a.ref_id }));
      fields[f] = { default_visible: v.default_visible, allow: refs(v.allow), deny: refs(v.deny) };
    }
    return this.one(Prisma.sql`SELECT people_save_staff_visibility(${JSON.stringify(fields)}::jsonb, ${b.reason}::text, ${etag}::int) AS r`);
  }

  /** PATCH /staff-registry/{employee_id} */
  async update(auth: AuthContext, employeeId: string, ifMatch: string | undefined, raw: unknown): Promise<Json> {
    if (raw !== null && typeof raw === 'object' && 'employee_id' in raw) {
      throw new ProblemException(422, 'validation_failed', {
        detail: 'The employee ID cannot change: deactivate the row and add a new one.',
        errors: [{ path: '/employee_id', code: 'read_only', message: 'The employee ID cannot change here.' }],
      });
    }
    const b = parse(patchBody, raw);
    const { reason: why, ...changes } = b;
    if (Object.keys(changes).length === 0) {
      throw new ProblemException(422, 'validation_failed', {
        detail: 'Give at least one field to change.',
        errors: [{ path: '/', code: 'required', message: 'Give at least one field to change.' }],
      });
    }
    await this.requireAdmin();
    if (!EMPLOYEE_ID.test(employeeId)) throw StaffRegistryService.notFound();
    const etag = parseIfMatch(ifMatch);
    await this.stepUp.require(auth);
    return this.one(Prisma.sql`SELECT people_save_staff(${employeeId}::text, ${JSON.stringify(changes)}::jsonb, ${why}::text, ${etag}::int) AS r`);
  }
}
