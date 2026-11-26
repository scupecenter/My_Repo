// MSW handlers of P10 (contract 0.12.12, owner answers Q115 and Q117): saved views on the server and the caller's drafts. They behave like the
// real API where the screens care: a private view is only the owner's (another account gets 404), sharing needs views.share (the PM and the
// Team Lead accounts here), only the owner or views.manage (the PM) changes a shared view, every change bumps the version (If-Match), and a
// view is deactivated, never deleted. The state is per mock database, so resetDb() starts it again.
import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import type { Draft, SavedView, SavedViewAudience } from '@/api/views';
import { db, viewer, type Db } from './db';
import { guard, problem } from './handlers';
import { uid } from './ids';

const B = API_BASE;
type Row = SavedView & { owner_key: string; audience_in: SavedViewAudience };
type State = { views: Row[]; drafts: Map<string, Draft & { owner: string; payload: Record<string, unknown> }> };
const states = new WeakMap<Db, State>();
const omit = <T extends object>(o: T, ...keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
const S = (): State => {
  const d = db();
  let s = states.get(d);
  if (!s) { s = { views: [], drafts: new Map() }; states.set(d, s); }
  return s;
};
const me = () => viewer()!;
const shareScope = (): 'none' | 'limited' | 'all' => (['pm', 'reviewer'].includes(me().key) ? 'all' : 'none');
const isManager = () => me().key === 'pm';
const nonEmpty = (a?: SavedViewAudience) => !!a && (!!a.everyone || !!a.role_ids?.length || !!a.group_ids?.length || !!a.user_ids?.length || !!a.region_ids?.length);
const REGION_NAMES = ['Tripoli', 'Middle', 'WM', 'Zawia', 'Benghazi', 'GM', 'Sebha'];
const myId = () => uid(me().employee_id ?? '9999');
const now = () => new Date().toISOString();
const invalid = (path: string, code = 'invalid') => problem(422, 'validation_failed', 'Validation failed', { errors: [{ path, code, message: code }] });

/** Shared views reach everyone in the mock when `everyone` is set, the accounts named by id, or (0.15.31) any account when a region is named (mock viewers see every region). */
const addressed = (v: Row) => v.audience_in.everyone || (v.audience_in.user_ids ?? []).includes(myId()) || !!v.audience_in.region_ids?.length;
const canRead = (v: Row) => v.owner_key === me().key || (v.is_active && v.shared && addressed(v));
const out = (v: Row): SavedView => {
  const mine = v.owner_key === me().key, mgr = v.shared && isManager();
  const a = v.audience_in, rest = omit(v, 'owner_key', 'audience_in') as unknown as SavedView;
  return {
    ...rest, is_owner: mine, can_edit: mine || mgr, can_share: (mine && shareScope() !== 'none') || mgr,
    audience: mine || mgr ? { everyone: !!a.everyone, roles: [], groups: [], users: (a.user_ids ?? []).map((id) => ({ id, display_name: id })),
      regions: (a.region_ids ?? []).map((id) => ({ id, name_en: REGION_NAMES[id - 1] ?? String(id), name_ar: null })) } : null,
  };
};
function versionOk(req: Request, v: Row) {
  const h = req.headers.get('If-Match');
  if (!h) return problem(428, 'precondition_required', 'If-Match is required');
  return h.trim() === '*' || Number(h.replace(/"/g, '')) === v.version ? null : problem(412, 'precondition_failed', 'The view changed; reload and retry');
}
const find = (id: string) => S().views.find((v) => v.id === id && canRead(v));
const dupe = (owner: string, screen: string, name: string, not?: string) => S().views.some((x) => x.owner_key === owner && x.screen_key === screen && x.is_active && x.id !== not && x.name.toLowerCase() === name.toLowerCase());

function make(screen: string, b: { name: string; filters?: Record<string, unknown>; columns?: SavedView['columns']; sort?: SavedView['sort']; audience?: SavedViewAudience }, imported = false): Row {
  const v = me();
  return {
    id: crypto.randomUUID(), screen_key: screen, name: b.name.trim(), filters: b.filters ?? {}, columns: b.columns ?? {}, sort: b.sort ?? [], stripped_columns: 0,
    owner: { id: myId(), display_name: v.name, employee_id: v.employee_id ?? null }, owner_left: false, is_owner: true, shared: nonEmpty(b.audience),
    audience: null, can_edit: true, can_share: shareScope() !== 'none', is_active: true, version: 1, imported, created_at: now(), updated_at: now(),
    owner_key: v.key, audience_in: b.audience ?? {},
  };
}

// 0.15.31 (F3): the whitelist of the filter builder. The real server builds it from the configuration and leaves hidden fields out.
type FF = { key: string; label_en: string; label_ar: string; type: 'text' | 'enum' | 'number' | 'date' | 'bool'; options?: { value: string; label_en: string; label_ar?: string | null }[]; group?: string; truncated?: boolean };
const OPS = {
  text: ['is', 'is_not', 'in', 'not_in', 'contains', 'not_contains', 'empty', 'not_empty'],
  enum: ['is', 'is_not', 'in', 'not_in', 'empty', 'not_empty'],
  number: ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'between', 'empty', 'not_empty'],
  date: ['is', 'before', 'after', 'between', 'in_last_days', 'in_next_days', 'empty', 'not_empty'],
  bool: ['is', 'empty', 'not_empty'],
} as const;
const REGION_OPTS = REGION_NAMES.map((n, i) => ({ value: String(i + 1), label_en: n }));
const en = (v: string[]) => v.map((x) => ({ value: x, label_en: x.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) }));
const SITE_FIELDS: FF[] = [
  { key: 'site_code', label_en: 'Site ID', label_ar: 'رمز الموقع', type: 'text' },
  { key: 'name', label_en: 'Site name', label_ar: 'اسم الموقع', type: 'text' },
  { key: 'region_id', label_en: 'Region', label_ar: 'المنطقة', type: 'enum', options: REGION_OPTS },
  { key: 'delivery_scenario', label_en: 'Delivery scenario', label_ar: 'سيناريو التسليم', type: 'enum', options: en(['new_build', 'expansion', 'hot_swap', 'cold_swap', 'relocation']) },
  { key: 'overall_status', label_en: 'Overall status', label_ar: 'الحالة العامة', type: 'enum', options: en(['not_started', 'in_progress', 'on_hold', 'completed', 'cancelled']) },
  { key: 'tower_height_m', label_en: 'Tower height (m)', label_ar: 'ارتفاع البرج (م)', type: 'number' },
  { key: 'rf_survey_date', label_en: 'RF survey date', label_ar: 'تاريخ المسح الراديوي', type: 'date' },
  { key: 'workflow_locks', label_en: 'Workflow locks on', label_ar: 'أقفال التسلسل مفعّلة', type: 'bool' },
  // 0.15.45: a Master column with its real distinct values
  { key: 'delivery_batch', label_en: 'Delivery batch', label_ar: 'دفعة التسليم', type: 'enum', options: ['B1', 'B2', 'B3', 'B4'].map((x) => ({ value: x, label_en: x })) },
];
/** 0.15.45: the groups the server sends (Site, Status and stage, Dates, Menu columns / Register fields). */
const GROUP_OF: Record<string, string> = { site_code: 'site', name: 'site', region_id: 'site', delivery_scenario: 'site', overall_status: 'status', state: 'status', stage_code: 'status', rf_survey_date: 'dates', created_at: 'dates', due_date: 'dates', tower_height_m: 'columns', delivery_batch: 'columns', workflow_locks: 'columns', task_code: 'fields' };
const GROUPS: Record<string, { key: string; label_en: string; label_ar: string }> = {
  site: { key: 'site', label_en: 'Site', label_ar: 'الموقع' }, status: { key: 'status', label_en: 'Status and stage', label_ar: 'الحالة والمرحلة' },
  dates: { key: 'dates', label_en: 'Dates', label_ar: 'التواريخ' }, columns: { key: 'columns', label_en: 'Menu columns', label_ar: 'أعمدة القائمة' },
  fields: { key: 'fields', label_en: 'Register fields', label_ar: 'حقول السجل' },
};
const withGroup = (items: FF[], fallback: string) => items.map((f) => ({ ...f, group: GROUPS[f.group ?? GROUP_OF[f.key] ?? fallback] }));
/** A site360 menu and the dashboard filter the sites tree; the menu adds its own Master columns. */
const MENU_FIELDS: FF[] = [
  { key: 'c:project_phase', label_en: 'Project Phase', label_ar: 'مرحلة المشروع', type: 'enum', options: ['Phase 1', 'Phase 2'].map((x) => ({ value: x, label_en: x })), group: 'columns' },
  { key: 'c:cw_delivery_model', label_en: 'CW Delivery Model', label_ar: 'نموذج تسليم الأعمال المدنية', type: 'enum', options: ['outsourced', 'internal'].map((x) => ({ value: x, label_en: x })), group: 'columns' },
  { key: 'c:te_access_date', label_en: 'TE Access Date', label_ar: 'تاريخ إتاحة التركيبات', type: 'date', group: 'dates' },
];
const REGISTER_FIELDS: FF[] = [
  { key: 'site_code', label_en: 'Site ID', label_ar: 'رمز الموقع', type: 'text' },
  { key: 'region_id', label_en: 'Region', label_ar: 'المنطقة', type: 'enum', options: REGION_OPTS },
  { key: 'state', label_en: 'State', label_ar: 'الحالة', type: 'enum', options: en(['entry', 'in_review', 'in_approval', 'approved', 'voided']) },
  { key: 'created_at', label_en: 'Created on', label_ar: 'تاريخ الإنشاء', type: 'date' },
];

/** F5 (0.15.32): the tasks board keeps the whitelist of site-tasks. */
const TASK_FIELDS: FF[] = [
  { key: 'site_code', label_en: 'Site ID', label_ar: 'رمز الموقع', type: 'text' },
  { key: 'task_code', label_en: 'Task code', label_ar: 'رمز المهمة', type: 'text' },
  { key: 'stage_code', label_en: 'Milestone stage', label_ar: 'المرحلة', type: 'text' },
  { key: 'state', label_en: 'State', label_ar: 'الحالة', type: 'enum', options: en(['open', 'entry', 'in_review', 'in_approval', 'approved', 'rejected']) },
  { key: 'region_id', label_en: 'Region', label_ar: 'المنطقة', type: 'enum', options: REGION_OPTS },
  { key: 'due_date', label_en: 'Due date', label_ar: 'تاريخ الاستحقاق', type: 'date' },
];

/** W5 (0.15.70): the Archive list of Library > Archive (the builtin fields of the screen library-archive). */
const ARCHIVE_FIELDS: FF[] = [
  { key: 'site_code', label_en: 'Site ID', label_ar: 'رمز الموقع', type: 'text' },
  { key: 'region_id', label_en: 'Region', label_ar: 'المنطقة', type: 'enum', options: REGION_OPTS },
  { key: 'status', label_en: 'Status', label_ar: 'الحالة', type: 'enum', options: en(['due', 'generated', 'signed_uploaded', 'in_review', 'approved', 'rejected', 'superseded']) },
  { key: 'doc_number', label_en: 'Document number', label_ar: 'رقم المستند', type: 'text' },
  { key: 'task_code', label_en: 'Task code', label_ar: 'رمز المهمة', type: 'text' },
  { key: 'uploaded_at', label_en: 'Upload date', label_ar: 'تاريخ الرفع', type: 'date' },
];

/** Pilot admin lists (users, assignments): the builtin fields of the screens `users` and `assignments`. */
const USER_FIELDS: FF[] = [
  { key: 'display_name', label_en: 'Name', label_ar: 'الاسم', type: 'text' },
  { key: 'email', label_en: 'Email', label_ar: 'البريد', type: 'text' },
  { key: 'status', label_en: 'Status', label_ar: 'الحالة', type: 'enum', options: en(['pending_assignment', 'active', 'suspended', 'disabled']) },
  { key: 'roles', label_en: 'Current roles', label_ar: 'الأدوار الحالية', type: 'text' },
];
const ASSIGNMENT_FIELDS: FF[] = [
  { key: 'person', label_en: 'Person', label_ar: 'الشخص', type: 'text' },
  { key: 'role_name', label_en: 'Role', label_ar: 'الدور', type: 'text' },
  { key: 'permission_level', label_en: 'Level', label_ar: 'المستوى', type: 'enum', options: en(['view', 'entry', 'review', 'approve', 'admin']) },
  { key: 'active_now', label_en: 'Active now', label_ar: 'ساري الآن', type: 'bool' },
];

const AUDIT_FILTER_FIELDS: FF[] = [
  { key: 'at', label_en: 'Date', label_ar: 'التاريخ', type: 'date' },
  { key: 'action', label_en: 'Action', label_ar: 'الإجراء', type: 'text' },
  { key: 'entity_type', label_en: 'Entity type', label_ar: 'نوع الكيان', type: 'text' },
  { key: 'is_admin_override', label_en: 'Admin override', label_ar: 'تجاوز إداري', type: 'bool' },
];
const SECURITY_FILTER_FIELDS: FF[] = [
  { key: 'at', label_en: 'Date', label_ar: 'التاريخ', type: 'date' },
  { key: 'event', label_en: 'Event', label_ar: 'الحدث', type: 'text' },
  { key: 'outcome', label_en: 'Outcome', label_ar: 'النتيجة', type: 'text' },
];

const fieldsOf = (screen: string) => screen === 'audit-log' ? withGroup(AUDIT_FILTER_FIELDS, 'fields') : screen === 'security-log' ? withGroup(SECURITY_FILTER_FIELDS, 'fields') : screen === 'users' ? withGroup(USER_FIELDS, 'fields') : screen === 'assignments' ? withGroup(ASSIGNMENT_FIELDS, 'fields') : screen === 'library-archive' ? withGroup(ARCHIVE_FIELDS, 'fields') : screen === 'sites' || screen === 'sites-stream' ? withGroup(SITE_FIELDS, 'columns')
  : screen === 'dashboard' ? withGroup(SITE_FIELDS.filter((f) => f.key !== 'workflow_locks'), 'columns')
  : /^site360-[a-z0-9_]+$/.test(screen) ? withGroup([...SITE_FIELDS, ...MENU_FIELDS], 'columns')
  : screen === 'site-tasks' || screen === 'tasks-board' ? withGroup(TASK_FIELDS, 'fields') : /^register-/.test(screen) ? withGroup(REGISTER_FIELDS, 'fields') : null;

export const viewsHandlers = [
  // 0.15.49: the values of an enum field that match q (anywhere in the value or a label), at most `limit`, `truncated` when there are more
  http.get(`${B}/saved-views/filter-fields/:field/values`, ({ request, params }) => {
    const g = guard(); if (g) return g;
    const u = new URL(request.url), screen = u.searchParams.get('screen_key') ?? '', needle = (u.searchParams.get('q') ?? '').trim().toLowerCase();
    const limit = Number(u.searchParams.get('limit') ?? 50);
    const items = fieldsOf(screen);
    if (!items) return invalid('/screen_key');
    const key = decodeURIComponent(String(params.field));
    const f = items.find((x) => x.key === key);
    if (!f) return invalid('/field', 'unknown_field');
    if (f.type !== 'enum') return invalid('/field', 'not_enum');
    const hit = (f.options ?? []).filter((o) => !needle || o.value.toLowerCase().includes(needle) || o.label_en.toLowerCase().includes(needle) || (o.label_ar ?? '').toLowerCase().includes(needle));
    return HttpResponse.json({ screen_key: screen, field: key, q: needle, items: hit.slice(0, limit), truncated: hit.length > limit });
  }),
  http.get(`${B}/saved-views/filter-fields`, ({ request }) => {
    const g = guard(); if (g) return g;
    const screen = new URL(request.url).searchParams.get('screen_key') ?? '';
    const items = fieldsOf(screen);
    if (!items) return invalid('/screen_key');
    return HttpResponse.json({
      screen_key: screen, items: items.map((f) => ({ ...f, operators: OPS[f.type] })), operators: OPS,
      limits: { max_depth: 2, max_items_per_group: 20, max_groups: 10, max_conditions: 50, max_values: 100 },
    });
  }),
  http.get(`${B}/saved-views`, ({ request }) => {
    const g = guard(); if (g) return g;
    const q = new URL(request.url).searchParams, screen = q.get('screen_key'), inactive = q.get('include_inactive') === 'true';
    const items = S().views.filter((v) => (!screen || v.screen_key === screen) && canRead(v) && (v.is_active || (inactive && v.owner_key === me().key)))
      .sort((a, b) => Number(b.owner_key === me().key) - Number(a.owner_key === me().key) || (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));
    return HttpResponse.json({ items: items.map(out), can_share: shareScope(), can_manage: isManager() });
  }),
  http.post(`${B}/saved-views/import`, async ({ request }) => {
    const g = guard(); if (g) return g;
    const b = await request.json() as { screen_key: string; items: { local_id: string; name: string; filters?: Record<string, unknown> }[] };
    const done: SavedView[] = [];
    let skipped = 0;
    for (const it of b.items ?? []) {
      const ref = `${b.screen_key}:${it.local_id}`;
      if (S().views.some((x) => x.owner_key === me().key && (x as Row & { ref?: string }).ref === ref)) { skipped++; continue; }
      let name = it.name, n = 1;
      while (dupe(me().key, b.screen_key, name)) { n++; name = `${it.name} (${n})`; }
      const r = Object.assign(make(b.screen_key, { name, filters: it.filters }, true), { ref });
      S().views.push(r);
      done.push(out(r));
    }
    return HttpResponse.json({ imported: done.length, skipped, items: done });
  }),
  http.post(`${B}/saved-views`, async ({ request }) => {
    const g = guard(); if (g) return g;
    const b = await request.json() as { screen_key: string; name: string; audience?: SavedViewAudience };
    if (!b.name?.trim()) return invalid('/name');
    if (nonEmpty(b.audience) && shareScope() === 'none') return problem(403, 'action_forbidden', 'Sharing a view needs views.share');
    if (dupe(me().key, b.screen_key, b.name)) return problem(409, 'duplicate', 'You already have a view with this name');
    const r = make(b.screen_key, b);
    S().views.push(r);
    return HttpResponse.json(out(r), { status: 201, headers: { ETag: `"${r.version}"` } });
  }),
  http.get(`${B}/saved-views/:id`, ({ params }) => {
    const g = guard(); if (g) return g;
    const v = find(String(params.id));
    return v ? HttpResponse.json(out(v), { headers: { ETag: `"${v.version}"` } }) : problem(404, 'not_found', 'Not found');
  }),
  http.patch(`${B}/saved-views/:id`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const v = find(String(params.id));
    if (!v) return problem(404, 'not_found', 'Not found');
    if (!out(v).can_edit) return problem(403, 'action_forbidden', 'Only the owner changes this view');
    const bad = versionOk(request, v); if (bad) return bad;
    if (!v.is_active) return problem(409, 'invalid_transition', 'Restore the view first');
    const b = await request.json() as Partial<Row> & { audience?: SavedViewAudience; reason?: string };
    if (v.owner_key !== me().key && (b.reason ?? '').trim().length < 3) return invalid('/reason', 'required');
    if (b.audience && nonEmpty(b.audience) && shareScope() === 'none' && !isManager()) return problem(403, 'action_forbidden', 'Sharing a view needs views.share');
    if (b.name && dupe(v.owner_key, v.screen_key, b.name, v.id)) return problem(409, 'duplicate', 'Name in use');
    Object.assign(v, { ...(b.name ? { name: b.name.trim() } : {}), ...(b.filters ? { filters: b.filters } : {}), ...(b.columns ? { columns: b.columns } : {}), ...(b.sort ? { sort: b.sort } : {}) });
    if (b.audience) { v.audience_in = b.audience; v.shared = nonEmpty(b.audience); }
    v.version += 1; v.updated_at = now();
    return HttpResponse.json(out(v), { headers: { ETag: `"${v.version}"` } });
  }),
  ...(['deactivate', 'restore'] as const).map((op) => http.post(`${B}/saved-views/:id/${op}`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const v = S().views.find((x) => x.id === String(params.id) && (x.owner_key === me().key || (x.shared && isManager())));
    if (!v) return problem(404, 'not_found', 'Not found');
    const bad = versionOk(request, v); if (bad) return bad;
    if (v.is_active === (op === 'restore')) return problem(409, 'invalid_transition', 'Nothing to change');
    v.is_active = op === 'restore'; v.version += 1; v.updated_at = now();
    return HttpResponse.json(out(v), { headers: { ETag: `"${v.version}"` } });
  })),
  http.post(`${B}/saved-views/:id/transfer`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const v = find(String(params.id));
    if (!v) return problem(404, 'not_found', 'Not found');
    if (!out(v).can_edit) return problem(403, 'action_forbidden', 'Not allowed');
    const bad = versionOk(request, v); if (bad) return bad;
    if (!v.shared) return problem(409, 'invalid_transition', 'A private view is not handed over');
    const b = await request.json() as { owner_id: string; reason: string };
    if ((b.reason ?? '').trim().length < 3) return invalid('/reason', 'required');
    v.owner = { id: b.owner_id, display_name: b.owner_id }; v.owner_key = `id:${b.owner_id}`; v.owner_left = false; v.version += 1;
    return HttpResponse.json(out(v), { headers: { ETag: `"${v.version}"` } });
  }),
  http.get(`${B}/saved-views/:id/versions`, ({ params }) => {
    const g = guard(); if (g) return g;
    const v = S().views.find((x) => x.id === String(params.id) && x.owner_key === me().key);
    return v ? HttpResponse.json({ items: [{ version: v.version, change: v.version === 1 ? 'create' : 'edit', snapshot: { name: v.name }, reason: null, changed_by: v.owner, changed_at: v.updated_at }] }) : problem(404, 'not_found', 'Not found');
  }),

  // ---- drafts (Q115): the caller's own; never a submission
  http.get(`${B}/me/drafts`, () => {
    const g = guard(); if (g) return g;
    const items = [...S().drafts.values()].filter((d) => d.owner === me().key).map((d) => omit(d, 'owner', 'payload'));
    return HttpResponse.json({ items, retention_days: 30 });
  }),
  http.get(`${B}/me/drafts/:key`, ({ params }) => {
    const g = guard(); if (g) return g;
    const d = S().drafts.get(`${me().key}|${String(params.key)}`);
    if (!d) return problem(404, 'not_found', 'There is no draft');
    return HttpResponse.json(omit(d, 'owner'));
  }),
  http.put(`${B}/me/drafts/:key`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const key = String(params.key);
    if (!/^(task|record|form)\.[A-Za-z0-9_.-]{1,200}$/.test(key)) return invalid('/draft_key');
    const b = await request.json() as { payload: Record<string, unknown>; base_version?: number | null };
    const k = `${me().key}|${key}`, cur = S().drafts.get(k);
    if (cur && b.base_version != null && b.base_version !== cur.version) return problem(412, 'precondition_failed', 'This draft was saved from another window');
    const t = now();
    const d = { key, version: (cur?.version ?? 0) + 1, saved_at: t, created_at: cur?.created_at ?? t, expires_at: new Date(Date.now() + 30 * 864e5).toISOString(), owner: me().key, payload: b.payload };
    S().drafts.set(k, d);
    return HttpResponse.json(omit(d, 'owner', 'payload'));
  }),
  http.delete(`${B}/me/drafts/:key`, ({ params }) => {
    const g = guard(); if (g) return g;
    S().drafts.delete(`${me().key}|${String(params.key)}`);
    return new HttpResponse(null, { status: 204 });
  }),
];
