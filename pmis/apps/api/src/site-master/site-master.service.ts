import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { ProblemException } from '../common/problem';
import { parseSiteSearch, pastedSearchResult, siteScope, siteSearchCond, type PastedSearchDto } from '../common/site-search';
import { parse } from '../common/zod';
import { AccessService } from '../access/access.service';
import { DbService } from '../db/db.service';
import { FilterCatalogService } from '../views/filter-catalog.service';
import { BUCKETS, siteLocksGapsConds, siteStageIds } from '../sites/sites.service';
import { COLUMNS_SQL } from './site-master-columns-sql';
import { buildMenu, buildSiteMaster, SITE_MASTER_MOVABLE, type SiteMasterColumnRow, type SiteMasterMenu, type SiteMasterMenuItem, type SiteMasterSourceKind } from './site-master-sections';

const setSchema = z.object({
  sections: z.array(z.enum(SITE_MASTER_MOVABLE)).min(1).max(7),
  reason: z.string().trim().min(3).max(1000),
}).strict();

export interface SiteMasterColumnDto extends SiteMasterColumnRow {
  is_phase_gate: boolean;
}

/** Site Master menus (contract 0.15.21, F15). The column metadata is the one source; no second store. */
@Injectable()
export class SiteMasterService {
  constructor(private readonly db: DbService, private readonly stepUp: StepUpService, private readonly access: AccessService, private readonly filters: FilterCatalogService) {}

  async sections(): Promise<{ items: SiteMasterMenuItem[]; can_move: boolean }> {
    const rows = await this.db.tx.$queryRaw<SiteMasterColumnRow[]>`
      ${COLUMNS_SQL} WHERE mc.is_active ORDER BY mc.display_order`;
    const admin = await this.db.tx.$queryRaw<{ ok: boolean }[]>`
      SELECT coalesce(site360_col_can_admin(), false) AS ok`; // one right for every column change (owner decision 2026-11-22)
    return { items: buildSiteMaster(rows), can_move: admin[0]?.ok ?? false };
  }

  /** Replaces the set of menus of one column (owner decision 2026-11-15: a column may be in several menus). */
  async setSections(auth: AuthContext, rawOrd: unknown, raw: unknown): Promise<SiteMasterColumnDto> {
    const ord = Number(rawOrd);
    if (!Number.isInteger(ord) || ord < 1 || ord > 1000) {
      throw new ProblemException(422, 'validation_failed', { detail: 'The column order must be 1 to 1000.', errors: [{ path: '/ord', code: 'invalid' }] });
    }
    const b = parse(setSchema, raw);
    await this.stepUp.require(auth);
    await this.db.tx.$queryRaw(Prisma.sql`
      SELECT site360_set_sections(${ord}::integer, ${b.sections}::text[], ${b.reason}::text) AS j`);
    const rows = await this.db.tx.$queryRaw<SiteMasterColumnRow[]>`
      ${COLUMNS_SQL} WHERE mc.ord = ${ord}`;
    const r = rows[0]!;
    return { ...r, is_phase_gate: r.group_top === 'Phase Gate' };
  }

  /**
   * GET /site-master/{menu}/rows (contract 0.15.21, F15, migration 0104): one page of a menu's rows. Visibility (B3), the filters, the sort and the
   * paging are in SQL; the values come from the set-based view site360_master_values in one query for the page (no per-site path).
   */
  async rows(auth: AuthContext, rawMenu: string, q: Record<string, unknown>): Promise<SiteMasterRowsDto> {
    if (!(SITE_MASTER_MENU_KEYS as readonly string[]).includes(rawMenu)) {
      throw new ProblemException(422, 'validation_failed', { detail: 'Unknown Site Master menu.', errors: [{ path: '/menu', code: 'invalid' }] });
    }
    const menu = rawMenu as SiteMasterMenu;
    const regs = await this.access.requireRegions('sites', 'view');
    const offset = intParam(q, 'offset', 0, 1_000_000, 0);
    const limit = intParam(q, 'limit', 1, 200, 50);
    const dir = oneOf(q, 'dir', ['asc', 'desc'], 'asc');
    const sortKey = oneString(q, 'sort') ?? 'site_code';

    const colRows = await this.db.tx.$queryRaw<SiteMasterColumnRow[]>`
      ${COLUMNS_SQL} WHERE mc.is_active ORDER BY mc.display_order`;
    const menuItem = buildMenu(menu, colRows);
    const menuOrds = menuItem.columns.map((c) => c.ord);

    const sortField = SORT_FIELDS[sortKey];
    const ordSort = /^ord:([0-9]{1,4})$/.exec(sortKey);
    if (!sortField && !(ordSort && menuOrds.includes(Number(ordSort[1])))) {
      throw new ProblemException(422, 'validation_failed', { detail: 'Unknown sort for this menu.', errors: [{ path: '/sort', code: 'invalid' }] });
    }
    const sortSql = ordSort
      ? Prisma.sql`sv.value`
      : Prisma.raw(sortField!);
    // sorting on a Master column reads only the values the caller may see (register view B3, field rules), so the order is no oracle for a hidden value
    let sortJoin = Prisma.empty;
    if (ordSort) {
      const allKeys = (await this.db.tx.$queryRaw<{ register_key: string }[]>(Prisma.sql`SELECT register_key FROM register_definitions`)).map((r) => r.register_key);
      const vis = await this.registerVisibility(auth, allKeys);
      const visibleKeys = allKeys.filter((k) => vis.get(k) === true);
      const hiddenOrds = [...(await this.hiddenCustomFieldOrds(auth))];
      sortJoin = Prisma.sql`LEFT JOIN LATERAL (SELECT v.value FROM site360_master_values v WHERE v.site_id = s.id AND v.ord = ${Number(ordSort[1])}
        AND (v.register_key IS NULL OR v.register_key = ANY(${visibleKeys}::text[]))
        AND NOT (v.src_kind = 'custom_field' AND v.ord = ANY(${hiddenOrds}::int[]))) sv ON true`;
    }

    const where: Prisma.Sql[] = [Prisma.sql`s.is_active`];
    if (regs !== null) where.push(Prisma.sql`s.region_id = ANY(${regs}::int[])`);
    const base = Prisma.sql`${Prisma.join(where, ' AND ')}`;
    const filters: Prisma.Sql[] = [];
    // W8 item 5 (0.15.68): the search box: one token = contains on Site ID, Site Owner ID and name; a pasted list = exact Site ID or Site Owner ID
    const search = parseSiteSearch(oneString(q, 'q'));
    const byText = siteSearchCond(search);
    if (byText) filters.push(byText);
    const codes = csvParam(q, 'site_code', 200);
    if (codes.length) filters.push(Prisma.sql`s.site_code = ANY(${codes}::text[])`);
    const regionIds = csvParam(q, 'region_id', 7).map((x) => {
      if (!/^[1-7]$/.test(x)) throw new ProblemException(422, 'validation_failed', { detail: 'region_id is 1 to 7.', errors: [{ path: '/region_id', code: 'invalid' }] });
      return Number(x);
    });
    if (regionIds.length) filters.push(Prisma.sql`s.region_id = ANY(${regionIds}::int[])`);
    const subRegions = csvParam(q, 'sub_region', 50);
    if (subRegions.length) filters.push(Prisma.sql`s.sub_region = ANY(${subRegions}::text[])`);
    const phases = csvParam(q, 'phase', 50);
    if (phases.length) filters.push(Prisma.sql`s.project_phase = ANY(${phases}::text[])`);
    const batches = csvParam(q, 'batch', 50);
    if (batches.length) filters.push(Prisma.sql`s.delivery_batch = ANY(${batches}::text[])`);
    const scenarios = csvParam(q, 'scenario', 5);
    if (scenarios.length) filters.push(Prisma.sql`s.delivery_scenario::text = ANY(${scenarios}::text[])`);
    const models = csvParam(q, 'delivery_model', 20);
    if (models.length) filters.push(Prisma.sql`s.cw_delivery_model = ANY(${models}::text[])`);
    const statuses = csvParam(q, 'status', 5);
    if (statuses.length) filters.push(Prisma.sql`s.overall_status::text = ANY(${statuses}::text[])`);
    // contractor (AJ, the Contractor Name of the first active CW order, a procurement value): a caller without the procurement view matches nothing
    const contractors = csvParam(q, 'contractor', 50);
    if (contractors.length) {
      const mod = await this.db.tx.$queryRaw<{ module_key: string }[]>(Prisma.sql`SELECT module_key FROM register_definitions WHERE register_key = 'procurement'`);
      const canSee = mod[0] ? await this.access.hasGrant(auth, mod[0].module_key, 'view') : false;
      filters.push(canSee
        ? Prisma.sql`EXISTS (SELECT 1 FROM site360_master_values cv WHERE cv.site_id = s.id AND cv.ord = 36 AND cv.value = ANY(${contractors}::text[]))`
        : Prisma.sql`FALSE`);
    }
    const milestones = csvParam(q, 'milestone', 50);
    if (milestones.length) filters.push(Prisma.sql`s.current_milestone = ANY(${milestones}::text[])`);
    // 0.15.50: the stage, mine/late (bucket), workflow locks and data gaps filters of GET /sites, with the same meaning and the same SQL (sites.service)
    const stageCode = oneString(q, 'stage_code');
    const bucket = oneOf(q, 'bucket', BUCKETS, 'all');
    const locks = oneOf(q, 'workflow_locks', ['', 'locked', 'open'] as const, '');
    const gaps = oneOf(q, 'data_gaps', ['', 'with', 'without'] as const, '');
    filters.push(...siteLocksGapsConds(locks, gaps));
    const byStage = siteStageIds(auth.user.id, { stageCode, bucket });
    if (byStage) filters.push(Prisma.sql`s.id IN (${byStage})`);
    // F3 (0.15.31): the AND/OR filter of a saved view, compiled against the whitelist of this menu (0.15.45: the sites fields and the menu's Master columns;
    // each Master column used is one derived table joined once, set-based, with the caller's register and field visibility); the region scope of `base` stays
    const adv = await this.filters.compile(`site360-${menu}`, q);
    if (adv.where) filters.push(adv.where);
    const all = filters.length ? Prisma.sql`${base} AND ${Prisma.join(filters, ' AND ')}` : base;

    const counts = await this.db.tx.$queryRaw<{ total: number; filtered: number }[]>(Prisma.sql`
      SELECT (SELECT count(*)::int FROM sites s WHERE ${base}) AS total,
             (SELECT count(*)::int FROM sites s ${adv.joins} WHERE ${all}) AS filtered`);
    const page = await this.db.tx.$queryRaw<{ id: string; site_code: string }[]>(Prisma.sql`
      SELECT s.id::text AS id, s.site_code FROM sites s JOIN regions r ON r.id = s.region_id ${sortJoin} ${adv.joins}
      WHERE ${all}
      ORDER BY ${sortSql} ${Prisma.raw(dir === 'desc' ? 'DESC' : 'ASC')} NULLS LAST, s.site_code COLLATE "C"
      LIMIT ${limit} OFFSET ${offset}`);

    const values = new Map<string, Record<string, string | null>>();
    if (page.length) {
      const ids = page.map((r) => r.id);
      const vals = await this.db.tx.$queryRaw<{ site_id: string; ord: number; value: string | null; kind: string; register_key: string | null }[]>(Prisma.sql`
        SELECT v.site_id::text AS site_id, v.ord, v.value, v.kind, v.register_key FROM site360_master_values v
        WHERE v.site_id = ANY(${ids}::uuid[]) AND v.ord = ANY(${menuOrds}::int[])`);
      // a register-owned value is shown only to a user who may view that register (its module, B3), as the Master export does;
      // a custom-field value (0.15.35) only to a user for whom the field is not hidden
      const visible = await this.registerVisibility(auth, vals.map((v) => v.register_key));
      const hiddenFieldOrds = vals.some((v) => v.kind === 'custom_field') ? await this.hiddenCustomFieldOrds(auth) : new Set<number>();
      for (const id of ids) values.set(id, {});
      for (const v of vals) {
        const hidden = (v.register_key !== null && visible.get(v.register_key) !== true) || (v.kind === 'custom_field' && hiddenFieldOrds.has(v.ord));
        values.get(v.site_id)![String(v.ord)] = hidden ? null : v.value;
      }
    }
    // inline edit targets (F15 item 3): the open task behind a task-backed column, read-only when the task is locked or has no single owner
    const cells = new Map<string, Record<string, EditCell>>();
    if (page.length) {
      const tasks = await this.db.tx.$queryRaw<
        { site_id: string; ord: number; task_id: string; version: number; state: string; locked: boolean; field_key: string; field_type: string; options: unknown; list_catalogue: string | null; n: number }[]
      >(Prisma.sql`
        SELECT x.site_id, x.ord, x.task_id, x.version, x.state, x.locked, x.field_key, x.field_type, x.options, x.list_catalogue, x.n FROM (
          SELECT ti.site_id::text AS site_id, mc.ord, ti.id::text AS task_id, ti.version, ti.state::text AS state,
                 (ti.lock_reason IS NOT NULL OR ti.is_na) AS locked, tf.field_key, tf.field_type, tf.options, tf.list_catalogue,
                 count(*) OVER (PARTITION BY ti.site_id, mc.ord) AS n
          FROM task_instances ti
          JOIN sites s ON s.id = ti.site_id
          JOIN task_definitions td ON td.id = ti.task_def_id AND td.workflow_id = s.workflow_version_id
          JOIN template_task_fields tf ON tf.task_code = td.code AND tf.is_active AND tf.master_col IS NOT NULL
            AND (tf.field_key IN ('planned_date', 'actual_date', 'actual_start') OR tf.field_key LIKE 'v:%')
            AND (tf.scenarios IS NULL OR s.delivery_scenario::text = ANY (tf.scenarios))
          JOIN master_columns mc ON mc.letter = tf.master_col
          WHERE s.id = ANY(${page.map((r) => r.id)}::uuid[]) AND mc.ord = ANY(${menuOrds}::int[])
        ) x WHERE x.n = 1`);
      // the dropdown values of the list fields that read a list catalogue (active values, in list order), one query for the page
      const catalogues = [...new Set(tasks.filter((t) => t.list_catalogue).map((t) => t.list_catalogue!))];
      const listValues = new Map<string, CellOption[]>();
      const parentCatalogue = new Map<string, string>();
      if (catalogues.length) {
        // a dependent list (its catalogue has a parent list): each option names the code of its parent value, so the client can offer only the children of the parent value of the same row
        const lv = await this.db.tx.$queryRaw<{ catalogue_code: string; code: string; label_en: string; label_ar: string | null; parent_catalogue: string | null; parent_code: string | null }[]>(Prisma.sql`
          SELECT v.catalogue_code, v.code, v.label_en, v.label_ar, c.parent_catalogue, p.code AS parent_code FROM list_values v
          JOIN list_catalogues c ON c.code = v.catalogue_code LEFT JOIN list_values p ON p.id = v.parent_value_id
          WHERE v.catalogue_code = ANY(${catalogues}::text[]) AND v.is_active ORDER BY v.catalogue_code, v.sort_order, v.label_en`);
        for (const r of lv) {
          if (r.parent_catalogue) parentCatalogue.set(r.catalogue_code, r.parent_catalogue);
          listValues.set(r.catalogue_code, [...(listValues.get(r.catalogue_code) ?? []), { value: r.code, label_en: r.label_en, label_ar: r.label_ar, ...(r.parent_catalogue ? { parent: r.parent_code } : {}) }]);
        }
      }
      for (const t of tasks) {
        const editable = !t.locked && EDITABLE_STATES.has(t.state);
        const field = t.field_key.startsWith('v:') ? { values: t.field_key.slice(2) } : { field: t.field_key };
        const typed = cellInput(t.field_key, t.field_type, t.options, t.list_catalogue ? listValues.get(t.list_catalogue) : undefined);
        const cell: EditCell = { task_id: t.task_id, version: t.version, editable, ...field, ...typed };
        const byOrd = cells.get(t.site_id) ?? {};
        byOrd[String(t.ord)] = cell;
        cells.set(t.site_id, byOrd);
      }
      // a dependent list cell says which cell of the same site holds its parent value (the column `parent_ord`); none when the parent list is not in this menu
      attachParentOrds(tasks, cells, parentCatalogue);
    }
    const c = counts[0] ?? { total: 0, filtered: 0 };
    // found / not found: the caller's Sites view regions (`regs`), as the rows themselves
    const pasted = await pastedSearchResult(this.db.tx, search, siteScope(regs));
    return {
      menu: menuItem,
      total: c.total,
      filtered: c.filtered,
      ...(pasted ? { search: pasted } : {}),
      offset,
      limit,
      rows: page.map((r, i) => {
        const v = values.get(r.id) ?? {};
        const row_values: Record<string, string | null> = {};
        for (const ord of menuOrds) row_values[String(ord)] = v[String(ord)] ?? null;
        return { site_id: r.id, site_code: r.site_code, row_no: offset + i + 1, values: row_values, cells: cells.get(r.id) ?? {} };
      }),
    };
  }

  /** Whether the caller may view each register (its module, B3); a register key with no definition is not visible. */
  private async registerVisibility(auth: AuthContext, rawKeys: (string | null)[]): Promise<Map<string, boolean>> {
    const keys = [...new Set(rawKeys.filter((k): k is string => k !== null))];
    const visible = new Map<string, boolean>();
    if (!keys.length) return visible;
    const modules = await this.db.tx.$queryRaw<{ register_key: string; module_key: string }[]>(Prisma.sql`
      SELECT register_key, module_key FROM register_definitions WHERE register_key = ANY(${keys}::text[])`);
    for (const m of modules) visible.set(m.register_key, await this.access.hasGrant(auth, m.module_key, 'view'));
    return visible;
  }

  /** The Master columns filled by a site custom field that is hidden for the caller (field-level rules). */
  private async hiddenCustomFieldOrds(auth: AuthContext): Promise<Set<number>> {
    const rows = await this.db.tx.$queryRaw<{ ord: number }[]>(Prisma.sql`
      SELECT mc.ord FROM field_definitions fd JOIN master_columns mc ON mc.letter = fd.master_export_column OR mc.source_field_id = fd.id
      WHERE fd.entity_type::text = 'site' AND fd.is_active
        AND coalesce(app_resolve_field_access(${auth.user.id}::uuid, fd.id)::text, 'edit') = 'hidden'`);
    return new Set(rows.map((r) => r.ord));
  }

  /**
   * GET /site-master/sites/{site_id}/sources (contract 0.15.35, migration 0121): the value and the source of every Master column of one site (or of one
   * menu's columns). Per site, not per page, so a page of 1000 sites stays light: the grid asks for it when a cell is opened. The source comes from
   * the same branch of site360_master_values that computes the value, read with the caller's rights (row security): a site outside the caller's
   * regions answers 404, and a value hidden by the register's module view (B3) or by a field rule gives the source kind without value or id.
   */
  async sources(auth: AuthContext, siteId: string, q: Record<string, unknown>): Promise<SiteMasterSourcesDto> {
    if (!UUID_RE.test(siteId)) throw new ProblemException(404, 'not_found', { detail: 'Site not found.' });
    const menu = oneOf(q, 'menu', SITE_MASTER_MENU_KEYS, 'master') as SiteMasterMenu;
    const regs = await this.access.requireRegions('sites', 'view');
    const site = await this.db.tx.$queryRaw<{ id: string; site_code: string }[]>(Prisma.sql`
      SELECT s.id::text AS id, s.site_code FROM sites s
      WHERE s.id = ${siteId}::uuid AND s.is_active ${regs !== null ? Prisma.sql`AND s.region_id = ANY(${regs}::int[])` : Prisma.empty}`);
    if (!site[0]) throw new ProblemException(404, 'not_found', { detail: 'Site not found.' });
    const colRows = await this.db.tx.$queryRaw<SiteMasterColumnRow[]>`
      ${COLUMNS_SQL} WHERE mc.is_active ORDER BY mc.display_order`;
    const cols = buildMenu(menu, colRows).columns;
    const ords = cols.map((c) => c.ord);
    const vals = await this.db.tx.$queryRaw<SourceRow[]>(Prisma.sql`
      SELECT v.ord, v.value, v.kind, v.register_key, v.src_kind, v.src_ref, v.src_id::text AS src_id, v.src_field
      FROM site360_master_values v WHERE v.site_id = ${siteId}::uuid AND v.ord = ANY(${ords}::int[])`);
    const byOrd = new Map(vals.map((v) => [v.ord, v]));
    const visible = await this.registerVisibility(auth, vals.map((v) => v.register_key));
    const hiddenFieldOrds = vals.some((v) => v.kind === 'custom_field') ? await this.hiddenCustomFieldOrds(auth) : new Set<number>();

    // the rows behind the ids, read again with the caller's rights (a row the caller may not read is simply not found)
    const idsOf = (ref: string) => [...new Set(vals.filter((v) => v.src_ref === ref && v.src_id).map((v) => v.src_id!))];
    const tasks = new Map<string, TaskRef>();
    const taskIds = idsOf('task');
    if (taskIds.length) {
      const rows = await this.db.tx.$queryRaw<TaskRef[]>(Prisma.sql`
        SELECT ti.id::text AS id, td.code, td.name_en, td.name_ar, ti.state::text AS state,
               (ti.historical_direct_approved OR ti.historical_batch_id IS NOT NULL) AS historical, (ti.admin_override OR ti.admin_approved_as_is) AS override
        FROM task_instances ti JOIN task_definitions td ON td.id = ti.task_def_id WHERE ti.id = ANY(${taskIds}::uuid[])`);
      for (const r of rows) tasks.set(r.id, r);
    }
    const records = new Map<string, RecordRef>();
    const recIds = idsOf('register');
    if (recIds.length) {
      const rows = await this.db.tx.$queryRaw<RecordRef[]>(Prisma.sql`
        SELECT rr.id::text AS id, rr.register_key, rr.version_no, rr.state, rr.historical_direct_approved AS historical
        FROM register_records rr WHERE rr.id = ANY(${recIds}::uuid[])`);
      for (const r of rows) records.set(r.id, r);
    }
    const baselines = new Map<string, { id: string; version: number }>();
    const blIds = idsOf('baseline');
    if (blIds.length) {
      const rows = await this.db.tx.$queryRaw<{ id: string; version: number }[]>(Prisma.sql`
        SELECT id::text AS id, version FROM baseline_versions WHERE id = ANY(${blIds}::uuid[])`);
      for (const r of rows) baselines.set(r.id, r);
    }
    // the approved register record that feeds the site's RF & Design columns (C:Q, S) and the acquisition date (T), when the caller may read it
    const feeds = new Map<string, string>();
    const feedRows = await this.db.tx.$queryRaw<{ register_key: string; id: string }[]>(Prisma.sql`
      SELECT DISTINCT ON (rr.register_key) rr.register_key, rr.id::text AS id FROM register_records rr
      WHERE rr.site_id = ${siteId}::uuid AND rr.register_key IN ('rf_design', 'acquisition') AND rr.state = 'approved' AND rr.voided_at IS NULL
      ORDER BY rr.register_key, rr.is_current DESC, rr.version_no DESC`);
    const feedVisible = await this.registerVisibility(auth, feedRows.map((r) => r.register_key));
    for (const r of feedRows) if (feedVisible.get(r.register_key)) feeds.set(r.register_key, r.id);

    const cells: SiteMasterCellSource[] = cols.map((c) => {
      const v = byOrd.get(c.ord);
      const colKind = c.source_kind ?? 'derived';
      const base: SiteMasterCellSource = { ord: c.ord, letter: c.letter, header: c.header, kind: colKind, note: c.source_note ?? null, value: null, hidden: false, origin: null };
      if (c.ord === 1) return { ...base, kind: 'derived', origin: 'calculated' };
      if (!v) return base;
      const kind = v.src_kind as SiteMasterSourceKind;
      const hidden = (v.register_key !== null && visible.get(v.register_key) !== true) || (v.kind === 'custom_field' && hiddenFieldOrds.has(v.ord));
      if (hidden) return { ...base, kind, hidden: true, ...(v.register_key ? { register_key: v.register_key } : {}) };
      const cell: SiteMasterCellSource = { ...base, kind, value: v.value };
      if (v.src_field) cell.field = v.src_field;
      if (v.register_key) cell.register_key = v.register_key;
      if (v.src_ref === 'task' && v.src_id) {
        const t = tasks.get(v.src_id);
        if (t) {
          Object.assign(cell, { task_id: t.id, task_code: t.code, task_name_en: t.name_en, task_name_ar: t.name_ar });
          cell.origin = kind === 'derived' ? 'calculated' : t.historical ? 'historical_import' : t.override ? 'manual' : 'workflow';
        } else if (kind === 'derived') cell.origin = 'calculated';
      } else if (v.src_ref === 'register' && v.src_id) {
        const r = records.get(v.src_id);
        if (r) {
          Object.assign(cell, { record_id: r.id, record_version: r.version_no, register_key: r.register_key });
          cell.origin = kind === 'derived' ? 'calculated' : r.historical ? 'historical_import' : r.state === 'approved' ? 'approved_record' : 'pending_record';
        } else if (kind === 'derived') cell.origin = 'calculated';
      } else if (v.src_ref === 'baseline' && v.src_id) {
        const b = baselines.get(v.src_id);
        if (b) cell.baseline_version = b.version;
        cell.origin = 'approved_record';
      } else if (v.src_ref === 'custom_field') {
        cell.origin = 'manual';
      } else if (kind === 'derived') {
        cell.origin = 'calculated';
      } else if (kind === 'site') {
        const fedBy = RF_FED_ORDS.has(c.ord) ? 'rf_design' : c.ord === 20 ? 'acquisition' : null;
        const rec = fedBy ? feeds.get(fedBy) : undefined;
        cell.origin = STORED_STATUS_ORDS.has(c.ord) ? 'calculated' : rec ? 'approved_record' : 'manual';
        if (fedBy && rec) cell.fed_by = { register_key: fedBy, record_id: rec };
      }
      return cell;
    });
    return { site_id: site[0].id, site_code: site[0].site_code, menu, cells };
  }

}

/** Task states in which the L1 holder may still change the entry values (the task screen's own rule is checked again on save). */
const EDITABLE_STATES = new Set(['open', 'entry', 'rejected']);

/** Inline edit target of one cell: the task, its If-Match version and the field (a date field, or a key of the task values). */
interface EditCell {
  task_id: string;
  version: number;
  editable: boolean;
  field?: string;
  values?: string;
  /** 0.15.48: the kind of editor of the field (the template field's own type); `list` carries its `options`. */
  input_type: CellInputType;
  options?: CellOption[];
  /** 0.15.50: for a list of a dependent catalogue, the column (ord) of the cell of the same site that holds the parent value; each option's `parent` is compared with it. */
  parent_ord?: number;
}

export type CellInputType = 'date' | 'number' | 'list' | 'text' | 'boolean';
export interface CellOption { value: string; label_en: string; label_ar: string | null; /** 0.15.50: the code of the parent value (dependent lists only) */ parent?: string | null }

/**
 * The editor kind of a task-backed cell (0.15.48). The three task date keys are always dates; the other kinds follow the template field type
 * (yes_no is a boolean). A list takes its options from its catalogue (active values) or from the field's own options; a list with no option
 * degrades to text, so a cell is never left without an editor.
 */
export function cellInput(fieldKey: string, fieldType: string, options: unknown, catalogue: CellOption[] | undefined): { input_type: CellInputType; options?: CellOption[] } {
  if (['planned_date', 'actual_date', 'actual_start'].includes(fieldKey) || fieldType === 'date') return { input_type: 'date' };
  if (fieldType === 'number') return { input_type: 'number' };
  if (fieldType === 'yes_no') return { input_type: 'boolean' };
  if (fieldType === 'list') {
    const own = Array.isArray(options) ? options.filter((o): o is string => typeof o === 'string').map((o) => ({ value: o, label_en: o, label_ar: null })) : [];
    const list = catalogue?.length ? catalogue : own;
    if (list.length) return { input_type: 'list', options: list };
  }
  return { input_type: 'text' };
}

/**
 * 0.15.50: a list cell of a dependent catalogue gets `parent_ord`, the column of the cell of the same site whose list is the parent catalogue.
 * `parentCatalogue` maps a catalogue to its parent catalogue; a cell whose parent list is not among the site's cells in this menu gets none.
 */
export function attachParentOrds(
  tasks: { site_id: string; ord: number; list_catalogue: string | null }[],
  cells: Map<string, Record<string, { parent_ord?: number }>>,
  parentCatalogue: Map<string, string>,
): void {
  for (const t of tasks) {
    const pc = t.list_catalogue ? parentCatalogue.get(t.list_catalogue) : undefined;
    const parent = pc ? tasks.find((x) => x.site_id === t.site_id && x.list_catalogue === pc) : undefined;
    const cell = cells.get(t.site_id)?.[String(t.ord)];
    if (parent && cell) cell.parent_ord = parent.ord;
  }
}

const SITE_MASTER_MENU_KEYS = ['master', 'design_acq', 'sow', 'cw', 'te', 'hoto', 'dismantle', 'om'] as const;

/** Sort keys of the site fields (the join of the region is in the query). */
const SORT_FIELDS: Record<string, string> = {
  site_code: 's.site_code COLLATE "C"',
  name: 's.name',
  region: 'r.name_en',
  status: 's.overall_status::text',
  milestone: 's.current_milestone',
  phase: 's.project_phase',
};

export interface SiteMasterRowsDto {
  menu: SiteMasterMenuItem;
  total: number;
  filtered: number;
  search?: PastedSearchDto;
  offset: number;
  limit: number;
  rows: { site_id: string; site_code: string; row_no: number; values: Record<string, string | null>; cells: Record<string, EditCell> }[];
}

function oneString(q: Record<string, unknown>, key: string): string | undefined {
  const v = q[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new ProblemException(422, 'validation_failed', { detail: `${key} takes one value.`, errors: [{ path: `/${key}`, code: 'invalid' }] });
  return v;
}

function intParam(q: Record<string, unknown>, key: string, min: number, max: number, dflt: number): number {
  const v = oneString(q, key);
  if (v === undefined) return dflt;
  const n = /^[0-9]+$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw new ProblemException(422, 'validation_failed', { detail: `${key} is out of range.`, errors: [{ path: `/${key}`, code: 'invalid' }] });
  return n;
}

function oneOf<T extends string>(q: Record<string, unknown>, key: string, allowed: readonly T[], dflt: T): T {
  const v = oneString(q, key);
  if (v === undefined) return dflt;
  if (!(allowed as readonly string[]).includes(v)) throw new ProblemException(422, 'validation_failed', { detail: `${key} is not allowed.`, errors: [{ path: `/${key}`, code: 'invalid' }] });
  return v as T;
}

/** A comma-separated filter: up to max values, trimmed, empty parts dropped. */
function csvParam(q: Record<string, unknown>, key: string, max: number): string[] {
  const v = oneString(q, key);
  if (v === undefined) return [];
  const parts = v.split(',').map((x) => x.trim()).filter((x) => x.length > 0);
  if (parts.length > max || parts.some((x) => x.length > 100)) throw new ProblemException(422, 'validation_failed', { detail: `${key} has too many values.`, errors: [{ path: `/${key}`, code: 'invalid' }] });
  return parts;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Site columns written by the approval of the RF & Design record (C:Q and S, feed of 0072); T is fed by Acquisition. */
const RF_FED_ORDS = new Set([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 19]);
/** FX:FZ, the stored derived status of the site. */
const STORED_STATUS_ORDS = new Set([180, 181, 182]);

interface SourceRow {
  ord: number;
  value: string | null;
  kind: string;
  register_key: string | null;
  src_kind: string;
  src_ref: string | null;
  src_id: string | null;
  src_field: string | null;
}

interface TaskRef { id: string; code: string; name_en: string; name_ar: string | null; state: string; historical: boolean; override: boolean }
interface RecordRef { id: string; register_key: string; version_no: number; state: string; historical: boolean }

/** How a value got into the system: an approved register record (or one still in review), the workflow, the historical import, a manual or admin entry, a formula. */
export type SiteMasterOrigin = 'approved_record' | 'pending_record' | 'workflow' | 'historical_import' | 'manual' | 'calculated';

/** The source of one Master cell (contract SiteMasterCellSource). */
export interface SiteMasterCellSource {
  ord: number;
  letter: string;
  header: string;
  kind: SiteMasterSourceKind;
  note: string | null;
  value: string | null;
  hidden: boolean;
  origin: SiteMasterOrigin | null;
  field?: string;
  register_key?: string;
  record_id?: string;
  record_version?: number;
  task_id?: string;
  task_code?: string;
  task_name_en?: string;
  task_name_ar?: string | null;
  baseline_version?: number;
  fed_by?: { register_key: string; record_id: string };
}

export interface SiteMasterSourcesDto {
  site_id: string;
  site_code: string;
  menu: SiteMasterMenu;
  cells: SiteMasterCellSource[];
}
