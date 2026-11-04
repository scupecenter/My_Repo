import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { parseIfMatch } from '../common/etag';
import { problems, type FieldError } from '../common/problem';
import { oneParam } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { RegistersService } from './registers.service';

const linksSchema = z.object({ procurement_entity_ids: z.array(z.string().uuid()).max(20) }).strict();
const legacySchema = z.object({ dry_run: z.boolean(), reason: z.string().trim().min(3).max(2000).optional() }).strict();

/**
 * Work package P4c (migration 0063, contract 0.12.11): the HLC record names its purchase requests (Q150), the Dismantle order picker (Q114) and the one-time
 * migration of the legacy HLC requests into Procurement drafts (Q139). The database decides every rule; the API checks the module and the region first.
 */
@Injectable()
export class P4cService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly stepUp: StepUpService,
    private readonly registers: RegistersService,
  ) {}

  /** PUT /registers/hlc/records/{id}/purchase-requests (If-Match): replaces the list; an empty list = every submitted request of the site. */
  async setHlcPurchaseRequests(auth: AuthContext, id: string, ifMatch: string | undefined, raw: unknown): Promise<Record<string, unknown>> {
    const version = parseIfMatch(ifMatch);
    const body = parse(linksSchema, raw);
    await this.registers.get(auth, 'hlc', id);   // 404 unless the caller may see the record in the HLC module
    await this.registers.call<unknown>(auth, Prisma.sql`SELECT hlc_set_pr_links(${id}::uuid, ${version}::int, ${body.procurement_entity_ids}::uuid[]) AS r`);
    return this.registers.get(auth, 'hlc', id);
  }

  /** GET /registers/dismantle/order-options?site_id=&record_type= : the approved, active orders of the site for the part (CW Dismantle / TE Dismantle). */
  async dismantleOrderOptions(auth: AuthContext, q: Record<string, unknown>): Promise<{ items: unknown[] }> {
    await this.access.requireRegions('dismantle', 'view');
    const site = oneParam(q, 'site_id');
    const part = oneParam(q, 'record_type');
    const errs: FieldError[] = [];
    if (!site || !uuidSchema.safeParse(site).success) errs.push({ path: '/site_id', code: 'invalid', message: 'site_id is a uuid.' });
    if (part !== 'cw' && part !== 'te') errs.push({ path: '/record_type', code: 'invalid', message: 'record_type is cw or te.' });
    if (errs.length) throw problems.validation(errs);
    const items = await this.registers.call<unknown[]>(auth, Prisma.sql`SELECT dismantle_order_options(${site}::uuid, ${part}::text) AS r`);
    return { items };
  }

  /** POST /registers/hlc/legacy-migration: the preview (dry_run) or the run (reason and step-up). */
  async legacyMigration(auth: AuthContext, raw: unknown): Promise<unknown> {
    const body = parse(legacySchema, raw);
    await this.access.requireAdmin('procurement', 'administer');
    if (!body.dry_run) {
      if (!body.reason) throw problems.validation([{ path: '/reason', code: 'required', message: 'A reason of at least 3 characters is required.' }]);
      await this.stepUp.require(auth);
    }
    return this.registers.call<unknown>(auth, Prisma.sql`SELECT hlc_legacy_to_drafts(${body.dry_run}::boolean, ${body.reason ?? null}::text) AS r`);
  }
}
