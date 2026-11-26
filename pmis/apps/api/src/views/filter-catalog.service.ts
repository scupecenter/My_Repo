import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AccessService } from '../access/access.service';
import { problems } from '../common/problem';
import { DbService } from '../db/db.service';
import { COLUMNS_SQL } from '../site-master/site-master-columns-sql';
import { buildMenu, SITE_MASTER_MENUS, type SiteMasterColumnRow, type SiteMasterMenu } from '../site-master/site-master-sections';
import {
  compileFilter,
  FilterCatalog,
  FilterField,
  FilterFieldType,
  FilterGroup,
  FilterGroupInfo,
  fieldDto,
  FILTER_LIMITS,
  OPERATORS,
  parseFilterParam,
  parseFilterTree,
  treeFields,
} from './filter-compiler';

/**
 * F3 (contract 0.15.31): the whitelist of filter fields of each list screen, and the one entry point the lists use to compile a filter tree.
 *
 * Built-in fields are constants of this file with fixed SQL over the aliases of each list query:
 *   - sites, sites-stream: `s` = sites (GET /sites, GET /site-master/{menu}/rows);
 *   - dashboard (0.15.45): the same fields as `sites`; the dashboard endpoints narrow their site set with it;
 *   - site-master-<menu> (0.15.45): the `sites` fields plus the Master columns of the menu (`m:<ord>`, the value of site_master_values; one derived table per
 *     column used, joined by GET /site-master/{menu}/rows);
 *   - site-tasks, tasks-board: `t` = task_instances, `td` = task_definitions, `st` = stage_definitions, `s` = sites (GET /sites/{id}/tasks; F5 GET /boards/tasks);
 *   - register-<key>: `r` = register_records, `s` = sites (GET /registers/{key}/records).
 * Data-defined fields come from the configuration: `f:<code>` the active fields of a register (its own and its custom fields), `c:<code>` the
 * site custom fields offered in list filters, `ms:<STAGE>` the approved milestone date of a stage of the default workflow. Hidden fields are
 * decided by the database for the caller (sv_filter_hidden): they are left out of the catalogue and refused like unknown ones.
 *
 * Value lists (0.15.45): a field that holds codes or repeating text is an `enum` whose `options` are the distinct non-empty values the caller can see
 * (row security and region scope apply), at most CAP of them with `truncated` when there are more; a list field offers the values of its list catalogue.
 * The options are loaded only for GET /saved-views/filter-fields, never when a list compiles its filter; and a value that is not in the options of such a
 * field is not an error (the data changes), it matches nothing.
 */
const CAP = 500;

const SCENARIOS = ['new_build', 'expansion', 'hot_swap', 'cold_swap', 'relocation'];
const SITE_STATUSES = ['not_started', 'in_progress', 'on_hold', 'completed', 'cancelled'];
const RECORD_STATES = ['entry', 'in_review', 'in_approval', 'approved', 'voided'];
const TASK_STATES = ['locked', 'open', 'entry', 'in_review', 'in_approval', 'approved', 'rejected', 'na', 'skipped', 'suspended'];
const CODE = /^[a-z][a-z0-9_]{0,60}$/;
/** The custom-field entity of each register (the same map as sv_hidden_column, migration 0065). */
const REGISTER_ENTITY: Record<string, string> = {
  procurement: 'procurement',
  gecol: 'gecol',
  hlc: 'hlc',
  permits_hse: 'permit',
  quality: 'quality',
  issues: 'issue',
  risks: 'risk',
  change_control: 'change_request',
  readiness_handover: 'readiness',
  as_built: 'as_built',
  meetings: 'meeting',
  rf_design: 'rf_design',
  acquisition: 'acquisition',
  contractors: 'external_party',
};

const opts = (values: string[]) =>
  values.map((v) => ({
    value: v,
    label_en: v.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
  }));
const field = (key: string, label_en: string, label_ar: string, type: FilterFieldType, expr: Prisma.Sql, options?: FilterField['options'], group?: FilterGroupInfo): FilterField => ({
  key,
  label_en,
  label_ar,
  type,
  expr,
  ...(options ? { options } : {}),
  ...(group ? { group } : {}),
});

const G = {
  site: { key: 'site', label_en: 'Site', label_ar: 'الموقع' },
  delivery: { key: 'delivery', label_en: 'Delivery', label_ar: 'التسليم' },
  tower: { key: 'tower', label_en: 'Tower and RF', label_ar: 'البرج والراديو' },
  scope: { key: 'scope', label_en: 'Scope', label_ar: 'النطاق' },
  milestones: {
    key: 'milestones',
    label_en: 'Milestone dates',
    label_ar: 'تواريخ المعالم',
  },
  custom: { key: 'custom', label_en: 'Custom fields', label_ar: 'حقول مخصصة' },
  task: { key: 'task', label_en: 'Task', label_ar: 'المهمة' },
  record: { key: 'record', label_en: 'Record', label_ar: 'السجل' },
  fields: { key: 'fields', label_en: 'Fields', label_ar: 'الحقول' },
  dates: { key: 'dates', label_en: 'Dates', label_ar: 'التواريخ' },
} as const satisfies Record<string, FilterGroupInfo>;
const groupOf = (name: string | null | undefined, fallback: FilterGroupInfo): FilterGroupInfo => {
  const n = (name ?? '').trim();
  return n
    ? {
        key: `g:${
          n
            .toLowerCase()
            .replace(/[^a-z0-9\u0600-\u06ff]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 60) || 'x'
        }`,
        label_en: n,
        label_ar: n,
      }
    : fallback;
};

/** Where the options of an enum field come from; resolved only when the builder asks for the options. */
type OptionWant =
  { kind: 'site'; expr: Prisma.Sql } | { kind: 'register'; key: string; expr: Prisma.Sql; regs: number[] | null } | { kind: 'catalogue'; code: string } | { kind: 'site_list'; code: string };

/** Master columns whose value is already a field of `sites` (same value, same label): the sites field is offered, not a second copy. */
const MASTER_ORD_IS_SITE_FIELD = new Set([2, 4, 5, 6, 7, 10, 11, 13, 14, 15, 16, 17, 19, 20, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 180, 181, 182]);
/** Master columns whose value is read from a register through a branch of site_master_values that has no row in task_field_sources (migration 0133). */
const VIEW_REGISTER_ORDS: Record<number, string> = {
  18: 'as_built',
  104: 'as_built',
  34: 'procurement',
  35: 'procurement',
  36: 'procurement',
  37: 'procurement',
  83: 'procurement',
  38: 'permits_hse',
  80: 'permits_hse',
  75: 'gecol',
  76: 'hlc',
  113: 'change_control',
  153: 'readiness_handover',
  167: 'readiness_handover',
  170: 'dismantle',
  173: 'dismantle',
  175: 'dismantle',
  178: 'dismantle',
  183: 'issues',
  184: 'issues',
  185: 'issues',
  186: 'issues',
  187: 'issues',
};
const SITE_MASTER_MENU_KEYS: readonly string[] = SITE_MASTER_MENUS.map((m) => m.key);
/** The menu of a `site-master-<menu>` screen, or null. */
const siteMasterMenu = (screen: string): SiteMasterMenu | null => {
  const m = /^site-master-([a-z_]{2,20})$/.exec(screen)?.[1];
  return m && SITE_MASTER_MENU_KEYS.includes(m) ? (m as SiteMasterMenu) : null;
};
const isSitesLike = (screen: string): boolean => screen === 'sites' || screen === 'sites-stream' || screen === 'dashboard' || siteMasterMenu(screen) !== null;

/** A register or custom field type, as the builder offers it. */
function typeOf(t: string | null): FilterFieldType | null {
  switch (t) {
    case 'number':
    case 'integer':
    case 'currency':
    case 'percent':
    case 'percentage':
      return 'number';
    case 'date':
    case 'datetime':
    case 'date_time':
      return 'date';
    case 'yes_no':
    case 'bool':
    case 'boolean':
      return 'bool';
    case 'text':
    case 'long_text':
    case 'list':
    case 'list_code':
    case 'email':
    case 'phone':
    case 'link':
    case 'external_team':
      return 'text';
    default:
      return null; // files, child lists, people, multi values: not filterable in this version (open question Q561)
  }
}
/** The SQL of a value kept as text in a jsonb column, typed for the comparison. */
function typed(text: Prisma.Sql, t: FilterFieldType): Prisma.Sql {
  if (t === 'number') return Prisma.sql`sv_try_numeric(${text})`;
  if (t === 'date') return Prisma.sql`sv_try_date(${text})`;
  if (t === 'bool') return Prisma.sql`(CASE lower(${text}) WHEN 'true' THEN true WHEN 'yes' THEN true WHEN 'false' THEN false WHEN 'no' THEN false END)`;
  return text;
}

export type FilterScreen = 'sites' | 'dashboard' | 'site-tasks' | 'tasks-board' | 'library-archive' | `register-${string}` | `site-master-${string}`;

@Injectable()
export class FilterCatalogService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
  ) {}

  /** The screens with a filter builder. Other saved-view screens (the logs) keep their simple filters. */
  static supports(screen: string): boolean {
    return isSitesLike(screen) || screen === 'site-tasks' || screen === 'tasks-board' || screen === 'library-archive' || /^register-[a-z0-9_]{2,60}$/.test(screen);
  }

  /**
   * The modules whose view right the filter fields of the screens of 0.15.45 need (they have no saved views, so sv_screen_module does not know them), or
   * null for the other screens. The dashboard shows site data, so it needs the Site Register as well.
   */
  static modulesOf(screen: string): string[] | null {
    if (screen === 'dashboard') return ['dashboard', 'sites'];
    return siteMasterMenu(screen) ? ['sites'] : null;
  }

  private async regionOptions() {
    const rows = await this.db.tx.$queryRaw<{ id: number; name_en: string; name_ar: string | null }[]>`SELECT id, name_en, name_ar FROM regions ORDER BY id`;
    return rows.map((r) => ({
      value: String(r.id),
      label_en: r.name_en,
      label_ar: r.name_ar,
    }));
  }

  private async sites(): Promise<Built> {
    const regions = await this.regionOptions();
    const wants = new Map<string, OptionWant>();
    /** A text field that holds codes or repeating text: an enum whose values are the distinct values of the data (loaded on demand). */
    const data = (key: string, en: string, ar: string, expr: Prisma.Sql, group: FilterGroupInfo): FilterField => {
      wants.set(key, { kind: 'site', expr });
      return {
        ...field(key, en, ar, 'enum', expr, undefined, group),
        open: true,
      };
    };
    const YES_NA = [
      { value: 'yes', label_en: 'Yes', label_ar: 'نعم' },
      { value: 'na', label_en: 'N/A', label_ar: 'لا ينطبق' },
    ];
    const out: FilterField[] = [
      field('site_code', 'Site ID', 'رمز الموقع', 'text', Prisma.sql`s.site_code`, undefined, G.site),
      field('name', 'Site name', 'اسم الموقع', 'text', Prisma.sql`s.name`, undefined, G.site),
      field('region_id', 'Region', 'المنطقة', 'enum', Prisma.sql`s.region_id::text`, regions, G.site),
      data('sub_region', 'Sub-region', 'المنطقة الفرعية', Prisma.sql`s.sub_region`, G.site),
      data('cluster_code', 'Cluster', 'العنقود', Prisma.sql`(SELECT fc.cluster_code FROM clusters fc WHERE fc.id = s.cluster_id)`, G.site),
      field('created_at', 'Created on', 'تاريخ الإنشاء', 'date', Prisma.sql`cal_local_date(s.created_at)`, undefined, G.site),
      field('delivery_scenario', 'Delivery scenario', 'سيناريو التسليم', 'enum', Prisma.sql`s.delivery_scenario::text`, opts(SCENARIOS), G.delivery),
      field('overall_status', 'Overall status', 'الحالة العامة', 'enum', Prisma.sql`s.overall_status::text`, opts(SITE_STATUSES), G.delivery),
      data('delivery_batch', 'Delivery batch', 'دفعة التسليم', Prisma.sql`s.delivery_batch`, G.delivery),
      data('project_phase', 'Project phase', 'مرحلة المشروع', Prisma.sql`s.project_phase`, G.delivery),
      data('cw_delivery_model', 'CW delivery model', 'نموذج تسليم الأعمال المدنية', Prisma.sql`s.cw_delivery_model`, G.delivery),
      data('current_milestone', 'Current milestone', 'المعلم الحالي', Prisma.sql`s.current_milestone`, G.delivery),
      data('next_milestone', 'Next milestone', 'المعلم التالي', Prisma.sql`s.next_milestone`, G.delivery),
      field('workflow_locks', 'Workflow locks on', 'أقفال التسلسل مفعّلة', 'bool', Prisma.sql`s.workflow_locks`, undefined, G.delivery),
      data('site_type', 'Site type', 'نوع الموقع', Prisma.sql`s.site_type`, G.tower),
      data('site_scenario', 'Site scenario', 'سيناريو الموقع', Prisma.sql`s.site_scenario`, G.tower),
      data('tower_owner', 'Tower owner', 'مالك البرج', Prisma.sql`s.tower_owner`, G.tower),
      data('existing_or_new', 'Existing or new', 'قائم أو جديد', Prisma.sql`s.existing_or_new`, G.tower),
      data('rt_or_gf', 'Rooftop or greenfield', 'سطح أو أرض', Prisma.sql`s.rt_or_gf`, G.tower),
      data('tower_type', 'Tower type', 'نوع البرج', Prisma.sql`s.tower_type`, G.tower),
      field('tower_height_m', 'Tower height (m)', 'ارتفاع البرج (م)', 'number', Prisma.sql`s.tower_height_m`, undefined, G.tower),
      field('rf_survey_date', 'RF survey date', 'تاريخ المسح الراديوي', 'date', Prisma.sql`s.rf_survey_date`, undefined, G.tower),
      field('acquisition_date', 'Acquisition date', 'تاريخ الاستحواذ', 'date', Prisma.sql`s.acquisition_date`, undefined, G.tower),
      field('scope_tower_erection', 'Scope: tower erection', 'النطاق: إقامة البرج', 'enum', Prisma.sql`s.scope_tower_erection::text`, YES_NA, G.scope),
      field('scope_site_adaption', 'Scope: site adaption', 'النطاق: تهيئة الموقع', 'enum', Prisma.sql`s.scope_site_adaption::text`, YES_NA, G.scope),
      field('scope_gecol_power', 'Scope: GECOL power', 'النطاق: طاقة الشركة العامة للكهرباء', 'enum', Prisma.sql`s.scope_gecol_power::text`, YES_NA, G.scope),
      field('scope_hlc_fiber', 'Scope: HLC fiber', 'النطاق: ألياف HLC', 'enum', Prisma.sql`s.scope_hlc_fiber::text`, YES_NA, G.scope),
      field('scope_te_full', 'Scope: TE full scope', 'النطاق: نطاق التركيبات الكامل', 'enum', Prisma.sql`s.scope_te_full::text`, YES_NA, G.scope),
      field('scope_te_ip_router_only', 'Scope: TE IP router only', 'النطاق: راوتر IP فقط', 'enum', Prisma.sql`s.scope_te_ip_router_only::text`, YES_NA, G.scope),
    ];
    // the approved milestone date of each stage (the stable stage codes of the workflow versions in use)
    const stages = await this.db.tx.$queryRaw<{ code: string; name_en: string; name_ar: string | null }[]>`
      SELECT DISTINCT ON (st.code) st.code, st.name_en, st.name_ar FROM stage_definitions st JOIN workflow_definitions w ON w.id = st.workflow_id
      WHERE st.is_active ORDER BY st.code, w.version DESC`;
    for (const st of stages.filter((x) => /^[A-Z][A-Z0-9_]{0,30}$/.test(x.code)).sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }))) {
      out.push(
        field(
          `ms:${st.code}`,
          `${st.name_en} (milestone date)`,
          `${st.name_ar ?? st.name_en} (تاريخ المعلم)`,
          'date',
          Prisma.sql`(
        SELECT max(ft.actual_date) FROM task_instances ft JOIN task_definitions ftd ON ftd.id = ft.task_def_id JOIN stage_definitions fst ON fst.id = ftd.stage_id
        WHERE ft.site_id = s.id AND fst.code = ${st.code} AND ftd.is_milestone_task AND ft.state = 'approved')`,
          undefined,
          G.milestones,
        ),
      );
    }
    const custom = await this.db.tx.$queryRaw<
      {
        code: string;
        label_en: string;
        label_ar: string | null;
        data_type: string;
      }[]
    >`
      SELECT code, label_en, label_ar, data_type::text AS data_type FROM field_definitions
      WHERE entity_type = 'site'::"FieldEntityType" AND is_active AND in_list_filters AND task_code IS NULL ORDER BY sort_order, code`;
    for (const c of custom) {
      if (!CODE.test(c.code)) continue;
      const expr = Prisma.sql`(s.custom ->> ${c.code})`;
      if (c.data_type === 'list') {
        // a list field: its values are the list of the field (loaded on demand)
        wants.set(`c:${c.code}`, { kind: 'site_list', code: c.code });
        out.push({
          ...field(`c:${c.code}`, c.label_en, c.label_ar ?? c.label_en, 'enum', expr, undefined, G.custom),
          open: true,
        });
        continue;
      }
      const t = typeOf(c.data_type);
      if (!t) continue;
      out.push(field(`c:${c.code}`, c.label_en, c.label_ar ?? c.label_en, t, typed(expr, t), undefined, G.custom));
    }
    return { fields: out, wants };
  }

  /**
   * The fields of a site-master-<menu> screen: the `sites` fields and the Master columns of the menu (the same columns, the same order and the same type
   * as the grid; a column the caller cannot see is left out). A Master column that is already a `sites` field is not offered twice.
   */
  private async siteMasterFields(menu: SiteMasterMenu): Promise<Built> {
    const built = await this.sites();
    const rows = await this.db.tx.$queryRaw<SiteMasterColumnRow[]>(Prisma.sql`${COLUMNS_SQL} WHERE mc.is_active ORDER BY mc.display_order`);
    const cols = buildMenu(menu, rows).columns.filter((c) => c.ord > 1 && !MASTER_ORD_IS_SITE_FIELD.has(c.ord) && c.source_kind !== 'not_tracked' && Number.isInteger(c.ord));
    if (!cols.length) return built;
    const vis = await this.siteMasterVisibility();
    const visibleKeys = [...vis.visible];
    const listOrds = cols.filter((c) => c.value_type === 'list').map((c) => c.ord);
    const fixed = new Map<number, string[]>();
    if (listOrds.length) {
      const o = await this.db.tx.$queryRaw<{ ord: number; options: unknown }[]>(Prisma.sql`
        SELECT mc.ord, tf.options FROM master_columns mc JOIN template_task_fields tf ON tf.master_col = mc.letter AND tf.is_active
        WHERE mc.ord = ANY(${listOrds}::int[]) AND tf.options IS NOT NULL`);
      for (const r of o) if (Array.isArray(r.options) && r.options.every((x) => typeof x === 'string')) fixed.set(r.ord, r.options as string[]);
    }
    for (const c of cols) {
      if (vis.hiddenOrds.has(c.ord)) continue; // a site custom field the caller may not see (field rules)
      const reg = vis.registerOf.get(c.ord);
      if (reg && !vis.visible.has(reg)) continue; // a value of a register the caller may not view (B3)
      let type = masterType(c);
      if (type === 'list' && !c.list_catalogue && !fixed.get(c.ord)) type = 'text'; // a list column with no list defined yet has no values to offer
      const alias = Prisma.raw(`fmv${c.ord}`);
      const key = `m:${c.ord}`;
      const join = Prisma.sql`LEFT JOIN (SELECT v.site_id, min(v.value) AS value FROM site_master_values v
        WHERE v.ord = ${c.ord}::int AND (v.register_key IS NULL OR v.register_key = ANY(${visibleKeys}::text[])) GROUP BY v.site_id) ${alias} ON ${alias}.site_id = s.id`;
      const raw = Prisma.sql`${alias}.value`;
      const group = groupOf(c.group_top, G.fields);
      if (type === 'list') {
        const f: FilterField = {
          ...field(key, c.header, c.name_ar ?? c.header, 'enum', raw, undefined, group),
          open: true,
          join,
        };
        const own = fixed.get(c.ord);
        if (c.list_catalogue) built.wants.set(key, { kind: 'catalogue', code: c.list_catalogue });
        else if (own) {
          f.options = own.slice(0, CAP).map((v) => ({ value: v, label_en: v }));
          f.truncated = own.length > CAP;
        }
        built.fields.push(f);
        continue;
      }
      built.fields.push({
        ...field(key, c.header, c.name_ar ?? c.header, type, typed(raw, type), undefined, group),
        join,
      });
    }
    return built;
  }

  /** The registers the caller may view, the Master columns filled by a site custom field the caller may not see, and the register of each register-owned column. */
  private async siteMasterVisibility(): Promise<{
    visible: Set<string>;
    hiddenOrds: Set<number>;
    registerOf: Map<number, string>;
  }> {
    const keys = await this.db.tx.$queryRaw<{ register_key: string }[]>(Prisma.sql`
      SELECT d.register_key FROM register_definitions d WHERE app_has_permission(app_actor(), d.module_key, 'view'::"PermissionAction")`);
    const hidden = await this.db.tx.$queryRaw<{ ord: number }[]>(Prisma.sql`
      SELECT mc.ord FROM field_definitions fd JOIN master_columns mc ON mc.letter = fd.master_export_column OR mc.source_field_id = fd.id
      WHERE fd.entity_type::text = 'site' AND fd.is_active AND coalesce(app_resolve_field_access(app_actor(), fd.id)::text, 'edit') = 'hidden'`);
    const regs = await this.db.tx.$queryRaw<{ ord: number; register_key: string }[]>(Prisma.sql`
      SELECT mc.ord, x.register_key FROM task_field_sources x JOIN master_columns mc ON mc.letter = x.master_col WHERE x.is_active AND x.master_col IS NOT NULL`);
    const registerOf = new Map<number, string>(Object.entries(VIEW_REGISTER_ORDS).map(([o, k]) => [Number(o), k]));
    for (const r of regs) registerOf.set(r.ord, r.register_key);
    return {
      visible: new Set(keys.map((k) => k.register_key)),
      hiddenOrds: new Set(hidden.map((h) => h.ord)),
      registerOf,
    };
  }

  private async tasks(): Promise<Built> {
    const regions = await this.regionOptions();
    return {
      wants: new Map(),
      fields: [
        field('task_code', 'Task code', 'رمز المهمة', 'text', Prisma.sql`td.code`, undefined, G.task),
        field('task_name', 'Task name', 'اسم المهمة', 'text', Prisma.sql`td.name_en`, undefined, G.task),
        field('stage_code', 'Milestone stage', 'المرحلة', 'text', Prisma.sql`st.code`, undefined, G.task),
        field('stream_code', 'Stream', 'المسار', 'text', Prisma.sql`st.stream_code`, undefined, G.task),
        field('state', 'State', 'الحالة', 'enum', Prisma.sql`t.state::text`, opts(TASK_STATES), G.task),
        field('region_id', 'Region', 'المنطقة', 'enum', Prisma.sql`t.region_id::text`, regions, G.site),
        field('site_code', 'Site ID', 'رمز الموقع', 'text', Prisma.sql`s.site_code`, undefined, G.site),
        field('due_date', 'Due date', 'تاريخ الاستحقاق', 'date', Prisma.sql`t.due_date`, undefined, G.dates),
        field('actual_date', 'Actual date', 'التاريخ الفعلي', 'date', Prisma.sql`t.actual_date`, undefined, G.dates),
        field('late', 'Late', 'متأخرة', 'bool', Prisma.sql`(t.state NOT IN ('approved', 'na', 'skipped', 'locked') AND t.due_date IS NOT NULL AND t.due_date < cal_today())`, undefined, G.task),
        field('counts_toward_milestone', 'Counts toward the milestone', 'تُحتسب في المعلم', 'bool', Prisma.sql`td.counts_toward_milestone`, undefined, G.task),
      ],
    };
  }

  /**
   * W5 (0.15.70): the Archive list of Library > Archive. Built-in fields over the alias `s` of the archive rows (LibraryService.ROWS: one row per site
   * document, with its lifecycle status); region scope, the register modules and row security are applied by the list beside the compiled condition.
   */
  private async archive(): Promise<Built> {
    const regions = await this.regionOptions();
    const doc = { key: 'document', label_en: 'Document', label_ar: 'المستند' };
    return {
      wants: new Map(),
      fields: [
        field('site_code', 'Site ID', 'رمز الموقع', 'text', Prisma.sql`s.site_code`, undefined, G.site),
        field('site_name', 'Site name', 'اسم الموقع', 'text', Prisma.sql`s.name`, undefined, G.site),
        field('region_id', 'Region', 'المنطقة', 'enum', Prisma.sql`s.region_id::text`, regions, G.site),
        field('cluster', 'Cluster', 'المجموعة', 'text', Prisma.sql`s.cluster`, undefined, G.site),
        field('status', 'Status', 'الحالة', 'enum', Prisma.sql`s.status`, [
          { value: 'due', label_en: 'Due', label_ar: 'مستحق' },
          { value: 'generated', label_en: 'Generated', label_ar: 'مُولَّد' },
          { value: 'signed_uploaded', label_en: 'Signed and uploaded', label_ar: 'موقَّع ومرفوع' },
          { value: 'in_review', label_en: 'In review', label_ar: 'قيد المراجعة' },
          { value: 'approved', label_en: 'Approved', label_ar: 'معتمد' },
          { value: 'rejected', label_en: 'Rejected', label_ar: 'مرفوض' },
          { value: 'superseded', label_en: 'Superseded', label_ar: 'نسخة سابقة' },
        ], doc),
        field('doc_number', 'Document number', 'رقم المستند', 'text', Prisma.sql`s.doc_number`, undefined, doc),
        field('version', 'Version', 'الإصدار', 'number', Prisma.sql`s.version`, undefined, doc),
        field('file_name', 'File name', 'اسم الملف', 'text', Prisma.sql`s.file_name`, undefined, doc),
        field('candidate_label', 'Candidate', 'المرشح', 'text', Prisma.sql`s.candidate_label`, undefined, doc),
        field('task_code', 'Task code', 'رمز المهمة', 'text', Prisma.sql`s.task_code`, undefined, G.task),
        field('uploaded_at', 'Upload date', 'تاريخ الرفع', 'date', Prisma.sql`(s.uploaded_at AT TIME ZONE 'Africa/Tripoli')::date`, undefined, G.dates),
        field('approved_at', 'Approval date', 'تاريخ الاعتماد', 'date', Prisma.sql`s.approved_at`, undefined, G.dates),
        field('generated_at', 'Generation date', 'تاريخ التوليد', 'date', Prisma.sql`(s.generated_at AT TIME ZONE 'Africa/Tripoli')::date`, undefined, G.dates),
      ],
    };
  }

  private async register(key: string): Promise<Built> {
    const def = await this.db.tx.$queryRaw<{ register_key: string; module_key: string }[]>`SELECT register_key, module_key FROM register_definitions WHERE register_key = ${key} AND is_active`;
    if (!def.length) throw problems.validation([{ path: '/screen_key', code: 'invalid', message: 'Unknown register.' }]);
    const regs = await this.access.regions(def[0]!.module_key, 'view');
    const regions = await this.regionOptions();
    const wants = new Map<string, OptionWant>();
    const data = Prisma.sql`reg_data_for(r.id, r.register_key, r.record_type, r.entity_id, r.data)`;
    const recordType = {
      ...field('record_type', 'Record type', 'نوع السجل', 'enum', Prisma.sql`r.record_type`, undefined, G.record),
      open: true,
    };
    wants.set('record_type', {
      kind: 'register',
      key,
      expr: Prisma.sql`r.record_type`,
      regs,
    });
    const out: FilterField[] = [
      field('site_code', 'Site ID', 'رمز الموقع', 'text', Prisma.sql`s.site_code`, undefined, G.record),
      field('region_id', 'Region', 'المنطقة', 'enum', Prisma.sql`r.region_id::text`, regions, G.record),
      field('state', 'State', 'الحالة', 'enum', Prisma.sql`r.state`, opts(RECORD_STATES), G.record),
      recordType,
      field('created_at', 'Created on', 'تاريخ الإنشاء', 'date', Prisma.sql`cal_local_date(r.created_at)`, undefined, G.dates),
      field('updated_at', 'Last changed on', 'تاريخ آخر تعديل', 'date', Prisma.sql`cal_local_date(r.updated_at)`, undefined, G.dates),
      field('approved_at', 'Approved on', 'تاريخ الاعتماد', 'date', Prisma.sql`cal_local_date(r.approved_at)`, undefined, G.dates),
    ];
    const own = await this.db.tx.$queryRaw<
      {
        code: string;
        label_en: string;
        label_ar: string | null;
        field_type: string;
        options: unknown;
        list_catalogue: string | null;
        section: string | null;
      }[]
    >`
      SELECT code, label_en, label_ar, field_type, options, list_catalogue, section FROM register_fields WHERE register_key = ${key} AND is_active AND in_filter ORDER BY sort_order, code`;
    for (const f of own) {
      const t = typeOf(f.field_type);
      if (!t || !CODE.test(f.code)) continue;
      const k = `f:${f.code}`;
      const expr = Prisma.sql`(${data} ->> ${f.code})`;
      const group = groupOf(f.section, G.fields);
      // a fixed list of values becomes a checked choice (as before 0.15.45)
      const values = Array.isArray(f.options) && f.options.every((x) => typeof x === 'string') ? (f.options as string[]) : null;
      if (t === 'text' && f.field_type === 'list' && values && values.length > 0 && values.length <= 200) {
        out.push(
          field(
            k,
            f.label_en,
            f.label_ar ?? f.label_en,
            'enum',
            typed(expr, t),
            values.map((v) => ({ value: v, label_en: v })),
            group,
          ),
        );
        continue;
      }
      // a list or list_code field: the values of its catalogue, else the distinct values of the register (a multiple-value list keeps the text operators)
      const multiple = !!f.options && typeof f.options === 'object' && !Array.isArray(f.options) && (f.options as { multiple?: unknown }).multiple === true;
      if (t === 'text' && (f.field_type === 'list' || f.field_type === 'list_code') && !multiple) {
        wants.set(k, f.list_catalogue ? { kind: 'catalogue', code: f.list_catalogue } : { kind: 'register', key, expr, regs });
        out.push({
          ...field(k, f.label_en, f.label_ar ?? f.label_en, 'enum', typed(expr, t), undefined, group),
          open: true,
        });
        continue;
      }
      out.push(field(k, f.label_en, f.label_ar ?? f.label_en, t, typed(expr, t), undefined, group));
    }
    const entity = REGISTER_ENTITY[key];
    if (entity) {
      const custom = await this.db.tx.$queryRaw<
        {
          code: string;
          label_en: string;
          label_ar: string | null;
          data_type: string;
        }[]
      >`
        SELECT code, label_en, label_ar, data_type::text AS data_type FROM field_definitions
        WHERE entity_type::text = ${entity} AND is_active AND task_code IS NULL ORDER BY sort_order, code`;
      const ownCodes = new Set(own.map((f) => f.code));
      for (const c of custom) {
        const t = typeOf(c.data_type);
        if (!t || !CODE.test(c.code) || ownCodes.has(c.code)) continue;
        out.push(field(`f:${c.code}`, c.label_en, c.label_ar ?? c.label_en, t, typed(Prisma.sql`(r.custom ->> ${c.code})`, t), undefined, G.custom));
      }
    }
    return { fields: out, wants };
  }

  /**
   * Loads the options of the enum fields that want them: the distinct non-empty values the caller can see (region scope and row security apply, a field the
   * caller may not see is not in `fields`), or the active values of a list catalogue; at most CAP each, `truncated` when there are more.
   */
  private async resolveOptions(fields: FilterField[], wants: Map<string, OptionWant>): Promise<void> {
    const byKey = new Map(fields.map((f) => [f.key, f]));
    const set = (key: string, rows: { value: string; label_en?: string; label_ar?: string | null }[]): void => {
      const f = byKey.get(key);
      if (!f) return;
      f.truncated = rows.length > CAP;
      f.options = rows.slice(0, CAP).map((r) => ({
        value: r.value,
        label_en: r.label_en ?? r.value,
        ...(r.label_ar ? { label_ar: r.label_ar } : {}),
      }));
    };
    const mine = [...wants].filter(([k]) => byKey.has(k));
    const distinct = async (parts: Prisma.Sql[]): Promise<Map<string, string[]>> => {
      const out = new Map<string, string[]>();
      if (!parts.length) return out;
      const rows = await this.db.tx.$queryRaw<{ k: string; v: string }[]>(Prisma.sql`${Prisma.join(parts, ' UNION ALL ')}`);
      for (const r of rows) out.set(r.k, [...(out.get(r.k) ?? []), r.v]);
      return out;
    };
    // distinct values of site fields
    const siteWants = mine.filter(([, w]) => w.kind === 'site') as [string, Extract<OptionWant, { kind: 'site' }>][];
    if (siteWants.length) {
      const regs = await this.access.regions('sites', 'view');
      const scope = regs === null ? Prisma.empty : Prisma.sql`AND s.region_id = ANY(${regs}::int[])`;
      const got = await distinct(
        siteWants.map(
          ([k, w]) => Prisma.sql`(SELECT ${k}::text AS k, d.v FROM (SELECT DISTINCT (${w.expr})::text AS v FROM sites s WHERE s.is_active ${scope}) d
        WHERE nullif(btrim(d.v), '') IS NOT NULL ORDER BY d.v LIMIT ${CAP + 1})`,
        ),
      );
      for (const [k] of siteWants)
        set(
          k,
          (got.get(k) ?? []).map((v) => ({ value: v })),
        );
    }
    // distinct values of register fields
    const regWants = mine.filter(([, w]) => w.kind === 'register') as [string, Extract<OptionWant, { kind: 'register' }>][];
    if (regWants.length) {
      const got = await distinct(
        regWants.map(
          ([k, w]) => Prisma.sql`(SELECT ${k}::text AS k, d.v FROM (SELECT DISTINCT (${w.expr})::text AS v FROM register_records r
        WHERE r.register_key = ${w.key} AND ${w.regs === null ? Prisma.sql`true` : Prisma.sql`(r.is_global OR r.region_id = ANY(${w.regs}::int[]))`}
          AND NOT EXISTS (SELECT 1 FROM register_records n WHERE n.entity_id = r.entity_id AND n.version_no > r.version_no)) d
        WHERE nullif(btrim(d.v), '') IS NOT NULL ORDER BY d.v LIMIT ${CAP + 1})`,
        ),
      );
      for (const [k] of regWants)
        set(
          k,
          (got.get(k) ?? []).map((v) => ({ value: v })),
        );
    }
    // list catalogues (Master columns of type list, register list fields)
    const catWants = mine.filter(([, w]) => w.kind === 'catalogue') as [string, Extract<OptionWant, { kind: 'catalogue' }>][];
    if (catWants.length) {
      const codes = [...new Set(catWants.map(([, w]) => w.code))];
      const rows = await this.db.tx.$queryRaw<
        {
          catalogue_code: string;
          code: string;
          label_en: string;
          label_ar: string | null;
        }[]
      >(Prisma.sql`
        SELECT v.catalogue_code, v.code, v.label_en, v.label_ar FROM list_values v WHERE v.catalogue_code = ANY(${codes}::text[]) AND v.is_active
        ORDER BY v.catalogue_code, v.sort_order, v.code`);
      for (const [k, w] of catWants)
        set(
          k,
          rows
            .filter((r) => r.catalogue_code === w.code)
            .slice(0, CAP + 1)
            .map((r) => ({
              value: r.code,
              label_en: r.label_en,
              label_ar: r.label_ar,
            })),
        );
    }
    // the values of a site list field
    const listWants = mine.filter(([, w]) => w.kind === 'site_list') as [string, Extract<OptionWant, { kind: 'site_list' }>][];
    if (listWants.length) {
      const codes = listWants.map(([, w]) => w.code);
      const rows = await this.db.tx.$queryRaw<
        {
          fcode: string;
          code: string;
          label_en: string;
          label_ar: string | null;
        }[]
      >(Prisma.sql`
        SELECT fd.code AS fcode, l.code, l.label_en, l.label_ar FROM field_list_values l JOIN field_definitions fd ON fd.id = l.field_id
        WHERE fd.entity_type = 'site'::"FieldEntityType" AND fd.code = ANY(${codes}::text[]) AND l.is_active ORDER BY fd.code, l.sort_order, l.code`);
      for (const [k, w] of listWants)
        set(
          k,
          rows
            .filter((r) => r.fcode === w.code)
            .slice(0, CAP + 1)
            .map((r) => ({
              value: r.code,
              label_en: r.label_en,
              label_ar: r.label_ar,
            })),
        );
    }
  }

  /** The visible fields of a screen (hidden ones left out) and where the value list of each enum field comes from. */
  private async build(screen: string, withOptions: boolean): Promise<Built> {
    if (!FilterCatalogService.supports(screen)) {
      throw problems.validation([
        {
          path: '/screen_key',
          code: 'invalid',
          message: 'This list has no filter builder.',
        },
      ]);
    }
    const menu = siteMasterMenu(screen);
    const built = menu
      ? await this.siteMasterFields(menu)
      : isSitesLike(screen)
        ? await this.sites()
        : screen === 'site-tasks' || screen === 'tasks-board'
          ? await this.tasks()
          : screen === 'library-archive'
            ? await this.archive()
          : await this.register(screen.slice('register-'.length));
    const hidden = new Set(
      await this.hidden(
        screen,
        built.fields.map((f) => f.key),
      ),
    );
    const fields = built.fields.filter((f) => !hidden.has(f.key));
    if (withOptions) await this.resolveOptions(fields, built.wants);
    return { fields, wants: built.wants };
  }

  /** The whitelist of a screen for the signed-in caller (hidden fields left out); `withOptions` loads the value lists of the enum fields (the builder only). */
  async catalog(screen: string, withOptions = false): Promise<FilterCatalog> {
    const { fields } = await this.build(screen, withOptions);
    return new Map(fields.map((f) => [f.key, f]));
  }

  /**
   * GET /saved-views/filter-fields/{field}/values (0.15.49): the values of one enum field that match `q`, so that a value beyond the first CAP of a cut list is
   * reachable. The same sources, the same scope and the same hidden-field rules as the catalogue: a field the caller may not see is unknown (422 `unknown_field`),
   * the distinct values of the data are those of the rows the caller can see (region scope, row security), a list field matches the active values of its list
   * catalogue by code or label. `q` matches anywhere in the value or the label, case-insensitively and without wildcards; at most `limit` items, `truncated`
   * when there are more.
   */
  async values(screen: string, key: string, q: string, limit: number): Promise<{ screen_key: string; field: string; q: string; items: NonNullable<FilterField['options']>; truncated: boolean }> {
    const { fields, wants } = await this.build(screen, false);
    const f = fields.find((x) => x.key === key);
    if (!f) throw problems.validation([{ path: '/field', code: 'unknown_field', message: `${key} is not a filter field of this list.` }]);
    if (f.type !== 'enum') throw problems.validation([{ path: '/field', code: 'not_enum', message: `${key} has no list of values.` }]);
    const needle = q.trim().toLowerCase().slice(0, 100);
    const has = (...cols: Prisma.Sql[]) =>
      needle ? Prisma.sql`AND (${Prisma.join(cols.map((c) => Prisma.sql`strpos(lower(${c}), ${needle}::text) > 0`), ' OR ')})` : Prisma.empty;
    const w = wants.get(key);
    let rows: { value: string; label_en?: string; label_ar?: string | null }[];
    if (!w) {
      // a fixed set (regions, statuses, scope flags, the fixed options of a column): nothing is cut, it is filtered here
      rows = (f.options ?? []).filter((o) => !needle || o.value.toLowerCase().includes(needle) || o.label_en.toLowerCase().includes(needle) || (o.label_ar ?? '').toLowerCase().includes(needle));
    } else if (w.kind === 'site') {
      const regs = await this.access.regions('sites', 'view');
      const scope = regs === null ? Prisma.empty : Prisma.sql`AND s.region_id = ANY(${regs}::int[])`;
      const got = await this.db.tx.$queryRaw<{ v: string }[]>(Prisma.sql`
        SELECT d.v FROM (SELECT DISTINCT (${w.expr})::text AS v FROM sites s WHERE s.is_active ${scope}) d
        WHERE nullif(btrim(d.v), '') IS NOT NULL ${has(Prisma.sql`d.v`)} ORDER BY d.v LIMIT ${limit + 1}`);
      rows = got.map((r) => ({ value: r.v }));
    } else if (w.kind === 'register') {
      const got = await this.db.tx.$queryRaw<{ v: string }[]>(Prisma.sql`
        SELECT d.v FROM (SELECT DISTINCT (${w.expr})::text AS v FROM register_records r
          WHERE r.register_key = ${w.key} AND ${w.regs === null ? Prisma.sql`true` : Prisma.sql`(r.is_global OR r.region_id = ANY(${w.regs}::int[]))`}
            AND NOT EXISTS (SELECT 1 FROM register_records n WHERE n.entity_id = r.entity_id AND n.version_no > r.version_no)) d
        WHERE nullif(btrim(d.v), '') IS NOT NULL ${has(Prisma.sql`d.v`)} ORDER BY d.v LIMIT ${limit + 1}`);
      rows = got.map((r) => ({ value: r.v }));
    } else if (w.kind === 'catalogue') {
      rows = await this.db.tx.$queryRaw<{ value: string; label_en: string; label_ar: string | null }[]>(Prisma.sql`
        SELECT v.code AS value, v.label_en, v.label_ar FROM list_values v WHERE v.catalogue_code = ${w.code} AND v.is_active
          ${has(Prisma.sql`v.code`, Prisma.sql`v.label_en`, Prisma.sql`coalesce(v.label_ar, '')`)} ORDER BY v.sort_order, v.code LIMIT ${limit + 1}`);
    } else {
      rows = await this.db.tx.$queryRaw<{ value: string; label_en: string; label_ar: string | null }[]>(Prisma.sql`
        SELECT l.code AS value, l.label_en, l.label_ar FROM field_list_values l JOIN field_definitions fd ON fd.id = l.field_id
        WHERE fd.entity_type = 'site'::"FieldEntityType" AND fd.code = ${w.code} AND l.is_active
          ${has(Prisma.sql`l.code`, Prisma.sql`l.label_en`, Prisma.sql`coalesce(l.label_ar, '')`)} ORDER BY l.sort_order, l.code LIMIT ${limit + 1}`);
    }
    return {
      screen_key: screen,
      field: key,
      q: q.trim(),
      truncated: rows.length > limit,
      items: rows.slice(0, limit).map((r) => ({ value: r.value, label_en: r.label_en ?? r.value, ...(r.label_ar ? { label_ar: r.label_ar } : {}) })),
    };
  }

  /** The field ids among these that the caller may not see on the screen (the database decides; built-in ids are never hidden). */
  async hidden(screen: string, fields: string[]): Promise<string[]> {
    const dyn = fields.filter((f) => /^[fc]:/.test(f));
    if (!dyn.length) return [];
    // the sites-like screens of 0.15.45 hold the fields of `sites`: the database knows them as the screen `sites`
    const sc = isSitesLike(screen) ? 'sites' : screen;
    const rows = await this.db.tx.$queryRaw<{ r: string[] }[]>(Prisma.sql`SELECT sv_filter_hidden(${sc}::text, ${dyn}::text[]) AS r`);
    return rows[0]?.r ?? [];
  }

  /** GET /saved-views/filter-fields: what the builder offers on a screen. */
  async describe(screen: string): Promise<Record<string, unknown>> {
    const cat = await this.catalog(screen, true);
    return {
      screen_key: screen,
      items: [...cat.values()].map(fieldDto),
      operators: OPERATORS,
      limits: {
        max_depth: FILTER_LIMITS.maxDepth,
        max_items_per_group: FILTER_LIMITS.maxItemsPerGroup,
        max_groups: FILTER_LIMITS.maxGroups,
        max_conditions: FILTER_LIMITS.maxConditions,
        max_values: FILTER_LIMITS.maxValues,
      },
    };
  }

  /** Validates a stored tree (the `advanced` key of a view's filters) for the caller: shape, limits, fields, operators and values. */
  async validate(screen: string, raw: unknown, base = '/filters/advanced'): Promise<void> {
    if (raw === undefined || raw === null) return;
    const tree = parseFilterTree(raw, base);
    if (!FilterCatalogService.supports(screen))
      throw problems.validation([
        {
          path: base,
          code: 'invalid',
          message: 'This list has no filter builder.',
        },
      ]);
    compileFilter(tree, await this.catalog(screen), [], base);
  }

  /**
   * The `filter` query parameter of a list, compiled for the caller, or null when absent. The result is a boolean SQL expression over the
   * aliases of the screen; the caller ANDs it with its own visibility conditions, which it never replaces.
   */
  async fromQuery(screen: FilterScreen, q: Record<string, unknown>): Promise<Prisma.Sql | null> {
    return (await this.compile(screen, q)).where;
  }

  /** Like fromQuery, with the JOINs the compiled condition needs (site-master-<menu>: one derived table per Master column used); the list adds them to its FROM clause. */
  async compile(screen: FilterScreen, q: Record<string, unknown>): Promise<{ where: Prisma.Sql | null; joins: Prisma.Sql }> {
    const tree: FilterGroup | null = parseFilterParam(q.filter);
    if (!tree || tree.items.length === 0) return { where: null, joins: Prisma.empty };
    const cat = await this.catalog(screen);
    const keys = treeFields(tree);
    const hidden = await this.hidden(screen, keys);
    const where = compileFilter(tree, cat, hidden);
    const joins = keys.map((k) => cat.get(k)?.join).filter((j): j is Prisma.Sql => j !== undefined);
    return {
      where,
      joins: joins.length ? Prisma.join(joins, ' ') : Prisma.empty,
    };
  }

  /**
   * The sites of the `filter` tree of a dashboard request (screen `dashboard`), or null without a filter. The tree is compiled against the sites whitelist and
   * evaluated for the caller (region scope and row security), so it only narrows; the dashboard engine then keeps these sites only (pmis.dash_sites, migration 0137).
   */
  async siteSet(q: Record<string, unknown>): Promise<string[] | null> {
    const { where } = await this.compile('dashboard', q);
    if (!where) return null;
    await this.access.requireRegions('sites', 'view'); // the filter reads site data: the Site Register right is needed, as for the catalogue
    const regs = await this.access.regions('sites', 'view');
    const rows = await this.db.tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT s.id::text AS id FROM sites s WHERE s.is_active ${regs === null ? Prisma.empty : Prisma.sql`AND s.region_id = ANY(${regs}::int[])`} AND ${where}`);
    return rows.map((r) => r.id);
  }
}

interface Built {
  fields: FilterField[];
  wants: Map<string, OptionWant>;
}

/** The filter type of a Master column (0.15.45): the effective type of the column; a column with no type of its own that holds dates is a date. */
function masterType(c: SiteMasterColumnRow & { group_top: string | null }): FilterFieldType | 'list' {
  switch (c.value_type) {
    case 'date':
      return 'date';
    case 'number':
      return 'number';
    case 'yes_no':
      return 'bool';
    case 'list':
      return 'list';
    default:
      break;
  }
  if (c.source_kind === 'baseline' || c.source_kind === 'milestone' || c.group_top === 'Phase Gate' || /\bdate\b/i.test(c.header)) return 'date';
  if (c.ord === 8 || c.ord === 9) return 'number';
  return 'text';
}
