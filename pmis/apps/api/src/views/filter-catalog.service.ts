import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { problems } from '../common/problem';
import { DbService } from '../db/db.service';
import { compileFilter, FilterCatalog, FilterField, FilterFieldType, FilterGroup, fieldDto, FILTER_LIMITS, OPERATORS, parseFilterParam, parseFilterTree, treeFields } from './filter-compiler';

/**
 * F3 (contract 0.15.31): the whitelist of filter fields of each list screen, and the one entry point the lists use to compile a filter tree.
 *
 * Built-in fields are constants of this file with fixed SQL over the aliases of each list query:
 *   - sites, sites-stream: `s` = sites (GET /sites, GET /site360/{menu}/rows);
 *   - site-tasks: `t` = task_instances, `td` = task_definitions, `st` = stage_definitions, `s` = sites (GET /sites/{id}/tasks);
 *   - register-<key>: `r` = register_records, `s` = sites (GET /registers/{key}/records).
 * Data-defined fields come from the configuration: `f:<code>` the active fields of a register (its own and its custom fields), `c:<code>` the
 * site custom fields offered in list filters, `ms:<STAGE>` the approved milestone date of a stage of the default workflow. Hidden fields are
 * decided by the database for the caller (sv_filter_hidden): they are left out of the catalogue and refused like unknown ones.
 */

const SCENARIOS = ['new_build', 'expansion', 'hot_swap', 'cold_swap', 'relocation'];
const SITE_STATUSES = ['not_started', 'in_progress', 'on_hold', 'completed', 'cancelled'];
const RECORD_STATES = ['entry', 'in_review', 'in_approval', 'approved', 'voided'];
const TASK_STATES = ['locked', 'open', 'entry', 'in_review', 'in_approval', 'approved', 'rejected', 'na', 'skipped', 'suspended'];
const CODE = /^[a-z][a-z0-9_]{0,60}$/;
/** The custom-field entity of each register (the same map as sv_hidden_column, migration 0065). */
const REGISTER_ENTITY: Record<string, string> = {
  procurement: 'procurement', gecol: 'gecol', hlc: 'hlc', permits_hse: 'permit', quality: 'quality', issues: 'issue', risks: 'risk',
  change_control: 'change_request', readiness_handover: 'readiness', as_built: 'as_built', meetings: 'meeting', rf_design: 'rf_design',
  acquisition: 'acquisition', contractors: 'external_party',
};

const opts = (values: string[]) => values.map((v) => ({ value: v, label_en: v.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) }));
const field = (key: string, label_en: string, label_ar: string, type: FilterFieldType, expr: Prisma.Sql, options?: FilterField['options']): FilterField =>
  ({ key, label_en, label_ar, type, expr, ...(options ? { options } : {}) });

/** A register or custom field type, as the builder offers it. */
function typeOf(t: string | null): FilterFieldType | null {
  switch (t) {
    case 'number': case 'integer': case 'currency': case 'percent': case 'percentage': return 'number';
    case 'date': case 'datetime': case 'date_time': return 'date';
    case 'yes_no': case 'bool': case 'boolean': return 'bool';
    case 'text': case 'long_text': case 'list': case 'list_code': case 'email': case 'phone': case 'link': case 'external_team': return 'text';
    default: return null; // files, child lists, people, multi values: not filterable in this version (open question Q561)
  }
}
/** The SQL of a value kept as text in a jsonb column, typed for the comparison. */
function typed(text: Prisma.Sql, t: FilterFieldType): Prisma.Sql {
  if (t === 'number') return Prisma.sql`sv_try_numeric(${text})`;
  if (t === 'date') return Prisma.sql`sv_try_date(${text})`;
  if (t === 'bool') return Prisma.sql`(CASE lower(${text}) WHEN 'true' THEN true WHEN 'yes' THEN true WHEN 'false' THEN false WHEN 'no' THEN false END)`;
  return text;
}

export type FilterScreen = 'sites' | 'site-tasks' | `register-${string}`;

@Injectable()
export class FilterCatalogService {
  constructor(private readonly db: DbService) {}

  /** The screens with a filter builder. Other saved-view screens (the logs) keep their simple filters. */
  static supports(screen: string): boolean {
    return screen === 'sites' || screen === 'sites-stream' || screen === 'site-tasks' || /^register-[a-z0-9_]{2,60}$/.test(screen);
  }

  private async regionOptions() {
    const rows = await this.db.tx.$queryRaw<{ id: number; name_en: string; name_ar: string | null }[]>`SELECT id, name_en, name_ar FROM regions ORDER BY id`;
    return rows.map((r) => ({ value: String(r.id), label_en: r.name_en, label_ar: r.name_ar }));
  }

  private async sites(): Promise<FilterField[]> {
    const regions = await this.regionOptions();
    const out: FilterField[] = [
      field('site_code', 'Site ID', 'رمز الموقع', 'text', Prisma.sql`s.site_code`),
      field('name', 'Site name', 'اسم الموقع', 'text', Prisma.sql`s.name`),
      field('region_id', 'Region', 'المنطقة', 'enum', Prisma.sql`s.region_id::text`, regions),
      field('sub_region', 'Sub-region', 'المنطقة الفرعية', 'text', Prisma.sql`s.sub_region`),
      field('cluster_code', 'Cluster', 'العنقود', 'text', Prisma.sql`(SELECT fc.cluster_code FROM clusters fc WHERE fc.id = s.cluster_id)`),
      field('delivery_scenario', 'Delivery scenario', 'سيناريو التسليم', 'enum', Prisma.sql`s.delivery_scenario::text`, opts(SCENARIOS)),
      field('overall_status', 'Overall status', 'الحالة العامة', 'enum', Prisma.sql`s.overall_status::text`, opts(SITE_STATUSES)),
      field('delivery_batch', 'Delivery batch', 'دفعة التسليم', 'text', Prisma.sql`s.delivery_batch`),
      field('project_phase', 'Project phase', 'مرحلة المشروع', 'text', Prisma.sql`s.project_phase`),
      field('cw_delivery_model', 'CW delivery model', 'نموذج تسليم الأعمال المدنية', 'text', Prisma.sql`s.cw_delivery_model`),
      field('current_milestone', 'Current milestone', 'المعلم الحالي', 'text', Prisma.sql`s.current_milestone`),
      field('tower_type', 'Tower type', 'نوع البرج', 'text', Prisma.sql`s.tower_type`),
      field('tower_height_m', 'Tower height (m)', 'ارتفاع البرج (م)', 'number', Prisma.sql`s.tower_height_m`),
      field('rf_survey_date', 'RF survey date', 'تاريخ المسح الراديوي', 'date', Prisma.sql`s.rf_survey_date`),
      field('acquisition_date', 'Acquisition date', 'تاريخ الاستحواذ', 'date', Prisma.sql`s.acquisition_date`),
      field('workflow_locks', 'Workflow locks on', 'أقفال التسلسل مفعّلة', 'bool', Prisma.sql`s.workflow_locks`),
      field('created_at', 'Created on', 'تاريخ الإنشاء', 'date', Prisma.sql`cal_local_date(s.created_at)`),
    ];
    // the approved milestone date of each stage (the stable stage codes of the workflow versions in use)
    const stages = await this.db.tx.$queryRaw<{ code: string; name_en: string; name_ar: string | null }[]>`
      SELECT DISTINCT ON (st.code) st.code, st.name_en, st.name_ar FROM stage_definitions st JOIN workflow_definitions w ON w.id = st.workflow_id
      WHERE st.is_active ORDER BY st.code, w.version DESC`;
    for (const st of stages.filter((x) => /^[A-Z][A-Z0-9_]{0,30}$/.test(x.code)).sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }))) {
      out.push(field(`ms:${st.code}`, `${st.name_en} (milestone date)`, `${st.name_ar ?? st.name_en} (تاريخ المعلم)`, 'date', Prisma.sql`(
        SELECT max(ft.actual_date) FROM task_instances ft JOIN task_definitions ftd ON ftd.id = ft.task_def_id JOIN stage_definitions fst ON fst.id = ftd.stage_id
        WHERE ft.site_id = s.id AND fst.code = ${st.code} AND ftd.is_milestone_task AND ft.state = 'approved')`));
    }
    const custom = await this.db.tx.$queryRaw<{ code: string; label_en: string; label_ar: string | null; data_type: string }[]>`
      SELECT code, label_en, label_ar, data_type::text AS data_type FROM field_definitions
      WHERE entity_type = 'site'::"FieldEntityType" AND is_active AND in_list_filters AND task_code IS NULL ORDER BY sort_order, code`;
    for (const c of custom) {
      const t = typeOf(c.data_type);
      if (!t || !CODE.test(c.code)) continue;
      out.push(field(`c:${c.code}`, c.label_en, c.label_ar ?? c.label_en, t, typed(Prisma.sql`(s.custom ->> ${c.code})`, t)));
    }
    return out;
  }

  private async tasks(): Promise<FilterField[]> {
    const regions = await this.regionOptions();
    return [
      field('task_code', 'Task code', 'رمز المهمة', 'text', Prisma.sql`td.code`),
      field('task_name', 'Task name', 'اسم المهمة', 'text', Prisma.sql`td.name_en`),
      field('stage_code', 'Milestone stage', 'المرحلة', 'text', Prisma.sql`st.code`),
      field('stream_code', 'Stream', 'المسار', 'text', Prisma.sql`st.stream_code`),
      field('state', 'State', 'الحالة', 'enum', Prisma.sql`t.state::text`, opts(TASK_STATES)),
      field('region_id', 'Region', 'المنطقة', 'enum', Prisma.sql`t.region_id::text`, regions),
      field('site_code', 'Site ID', 'رمز الموقع', 'text', Prisma.sql`s.site_code`),
      field('due_date', 'Due date', 'تاريخ الاستحقاق', 'date', Prisma.sql`t.due_date`),
      field('actual_date', 'Actual date', 'التاريخ الفعلي', 'date', Prisma.sql`t.actual_date`),
      field('late', 'Late', 'متأخرة', 'bool', Prisma.sql`(t.state NOT IN ('approved', 'na', 'skipped', 'locked') AND t.due_date IS NOT NULL AND t.due_date < cal_today())`),
      field('counts_toward_milestone', 'Counts toward the milestone', 'تُحتسب في المعلم', 'bool', Prisma.sql`td.counts_toward_milestone`),
    ];
  }

  private async register(key: string): Promise<FilterField[]> {
    const def = await this.db.tx.$queryRaw<{ register_key: string }[]>`SELECT register_key FROM register_definitions WHERE register_key = ${key} AND is_active`;
    if (!def.length) throw problems.validation([{ path: '/screen_key', code: 'invalid', message: 'Unknown register.' }]);
    const regions = await this.regionOptions();
    const out: FilterField[] = [
      field('site_code', 'Site ID', 'رمز الموقع', 'text', Prisma.sql`s.site_code`),
      field('region_id', 'Region', 'المنطقة', 'enum', Prisma.sql`r.region_id::text`, regions),
      field('state', 'State', 'الحالة', 'enum', Prisma.sql`r.state`, opts(RECORD_STATES)),
      field('record_type', 'Record type', 'نوع السجل', 'text', Prisma.sql`r.record_type`),
      field('created_at', 'Created on', 'تاريخ الإنشاء', 'date', Prisma.sql`cal_local_date(r.created_at)`),
      field('updated_at', 'Last changed on', 'تاريخ آخر تعديل', 'date', Prisma.sql`cal_local_date(r.updated_at)`),
      field('approved_at', 'Approved on', 'تاريخ الاعتماد', 'date', Prisma.sql`cal_local_date(r.approved_at)`),
    ];
    const own = await this.db.tx.$queryRaw<{ code: string; label_en: string; label_ar: string | null; field_type: string; options: unknown }[]>`
      SELECT code, label_en, label_ar, field_type, options FROM register_fields WHERE register_key = ${key} AND is_active ORDER BY sort_order, code`;
    const data = Prisma.sql`reg_data_for(r.id, r.register_key, r.record_type, r.entity_id, r.data)`;
    for (const f of own) {
      const t = typeOf(f.field_type);
      if (!t || !CODE.test(f.code)) continue;
      // a fixed list of values becomes a choice; a list catalogue keeps the text operators (its values are data)
      const values = Array.isArray(f.options) && f.options.every((x) => typeof x === 'string') ? (f.options as string[]) : null;
      const enumOk = t === 'text' && f.field_type === 'list' && values && values.length > 0 && values.length <= 200;
      out.push(field(`f:${f.code}`, f.label_en, f.label_ar ?? f.label_en, enumOk ? 'enum' : t, typed(Prisma.sql`(${data} ->> ${f.code})`, t),
        enumOk ? values.map((v) => ({ value: v, label_en: v })) : undefined));
    }
    const entity = REGISTER_ENTITY[key];
    if (entity) {
      const custom = await this.db.tx.$queryRaw<{ code: string; label_en: string; label_ar: string | null; data_type: string }[]>`
        SELECT code, label_en, label_ar, data_type::text AS data_type FROM field_definitions
        WHERE entity_type::text = ${entity} AND is_active AND task_code IS NULL ORDER BY sort_order, code`;
      const ownCodes = new Set(own.map((f) => f.code));
      for (const c of custom) {
        const t = typeOf(c.data_type);
        if (!t || !CODE.test(c.code) || ownCodes.has(c.code)) continue;
        out.push(field(`f:${c.code}`, c.label_en, c.label_ar ?? c.label_en, t, typed(Prisma.sql`(r.custom ->> ${c.code})`, t)));
      }
    }
    return out;
  }

  /** The whitelist of a screen for the signed-in caller (hidden fields left out). */
  async catalog(screen: string): Promise<FilterCatalog> {
    if (!FilterCatalogService.supports(screen)) {
      throw problems.validation([{ path: '/screen_key', code: 'invalid', message: 'This list has no filter builder.' }]);
    }
    const all = screen === 'sites' || screen === 'sites-stream' ? await this.sites()
      : screen === 'site-tasks' ? await this.tasks()
      : await this.register(screen.slice('register-'.length));
    const hidden = new Set(await this.hidden(screen, all.map((f) => f.key)));
    return new Map(all.filter((f) => !hidden.has(f.key)).map((f) => [f.key, f]));
  }

  /** The field ids among these that the caller may not see on the screen (the database decides; built-in ids are never hidden). */
  async hidden(screen: string, fields: string[]): Promise<string[]> {
    const dyn = fields.filter((f) => /^[fc]:/.test(f));
    if (!dyn.length) return [];
    const rows = await this.db.tx.$queryRaw<{ r: string[] }[]>(Prisma.sql`SELECT sv_filter_hidden(${screen}::text, ${dyn}::text[]) AS r`);
    return rows[0]?.r ?? [];
  }

  /** GET /saved-views/filter-fields: what the builder offers on a screen. */
  async describe(screen: string): Promise<Record<string, unknown>> {
    const cat = await this.catalog(screen);
    return {
      screen_key: screen,
      items: [...cat.values()].map(fieldDto),
      operators: OPERATORS,
      limits: { max_depth: FILTER_LIMITS.maxDepth, max_items_per_group: FILTER_LIMITS.maxItemsPerGroup, max_groups: FILTER_LIMITS.maxGroups, max_conditions: FILTER_LIMITS.maxConditions, max_values: FILTER_LIMITS.maxValues },
    };
  }

  /** Validates a stored tree (the `advanced` key of a view's filters) for the caller: shape, limits, fields, operators and values. */
  async validate(screen: string, raw: unknown, base = '/filters/advanced'): Promise<void> {
    if (raw === undefined || raw === null) return;
    const tree = parseFilterTree(raw, base);
    if (!FilterCatalogService.supports(screen)) throw problems.validation([{ path: base, code: 'invalid', message: 'This list has no filter builder.' }]);
    compileFilter(tree, await this.catalog(screen), [], base);
  }

  /**
   * The `filter` query parameter of a list, compiled for the caller, or null when absent. The result is a boolean SQL expression over the
   * aliases of the screen; the caller ANDs it with its own visibility conditions, which it never replaces.
   */
  async fromQuery(screen: FilterScreen, q: Record<string, unknown>): Promise<Prisma.Sql | null> {
    const tree: FilterGroup | null = parseFilterParam(q.filter);
    if (!tree || tree.items.length === 0) return null;
    const cat = await this.catalog(screen);
    const hidden = await this.hidden(screen, treeFields(tree));
    return compileFilter(tree, cat, hidden);
  }
}
