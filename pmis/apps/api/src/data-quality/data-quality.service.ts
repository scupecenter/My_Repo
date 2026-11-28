import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { parseIfMatch } from '../common/etag';
import { problems } from '../common/problem';
import { oneParam, Query } from '../common/query';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';

export const DQ_CHECKS = ['site_required_empty', 'dates_out_of_order', 'site_without_contractor', 'orphan_ids', 'missing_photos'] as const;
type Check = (typeof DQ_CHECKS)[number];
/** Site columns an admin may require (the closed list of migration 0476). Never user input in the SQL: only the list entries are used. */
const SITE_FIELDS = ['name_ar', 'latitude', 'longitude', 'address', 'site_type', 'site_scenario', 'sub_region', 'cluster_id', 'rf_survey_date', 'acquisition_date', 'project_phase'] as const;

export interface DataQualitySettingsDto {
  enabled: boolean; checks: string[]; required_site_fields: string[]; max_rows: number;
  updated_at: string | null; updated_by: unknown; version: number; can_edit: boolean;
}
interface Row { [k: string]: unknown }
export interface DataQualityCheckResult { check: Check; count: number; truncated: boolean; rows: Row[] }

const putBody = z.object({
  enabled: z.boolean(), checks: z.array(z.string()).max(20), required_site_fields: z.array(z.string()).max(20), max_rows: z.number().int(),
  reason: z.string().trim().min(3).max(1000),
}).strict();

/**
 * Contract 0.15.538 (migration 0476, D3): the read-only data quality report. It writes nothing. Sites, tasks and document slots are read with the
 * regions of the caller (module sites, view); a row carries the site and the name of what is wrong, never the value of a field. The orphan check
 * (constraint names and counts only) needs a settings viewer. Each check is switched on in Settings > Data > Quality.
 */
@Injectable()
export class DataQualityService {
  constructor(private readonly db: DbService, private readonly access: AccessService, private readonly stepUp: StepUpService) {}

  getSettings(): Promise<DataQualitySettingsDto> {
    return this.state(Prisma.sql`SELECT data_quality_state() AS r`);
  }

  async setSettings(auth: AuthContext, ifMatch: string | undefined, raw: unknown): Promise<DataQualitySettingsDto> {
    const { reason, ...body } = parse(putBody, raw);
    await this.access.requireAdmin('settings', 'edit');
    const etag = parseIfMatch(ifMatch);
    await this.stepUp.require(auth);
    return this.state(Prisma.sql`SELECT admin_set_data_quality(${JSON.stringify(body)}::jsonb, ${reason}::text, ${etag}::int) AS r`);
  }

  private async state(sql: Prisma.Sql): Promise<DataQualitySettingsDto> {
    return (await this.db.tx.$queryRaw<{ r: DataQualitySettingsDto }[]>(sql))[0]!.r;
  }

  async report(q: Query): Promise<{ enabled: boolean; max_rows: number; checks: DataQualityCheckResult[] }> {
    const regions = await this.access.requireRegions('sites', 'view');
    const cfg = await this.getSettings();
    const asked = oneParam(q, 'check');
    if (asked !== undefined && !(DQ_CHECKS as readonly string[]).includes(asked)) {
      throw problems.validation([{ path: '/check', code: 'invalid', message: `check is one of ${DQ_CHECKS.join(', ')}.` }]);
    }
    const rawRegion = oneParam(q, 'region_id');
    if (rawRegion !== undefined && !/^[1-9][0-9]{0,3}$/.test(rawRegion)) throw problems.validation([{ path: '/region_id', code: 'invalid', message: 'A region id.' }]);
    const region = rawRegion === undefined ? null : Number(rawRegion);
    if (region !== null && regions !== null && !regions.includes(region)) throw problems.validation([{ path: '/region_id', code: 'invalid', message: 'Not one of your regions.' }]);
    if (!cfg.enabled) return { enabled: false, max_rows: cfg.max_rows, checks: [] };
    const on = DQ_CHECKS.filter((c) => cfg.checks.includes(c) && (asked === undefined || asked === c));
    const scope = (alias: string): Prisma.Sql => {
      const c: Prisma.Sql[] = [];
      if (regions !== null) c.push(Prisma.sql`${Prisma.raw(alias)}.region_id = ANY(${regions}::int[])`);
      if (region !== null) c.push(Prisma.sql`${Prisma.raw(alias)}.region_id = ${region}`);
      return c.length ? Prisma.sql` AND ${Prisma.join(c, ' AND ')}` : Prisma.empty;
    };
    const lim = cfg.max_rows;
    const out: DataQualityCheckResult[] = [];
    for (const check of on) out.push(await this.run(check, cfg, scope, lim));
    return { enabled: true, max_rows: lim, checks: out };
  }

  private async run(check: Check, cfg: DataQualitySettingsDto, scope: (a: string) => Prisma.Sql, lim: number): Promise<DataQualityCheckResult> {
    const fin = (rows: (Row & { total: bigint | number })[]): DataQualityCheckResult => ({
      check, count: rows.length ? Number(rows[0]!.total) : 0, truncated: rows.length ? Number(rows[0]!.total) > rows.length : false,
      rows: rows.map(({ total, ...r }) => r),
    });
    if (check === 'site_required_empty') {
      const fields = SITE_FIELDS.filter((f) => cfg.required_site_fields.includes(f));
      if (fields.length === 0) return fin([]);
      const empty = fields.map((f) => Prisma.sql`CASE WHEN s.${Prisma.raw(f)} IS NULL OR btrim(s.${Prisma.raw(f)}::text) = '' THEN ${f}::text END`);
      const rows = await this.db.tx.$queryRaw<(Row & { total: bigint })[]>(Prisma.sql`
        SELECT * FROM (
          SELECT s.id::text AS site_id, s.site_code, s.name, s.region_id, array_remove(ARRAY[${Prisma.join(empty)}], NULL) AS fields
          FROM sites s WHERE s.is_active ${scope('s')}) x
        WHERE cardinality(x.fields) > 0`).then((all) => all as unknown as Row[]);
      const total = rows.length;
      return fin(rows.slice(0, lim).map((r) => ({ ...r, total })) as (Row & { total: number })[]);
    }
    if (check === 'dates_out_of_order') {
      const rows = await this.db.tx.$queryRaw<(Row & { total: bigint })[]>(Prisma.sql`
        SELECT s.id::text AS site_id, s.site_code, t.id::text AS task_id, t.region_id,
          CASE WHEN t.planned_start > t.planned_date THEN 'planned_start_after_planned_date' ELSE 'actual_start_after_actual_date' END AS problem,
          count(*) OVER () AS total
        FROM task_instances t JOIN sites s ON s.id = t.site_id
        WHERE s.is_active AND ((t.planned_start IS NOT NULL AND t.planned_date IS NOT NULL AND t.planned_start > t.planned_date)
                            OR (t.actual_start IS NOT NULL AND t.actual_date IS NOT NULL AND t.actual_start > t.actual_date)) ${scope('t')}
        ORDER BY s.site_code COLLATE "C", t.id LIMIT ${lim}`);
      return fin(rows);
    }
    if (check === 'site_without_contractor') {
      const rows = await this.db.tx.$queryRaw<(Row & { total: bigint })[]>(Prisma.sql`
        SELECT s.id::text AS site_id, s.site_code, s.name, s.region_id, count(*) OVER () AS total
        FROM sites s WHERE s.is_active ${scope('s')}
          AND NOT EXISTS (SELECT 1 FROM task_instances t WHERE t.site_id = s.id AND t.external_party_id IS NOT NULL)
        ORDER BY s.site_code COLLATE "C" LIMIT ${lim}`);
      return fin(rows);
    }
    if (check === 'missing_photos') {
      // The D6 rule (0.15.564): the photo_rules.min_count of the type against the current, not superseded, not withdrawn image files of the slot.
      const rows = await this.db.tx.$queryRaw<(Row & { total: bigint })[]>(Prisma.sql`
        SELECT * FROM (
          SELECT s.id::text AS site_id, s.site_code, d.code AS doc_code, d.name_en AS doc_name, sl.id::text AS slot_id, s.region_id,
            (d.photo_rules ->> 'min_count')::int AS min_count,
            (SELECT count(*)::int FROM document_files f WHERE f.slot_id = sl.id AND f.is_current AND f.superseded_by IS NULL AND f.withdrawn_at IS NULL
               AND lower(coalesce(f.mime_type, '')) LIKE 'image/%') AS photos
          FROM document_slots sl JOIN document_types d ON d.id = sl.doc_type_id JOIN sites s ON s.id = sl.site_id
          WHERE s.is_active AND d.is_active AND jsonb_typeof(d.photo_rules::jsonb) = 'object' AND (d.photo_rules ->> 'min_count') ~ '^[1-9][0-9]{0,5}$' ${scope('sl')}) x
        WHERE x.photos < x.min_count`).then((all) => all as unknown as Row[]);
      const total = rows.length;
      return fin(rows.slice(0, lim).map((r) => ({ ...r, total })) as (Row & { total: number })[]);
    }
    // orphan_ids: constraint names and counts, for a settings viewer only
    await this.access.requireAdmin('settings', 'view');
    const j = (await this.db.tx.$queryRaw<{ j: Row[] }[]>(Prisma.sql`SELECT data_quality_orphans() AS j`))[0]!.j;
    const total = j.length;
    return fin(j.slice(0, lim).map((r) => ({ ...r, total })) as (Row & { total: number })[]);
  }
}
