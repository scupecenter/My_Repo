import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { decodeCursor, encodeCursor, parseLimit } from '../common/cursor';
import { problems } from '../common/problem';
import { boolParam, oneParam, Query } from '../common/query';
import { uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { DashboardService } from './dashboard.service';

type Json = Record<string, unknown>;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Project Status (ends at HOTO): the weighted progress of rules.md section 6, computed with the weight set in force, or with one named for a comparison. */
@Injectable()
export class ProjectStatusService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly dash: DashboardService,
  ) {}

  private async ref(id: string): Promise<Json> {
    const r = await this.db.tx.$queryRaw<Json[]>`
      SELECT id::text AS id, code::text AS code, version, effective_from::text AS effective_from, (id = weight_set_in_force(code::text, cal_today()) AND status = 'published') AS is_active
      FROM weight_sets WHERE id = ${id}::uuid`;
    return r[0] as Json;
  }

  // ------------------------------------------------------------------ GET /project-status
  async get(_auth: AuthContext, q: Query): Promise<Json> {
    await this.access.requireRegions('dashboard', 'view');
    const regionRaw = oneParam(q, 'region_id');
    const siteRaw = oneParam(q, 'site_id');
    const group = oneParam(q, 'group_by') ?? 'none';
    const versionRaw = oneParam(q, 'weight_set_version');
    const setRaw = oneParam(q, 'weight_set_id');
    const excl = boolParam(q, 'exclude_overrides');
    if (regionRaw !== undefined && !/^[1-7]$/.test(regionRaw)) throw problems.validation([{ path: '/region_id', code: 'invalid', message: 'region_id is 1 to 7.' }]);
    if (siteRaw !== undefined && !uuidSchema.safeParse(siteRaw).success) throw problems.validation([{ path: '/site_id', code: 'invalid', message: 'site_id is a UUID.' }]);
    if (!['none', 'region', 'site'].includes(group)) throw problems.validation([{ path: '/group_by', code: 'invalid', message: 'group_by is none, region or site.' }]);
    if (versionRaw !== undefined && !/^[1-9][0-9]{0,5}$/.test(versionRaw)) throw problems.validation([{ path: '/weight_set_version', code: 'invalid', message: 'weight_set_version is a positive integer.' }]);
    if (setRaw !== undefined && !uuidSchema.safeParse(setRaw).success) throw problems.validation([{ path: '/weight_set_id', code: 'invalid', message: 'weight_set_id is a UUID.' }]);
    if (versionRaw !== undefined && setRaw !== undefined) throw problems.validation([{ path: '/weight_set_id', code: 'conflict', message: 'Send weight_set_version or weight_set_id, not both.' }]);
    let ws: string | null = null;
    if (setRaw !== undefined) {
      const r = await this.db.tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM weight_sets WHERE id = ${setRaw}::uuid AND code = 'project_status' AND status = 'published'`;
      if (!r[0]) throw problems.validation([{ path: '/weight_set_id', code: 'unknown_weight_set', message: 'There is no published Project Status weight set with this id.' }]);
      ws = r[0].id;
    }
    if (versionRaw !== undefined) {
      const r = await this.db.tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM weight_sets WHERE version = ${Number(versionRaw)} AND code = 'project_status' AND status = 'published'`;
      if (!r[0]) throw problems.validation([{ path: '/weight_set_version', code: 'unknown_weight_set', message: 'There is no published Project Status weight set of this version.' }]);
      ws = r[0].id;
    }
    const exclude = await this.dash.excludeOverrides({ exclude_overrides: excl });
    const rows = await this.db.tx.$queryRaw<{ r: Json }[]>(Prisma.sql`
      SELECT dash_project_status(NULL::date, ${regionRaw ? Number(regionRaw) : null}::int, ${siteRaw ?? null}::uuid, ${group}::text, ${ws}::uuid, ${exclude}::boolean) AS r`);
    const r = rows[0]!.r;
    const meta = (r.meta ?? {}) as Json;
    const ps = (r.ps ?? {}) as Json;
    const card = (ps.card ?? {}) as Json;
    const weightSet = await this.ref(meta.weight_set_id as string);
    const flagged = Number(meta.override_flagged_count ?? 0);
    return {
      meta: {
        as_of: new Date().toISOString(),
        workflow_versions: meta.workflow_versions ?? [],
        override_flagged_count: flagged,
        overrides_excluded: exclude,
        weight_set: weightSet,
      },
      scope: siteRaw ? { kind: 'site', site_id: siteRaw } : regionRaw ? { kind: 'region', region_id: Number(regionRaw) } : { kind: 'project' },
      weight_set: weightSet,
      progress_pct: card.progress_pct ?? 0,
      planned_pct: card.planned_pct ?? null,
      spi: card.spi ?? null,
      plan_coverage_pct: card.plan_coverage_pct ?? 0,
      central_items_hidden: Number(card.central_items_hidden ?? 0),
      sites_in_scope: Number(ps.sites_in_scope ?? 0),
      activities: card.activities ?? [],
      ...(group !== 'none'
        ? { rows: ((ps.rows ?? []) as Json[]).map((x) => ({ key: x.key, label: x.label, progress_pct: x.progress_pct, planned_pct: x.planned_pct ?? null, activities: x.activities ?? {} })) }
        : {}),
    };
  }

  // ------------------------------------------------------------------ GET /project-status/snapshots
  async snapshots(_auth: AuthContext, q: Query): Promise<Json> {
    const regions = await this.access.requireRegions('dashboard', 'view');
    const limit = parseLimit(oneParam(q, 'limit'));
    const cursor = decodeCursor(oneParam(q, 'cursor'), 2);
    const regionRaw = oneParam(q, 'region_id');
    const from = oneParam(q, 'from');
    const to = oneParam(q, 'to');
    if (regionRaw !== undefined && !/^[1-7]$/.test(regionRaw)) throw problems.validation([{ path: '/region_id', code: 'invalid', message: 'region_id is 1 to 7.' }]);
    for (const [k, v] of [['from', from], ['to', to]] as const) {
      if (v !== undefined && (!DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)))) throw problems.validation([{ path: `/${k}`, code: 'invalid', message: `${k} is a date, YYYY-MM-DD.` }]);
    }
    // The whole-project row is a figure over every region: a caller limited to some regions sees only the rows of those regions (VI-04).
    const rows = await this.db.tx.$queryRaw<{ id: string; taken_on: string; is_global: boolean; region_id: number | null; actual_pct: string; planned_pct: string | null; spi: string | null;
      health_index: string | null; ws_id: string }[]>(Prisma.sql`
      SELECT p.id::text AS id, p.snapshot_date::text AS taken_on, p.is_global, p.region_id, p.actual_pct::text AS actual_pct, p.planned_pct::text AS planned_pct, p.spi::text AS spi,
        p.health_index::text AS health_index, p.weight_set_id::text AS ws_id
      FROM progress_snapshots p
      WHERE true
        ${regions === null ? Prisma.empty : Prisma.sql`AND NOT p.is_global AND p.region_id = ANY(${regions}::int[])`}
        ${regionRaw ? Prisma.sql`AND p.region_id = ${Number(regionRaw)}` : Prisma.empty}
        ${from ? Prisma.sql`AND p.snapshot_date >= ${from}::date` : Prisma.empty} ${to ? Prisma.sql`AND p.snapshot_date <= ${to}::date` : Prisma.empty}
        ${cursor ? Prisma.sql`AND (p.snapshot_date, p.id::text) < (${cursor[0] as string}::date, ${cursor[1] as string})` : Prisma.empty}
      ORDER BY p.snapshot_date DESC, p.id::text DESC LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit);
    const sets = new Map<string, Json>();
    for (const id of new Set(page.map((r) => r.ws_id))) sets.set(id, await this.ref(id));
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        id: r.id,
        taken_on: r.taken_on,
        scope: r.is_global ? 'project' : 'region',
        region_id: r.region_id,
        progress_pct: Number(r.actual_pct),
        planned_pct: r.planned_pct === null ? null : Number(r.planned_pct),
        spi: r.spi === null ? null : Number(r.spi),
        health_index: r.health_index === null ? null : Number(r.health_index),
        weight_set: sets.get(r.ws_id),
      })),
      page: { limit, next_cursor: rows.length > limit && last ? encodeCursor([last.taken_on, last.id]) : null },
    };
  }
}
