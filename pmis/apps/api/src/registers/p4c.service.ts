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

const linksSchema = z.object({ procurement_entity_ids: z.array(z.guid()).max(20) }).strict();
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

  /** GET /registers/dismantle/rn-options?site_id=&record_type= : the received Warehouse RNs of the part (CW / TE) on the site that close a Dismantle part (0321). */
  async dismantleRnOptions(auth: AuthContext, q: Record<string, unknown>): Promise<{ items: unknown[] }> {
    await this.access.requireRegions('dismantle', 'view');
    const site = oneParam(q, 'site_id');
    const part = oneParam(q, 'record_type');
    const errs: FieldError[] = [];
    if (!site || !uuidSchema.safeParse(site).success) errs.push({ path: '/site_id', code: 'invalid', message: 'site_id is a uuid.' });
    if (part !== 'cw' && part !== 'te') errs.push({ path: '/record_type', code: 'invalid', message: 'record_type is cw or te.' });
    if (errs.length) throw problems.validation(errs);
    const items = await this.registers.call<unknown[]>(auth, Prisma.sql`SELECT dismantle_rn_options(${site}::uuid, ${part}::text) AS r`);
    return { items };
  }

  /** GET /registers/warehouse/order-options?site_id= : the approved, active Procurement orders a PL / OPEN receipt may name (row-level security applies). */
  async warehouseOrderOptions(auth: AuthContext, q: Record<string, unknown>, module = 'warehouse'): Promise<{ items: unknown[] }> {
    await this.access.requireRegions(module, 'view');
    const site = oneParam(q, 'site_id');
    if (site && !uuidSchema.safeParse(site).success) throw problems.validation([{ path: '/site_id', code: 'invalid', message: 'site_id is a uuid.' }]);
    const items = await this.registers.call<unknown[]>(auth, Prisma.sql`SELECT wh_order_options(${site ?? null}::uuid) AS r`);
    return { items };
  }

  /** GET /registers/financial_advances/advance-options?site_id= : the advances an expense or settlement may name (row-level security applies). */
  async advanceOptions(auth: AuthContext, q: Record<string, unknown>): Promise<{ items: unknown[] }> {
    await this.access.requireRegions('financial_advances', 'view');
    const site = oneParam(q, 'site_id');
    if (site && !uuidSchema.safeParse(site).success) throw problems.validation([{ path: '/site_id', code: 'invalid', message: 'site_id is a uuid.' }]);
    const items = await this.registers.call<unknown[]>(auth, Prisma.sql`SELECT fa_advance_options(${site ?? null}::uuid) AS r`);
    return { items };
  }

  /** GET /registers/{key}/links (D60): the declared links of the register (field, target register, check on or off). Needs the register view. */
  async registerLinks(auth: AuthContext, key: string): Promise<{ items: unknown[] }> {
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(key)) throw problems.validation([{ path: '/key', code: 'invalid', message: 'A register key.' }]);
    await this.access.requireRegions(key, 'view');
    const items = await this.registers.call<unknown[]>(auth, Prisma.sql`SELECT register_links_of(${key}::text) AS r`);
    return { items };
  }

  /** GET /registers/links/orphans (D60 follow-up, 0660): per declared link, the rows that hold an id that is not a current record of the target. System Admin only (the database checks). */
  async registerLinkOrphans(auth: AuthContext): Promise<{ items: unknown[] }> {
    const r = await this.registers.call<{ items: unknown[] }>(auth, Prisma.sql`SELECT register_link_orphans_report() AS r`);
    return { items: r.items ?? [] };
  }

  /** GET /registers/{key}/link-options/{field}?site_id=&q= (D60): the one generic picker of a declared link; needs the view of the target register. */
  async registerLinkOptions(auth: AuthContext, key: string, field: string, q: Record<string, unknown>): Promise<{ items: unknown[] }> {
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(key)) throw problems.validation([{ path: '/key', code: 'invalid', message: 'A register key.' }]);
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(field)) throw problems.validation([{ path: '/field', code: 'invalid', message: 'A field code.' }]);
    const site = oneParam(q, 'site_id');
    if (site && !uuidSchema.safeParse(site).success) throw problems.validation([{ path: '/site_id', code: 'invalid', message: 'site_id is a uuid.' }]);
    const text = oneParam(q, 'q');
    if (text && text.length > 100) throw problems.validation([{ path: '/q', code: 'invalid', message: 'q is up to 100 characters.' }]);
    await this.access.requireRegions(key, 'view');
    const links = await this.registers.call<{ field: string; target_register: string }[]>(auth, Prisma.sql`SELECT register_links_of(${key}::text) AS r`);
    const link = links.find((l) => l.field === field);
    if (!link) throw problems.notFound('link');
    await this.access.requireRegions(link.target_register, 'view');
    const items = await this.registers.call<unknown[]>(auth, Prisma.sql`SELECT register_link_options(${key}::text, ${field}::text, ${site ?? null}::uuid, ${text ?? null}::text) AS r`);
    return { items };
  }

  /** GET /registers/invoices/supplier-options : the active companies of the Contractors list. */
  async invoiceSupplierOptions(auth: AuthContext): Promise<{ items: unknown[] }> {
    await this.access.requireRegions('invoices', 'view');
    const items = await this.registers.call<unknown[]>(auth, Prisma.sql`SELECT invoice_supplier_options() AS r`);
    return { items };
  }

  /** GET /registers/issues/risk-options : the risks an Issue may name as realised (Issues view plus Risks view; the matrix decides the regions). */
  async issueRiskOptions(auth: AuthContext): Promise<{ items: unknown[] }> {
    await this.access.requireRegions('issues', 'view');
    const items = await this.registers.call<unknown[]>(auth, Prisma.sql`SELECT issue_risk_options() AS r`);
    return { items };
  }

  /** GET /registers/risks/{entity_id}/issues : the issues that realise one risk. */
  async riskIssues(auth: AuthContext, entityId: string): Promise<{ items: unknown[] }> {
    await this.access.requireRegions('risks', 'view');
    await this.access.requireRegions('issues', 'view');
    if (!uuidSchema.safeParse(entityId).success) throw problems.validation([{ path: '/entity_id', code: 'invalid', message: 'entity_id is a uuid.' }]);
    const items = await this.registers.call<unknown[]>(auth, Prisma.sql`SELECT risk_realised_issues(${entityId}::uuid) AS r`);
    return { items };
  }

  /** GET /registers/procurement/{entity_id}/receipts : the warehouse receipts against an order. */
  async orderReceipts(auth: AuthContext, entityId: string): Promise<{ items: unknown[] }> {
    await this.access.requireRegions('procurement', 'view');
    await this.access.requireRegions('warehouse', 'view');
    if (!uuidSchema.safeParse(entityId).success) throw problems.validation([{ path: '/entity_id', code: 'invalid', message: 'entity_id is a uuid.' }]);
    const items = await this.registers.call<unknown[]>(auth, Prisma.sql`SELECT proc_order_receipts(${entityId}::uuid) AS r`);
    return { items };
  }

  /** GET /registers/{register_key}/{entity_id}/related : the records linked to this one (the database applies the view right of each register and region). */
  async relatedRecords(auth: AuthContext, key: string, entityId: string): Promise<{ groups: unknown[] }> {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) throw problems.validation([{ path: '/register_key', code: 'invalid', message: 'Not a register key.' }]);
    if (!uuidSchema.safeParse(entityId).success) throw problems.validation([{ path: '/entity_id', code: 'invalid', message: 'entity_id is a uuid.' }]);
    await this.access.requireRegions(key, 'view');
    const groups = await this.registers.call<unknown[]>(auth, Prisma.sql`SELECT record_related(${key}::text, ${entityId}::uuid) AS r`);
    return { groups };
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
