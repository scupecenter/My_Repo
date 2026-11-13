import { http, HttpResponse } from 'msw';
import { API_BASE as B } from '@/api/client';
import { stepUpValid, viewer } from './db';
import { guard, problem, stepUp } from './handlers';

/**
 * Decision 4 of 2026-11-12 (migration 0090): the workflow editor. A small in-memory definition (two milestones, one gate, five tasks): version 1 published,
 * at most one draft. Only the System Admin (account `pm`) edits, with a reason and a step-up; every write checks If-Match like the server.
 */
interface Task { task_code: string; stage_code: string; sort_order: number; name_en: string; name_ar: string | null; is_active: boolean; counts_toward_milestone: boolean; is_milestone_task: boolean; has_documents: boolean; task_version: number; predecessors: string[] }
interface Ver { version: number; status: 'draft' | 'published'; etag: number; reason: string | null; parent: number | null; milestones: { code: string; seq: number; name_en: string; name_ar: string | null; is_active: boolean; formula_kind: 'master'; counts_in_project_status: boolean }[]; gates: { code: string; from_milestone: string; to_milestone: string; name_en: string; name_ar: string | null; conditions: unknown[]; sla_min_wd: number | null; sla_max_wd: number | null }[]; tasks: Task[] }

const t = (code: string, stage: string, n: number, en: string, ar: string, preds: string[] = []): Task => ({ task_code: code, stage_code: stage, sort_order: n * 10, name_en: en, name_ar: ar, is_active: true, counts_toward_milestone: true, is_milestone_task: false, has_documents: true, task_version: 1, predecessors: preds });
const seed = (): Ver[] => [{
  version: 1, status: 'published', etag: 1, reason: 'Seed', parent: null,
  milestones: [{ code: 'MS1', seq: 1, name_en: 'Site Release', name_ar: 'إصدار الموقع', is_active: true, formula_kind: 'master', counts_in_project_status: true }, { code: 'MS2', seq: 2, name_en: 'PRE-CW Completion', name_ar: 'اكتمال ما قبل الأعمال المدنية', is_active: true, formula_kind: 'master', counts_in_project_status: true }],
  gates: [{ code: 'G1', from_milestone: 'MS1', to_milestone: 'MS2', name_en: 'Release to PRE-CW', name_ar: null, conditions: [], sla_min_wd: 1, sla_max_wd: 3 }],
  tasks: [t('A1', 'MS1', 1, 'SAR', 'تقرير المسح'), t('A2', 'MS1', 2, 'TSSR', 'تقرير TSSR', ['A1']), t('A4', 'MS1', 3, 'LLD', 'التصميم المنخفض المستوى', ['A2']), t('B1', 'MS2', 1, 'PR email', 'بريد طلب الشراء'), t('B2', 'MS2', 2, 'PO email', 'بريد أمر الشراء', ['B1'])],
}];
let state = seed();
interface Mig { id: string; site_id: string; site_code: string; from_version: number; to_version: number; reason: string; migrated_at: string; reverted_at: string | null; revertible: boolean }
let migrations: Mig[] = [];
export const resetWorkflowEditorMock = () => { state = seed(); migrations = []; };
/** Until someone drafts a version, the reads fall through to the settings mock that the matrix and the rules screens already use. */
const untouched = () => state.length === 1 && state[0]!.etag === 1;

const canEdit = () => viewer()?.key === 'pm';
const json = (v: Ver) => ({
  version: v.version, status: v.status, is_current: v.status === 'published' && v.version === Math.max(...state.filter((x) => x.status === 'published').map((x) => x.version)), light_revision: 0, parent_version: v.parent,
  site_count: v.version === 1 ? 12 : 0, reason: v.reason, published_at: null, version_etag: v.etag, can_edit: canEdit(), can_publish: canEdit(),
  milestones: v.milestones, gates: v.gates, placements: [...v.tasks].sort((a, b) => a.stage_code.localeCompare(b.stage_code) || a.sort_order - b.sort_order),
  validation: { valid: true, problems: [], warnings: [], master_impact: { affected_columns: [], parallel_run_active: false, confirmation_phrase: null } },
});
const reply = (v: Ver, status = 200) => HttpResponse.json(json(v), { status, headers: { ETag: `"${v.etag}"` } });
const fieldErr = (path: string, code: string) => problem(422, 'validation_failed', 'Validation failed', { errors: [{ path, code }] });
const reasonOk = (b: { reason?: unknown }) => typeof b.reason === 'string' && b.reason.trim().length >= 3;

/** The shared gate of every write: admin, reason, version found, ETag, step-up, in that order. */
function write(params: Record<string, string | readonly string[] | undefined>, request: Request, body: { reason?: unknown }): { v: Ver } | { r: Response } {
  const g = guard(); if (g) return { r: g };
  if (!canEdit()) return { r: problem(403, 'action_forbidden', 'You need edit on workflow versions.') };
  const v = state.find((x) => x.version === Number(params.version));
  if (!v) return { r: problem(404, 'not_found', 'The workflow version does not exist.') };
  if (!reasonOk(body)) return { r: fieldErr('/reason', 'required') };
  const m = request.headers.get('If-Match');
  if (!m) return { r: problem(428, 'precondition_required', 'If-Match is required') };
  if (m.replace(/"/g, '') !== String(v.etag)) return { r: problem(412, 'precondition_failed', 'The workflow version changed since you read it. Reload and try again.') };
  if (!stepUpValid()) return { r: stepUp() };
  return { v };
}
const reaches = (v: Ver, from: string, target: string, seen = new Set<string>()): boolean => {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return (v.tasks.find((x) => x.task_code === from)?.predecessors ?? []).some((p) => reaches(v, p, target, seen));
};

interface InsertBody { stage_code?: string; predecessors?: string[]; successors?: string[]; remove_direct_links?: boolean; counts_toward_milestone?: boolean }
/** The preview of an insert: the rewiring of each successor and the cycle check (a chosen successor that already comes before a chosen predecessor). */
const plan = (v: Ver, b: InsertBody) => {
  const preds = [...new Set(b.predecessors ?? [])];
  const succs = [...new Set(b.successors ?? [])];
  const errors: { path: string; code: string; message: string }[] = [];
  if (preds.some((c) => !v.tasks.some((x) => x.task_code === c))) errors.push({ path: '/predecessors', code: 'unknown', message: 'unknown predecessor' });
  if (succs.some((c) => !v.tasks.some((x) => x.task_code === c))) errors.push({ path: '/successors', code: 'unknown', message: 'unknown successor' });
  if (errors.length === 0 && succs.some((s) => preds.some((p) => reaches(v, p, s)))) errors.push({ path: '/successors', code: 'cycle', message: 'cycle' });
  const rewiring = errors.length ? [] : succs.map((s) => {
    const x = v.tasks.find((k) => k.task_code === s)!;
    const removed = b.remove_direct_links ? x.predecessors.filter((c) => preds.includes(c)) : [];
    return { successor: s, name_en: x.name_en, name_ar: x.name_ar, stage_code: x.stage_code, predecessors_before: x.predecessors, removed_links: removed, predecessors_after: x.predecessors.filter((c) => !removed.includes(c)) };
  });
  const published = v.status === 'published';
  return { valid: errors.length === 0, errors, predecessors: preds, successors: succs, rewiring, removed_link_count: rewiring.reduce((a, r) => a + r.removed_links.length, 0),
    warnings: published && (b.counts_toward_milestone ?? true) ? ['counting_task_may_move_milestone'] : [], version_status: v.status, open_sites: published ? 12 : 0, master_confirmation_needed: false, confirmation_phrase: null };
};

export const workflowEditorHandlers = [
  http.get(`${B}/workflow/versions`, () => {
    if (untouched()) return undefined;
    const g = guard(); if (g) return g;
    const cur = Math.max(...state.filter((x) => x.status === 'published').map((x) => x.version));
    return HttpResponse.json({ items: [...state].sort((a, b) => b.version - a.version).map((v) => ({ version: v.version, status: v.status, is_current: v.version === cur && v.status === 'published', light_revision: 0, parent_version: v.parent, site_count: v.version === 1 ? 12 : 0, reason: v.reason, version_etag: v.etag })) });
  }),
  http.post(`${B}/workflow/versions`, async ({ request }) => {
    const g = guard(); if (g) return g;
    if (!canEdit()) return problem(403, 'action_forbidden', 'You need create on workflow versions.');
    const b = (await request.json()) as { parent_version?: number; reason?: string };
    if (!reasonOk(b)) return fieldErr('/reason', 'required');
    if (!stepUpValid()) return stepUp();
    if (state.some((x) => x.status === 'draft')) return problem(409, 'duplicate', 'A draft exists already.');
    const p = state.find((x) => x.version === b.parent_version && x.status === 'published');
    if (!p) return problem(404, 'not_found', 'The parent version does not exist.');
    const v: Ver = { ...structuredClone(p), version: Math.max(...state.map((x) => x.version)) + 1, status: 'draft', etag: 1, reason: b.reason ?? null, parent: p.version };
    state.push(v);
    return reply(v, 201);
  }),
  http.get(`${B}/workflow/versions/:version`, ({ params }) => {
    if (untouched() && params.version === '1') return undefined;
    const g = guard(); if (g) return g;
    const v = state.find((x) => x.version === Number(params.version));
    return v ? reply(v) : problem(404, 'not_found', 'The workflow version does not exist.');
  }),
  http.put(`${B}/workflow/versions/:version`, async ({ params, request }) => {
    const b = (await request.json()) as { milestones?: { code: string; name_en?: string; name_ar?: string | null; is_active?: boolean }[]; gates?: { code: string; name_en?: string; name_ar?: string | null; from_milestone?: string; to_milestone?: string; sla_min_wd?: number; sla_max_wd?: number; conditions?: unknown[] }[]; task_moves?: { task_code: string; stage_code: string }[]; reason?: string };
    const w = write(params, request, b); if ('r' in w) return w.r;
    const v = w.v;
    if (v.status !== 'draft') return problem(409, 'invalid_transition', 'Structural changes are made in a draft version.');
    const ms = b.milestones ?? [];
    if (v.milestones.some((m) => !ms.some((x) => x.code === m.code))) return fieldErr('/milestones', 'missing');
    const next = ms.map((x, i) => {
      const old = v.milestones.find((m) => m.code === x.code);
      return { code: x.code, seq: i + 1, name_en: x.name_en ?? old?.name_en ?? x.code, name_ar: x.name_ar ?? old?.name_ar ?? null, is_active: x.is_active !== false, formula_kind: 'master' as const, counts_in_project_status: old?.counts_in_project_status ?? true };
    });
    for (const mv of b.task_moves ?? []) {
      const x = v.tasks.find((k) => k.task_code === mv.task_code);
      if (!x) return fieldErr('/task_moves', 'unknown');
      if (!next.some((m) => m.code === mv.stage_code && m.is_active)) return fieldErr('/task_moves', 'unknown_stage');
      x.stage_code = mv.stage_code;
    }
    if (v.tasks.some((x) => x.is_active && next.some((m) => m.code === x.stage_code && !m.is_active))) return fieldErr('/milestones', 'has_active_tasks');
    v.milestones = next;
    v.gates = (b.gates ?? []).map((g) => {
      const old = v.gates.find((k) => k.code === g.code);
      return { code: g.code, from_milestone: g.from_milestone ?? old?.from_milestone ?? '', to_milestone: g.to_milestone ?? old?.to_milestone ?? '', name_en: g.name_en ?? old?.name_en ?? g.code, name_ar: g.name_ar ?? old?.name_ar ?? null, conditions: g.conditions ?? old?.conditions ?? [], sla_min_wd: g.sla_min_wd ?? old?.sla_min_wd ?? 0, sla_max_wd: g.sla_max_wd ?? old?.sla_max_wd ?? 0 };
    });
    v.etag += 1;
    return reply(v);
  }),
  http.post(`${B}/workflow/versions/:version/migration-preview`, async ({ params }) => {
    const g = guard(); if (g) return g;
    if (!canEdit()) return problem(403, 'action_forbidden', 'You need administer on workflow versions.');
    const to = Number(params.version);
    const sites = migrations.some((m) => !m.reverted_at && m.to_version === to) ? [] : [{ site_id: 'site-1', site_code: 'TRP-001', from_version: 1, migratable: true, tasks_kept: ['A1', 'A2'], tasks_moved: [], tasks_added: ['MID1'], tasks_retired: [], date_changes: [] }];
    return HttpResponse.json({ preview_hash: `hash-${to}-${sites.length}`, to_version: to, master_impact: { affected_columns: [], parallel_run_active: false, confirmation_phrase: null }, sites });
  }),
  http.post(`${B}/workflow/versions/:version/migrations`, async ({ params, request }) => {
    const b = (await request.json()) as { preview_hash?: string; reason?: string };
    const g = guard(); if (g) return g;
    if (!canEdit()) return problem(403, 'action_forbidden', 'You need administer on workflow versions.');
    if (!reasonOk(b)) return fieldErr('/reason', 'required');
    if (!stepUpValid()) return stepUp();
    const to = Number(params.version);
    if (b.preview_hash !== `hash-${to}-1`) return problem(409, 'stale_preview', 'The sites or the definition changed since the preview. Preview again.');
    migrations.push({ id: `mig-${migrations.length + 1}`, site_id: 'site-1', site_code: 'TRP-001', from_version: 1, to_version: to, reason: b.reason!, migrated_at: new Date().toISOString(), reverted_at: null, revertible: true });
    return HttpResponse.json({ id: `mig-${migrations.length}`, sites_migrated: 1, to_version: to });
  }),
  http.get(`${B}/workflow/site-migrations`, () => {
    const g = guard(); if (g) return g;
    if (!canEdit()) return problem(403, 'action_forbidden', 'You need administer on workflow versions.');
    return HttpResponse.json({ items: migrations.map((m) => ({ ...m, revertible: m.revertible && !m.reverted_at })), page: { limit: 50, next_cursor: null, total: migrations.length } });
  }),
  http.post(`${B}/workflow/site-migrations/:id/revert`, async ({ params, request }) => {
    const b = (await request.json()) as { reason?: string };
    const g = guard(); if (g) return g;
    if (!canEdit()) return problem(403, 'action_forbidden', 'You need administer on workflow versions.');
    if (!reasonOk(b)) return fieldErr('/reason', 'required');
    if (!stepUpValid()) return stepUp();
    const m = migrations.find((x) => x.id === params.id);
    if (!m) return problem(404, 'not_found', 'The migration does not exist.');
    if (m.reverted_at) return problem(409, 'invalid_transition', 'This migration cannot be reverted.');
    m.reverted_at = new Date().toISOString();
    return HttpResponse.json({ id: m.id, site_id: m.site_id, site_code: m.site_code, reverted_to_version: m.from_version });
  }),
  http.post(`${B}/workflow/versions/:version/tasks/insert-preview`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    if (!canEdit()) return problem(403, 'action_forbidden', 'You need create on task definitions.');
    const v = state.find((x) => x.version === Number(params.version));
    if (!v) return problem(404, 'not_found', 'The workflow version does not exist.');
    return HttpResponse.json(plan(v, (await request.json()) as InsertBody));
  }),
  http.post(`${B}/workflow/versions/:version/tasks/insert`, async ({ params, request }) => {
    const b = (await request.json()) as InsertBody & { code?: string; name_en?: string; name_ar?: string | null; reason?: string; add_to_open_sites?: boolean };
    const w = write(params, request, b); if ('r' in w) return w.r;
    const v = w.v;
    if (!/^[A-Z][A-Z0-9_-]{0,19}$/.test(b.code ?? '')) return fieldErr('/code', 'invalid');
    if (v.tasks.some((x) => x.task_code === b.code)) return problem(409, 'duplicate', 'A task with this code exists already in the version.');
    const pl = plan(v, b);
    if (!pl.valid) return fieldErr(pl.errors[0]!.path, pl.errors[0]!.code);
    const n = Math.max(0, ...v.tasks.filter((x) => x.stage_code === b.stage_code).map((x) => x.sort_order)) + 10;
    v.tasks.push({ ...t(b.code!, b.stage_code!, 0, b.name_en ?? '', '', b.predecessors ?? []), sort_order: n, name_ar: b.name_ar ?? null, counts_toward_milestone: b.counts_toward_milestone ?? true });
    for (const r of pl.rewiring) {
      const s = v.tasks.find((x) => x.task_code === r.successor)!;
      s.predecessors = [...r.predecessors_after, b.code!].sort();
    }
    v.etag += 1;
    return HttpResponse.json({ task_code: b.code, warnings: pl.warnings, rewiring: pl.rewiring, open_sites_added: b.add_to_open_sites && v.status === 'published' ? 12 : 0, version: json(v) }, { status: 201, headers: { ETag: `"${v.etag}"` } });
  }),
  http.put(`${B}/workflow/versions/:version/tasks/:task/successors`, async ({ params, request }) => {
    const b = (await request.json()) as { successors?: string[]; reason?: string };
    const w = write(params, request, b); if ('r' in w) return w.r;
    const x = w.v.tasks.find((k) => k.task_code === params.task);
    if (!x) return problem(404, 'not_found', 'The task does not exist in this version.');
    const list = b.successors ?? [];
    if (list.includes(x.task_code)) return fieldErr('/successors', 'self');
    if (list.some((c) => !w.v.tasks.some((k) => k.task_code === c))) return fieldErr('/successors', 'unknown');
    if (list.some((c) => reaches(w.v, x.task_code, c))) return fieldErr('/successors', 'cycle');
    for (const k of w.v.tasks) {
      const has = k.predecessors.includes(x.task_code);
      if (has && !list.includes(k.task_code)) k.predecessors = k.predecessors.filter((c) => c !== x.task_code);
      if (!has && list.includes(k.task_code)) k.predecessors = [...k.predecessors, x.task_code].sort();
    }
    w.v.etag += 1;
    return reply(w.v);
  }),
  http.post(`${B}/workflow/versions/:version/tasks`, async ({ params, request }) => {
    const b = (await request.json()) as { stage_code?: string; code?: string; name_en?: string; name_ar?: string | null; counts_toward_milestone?: boolean; predecessors?: string[]; reason?: string };
    const w = write(params, request, b); if ('r' in w) return w.r;
    const v = w.v;
    if (!/^[A-Z][A-Z0-9_-]{0,19}$/.test(b.code ?? '')) return fieldErr('/code', 'invalid');
    if (!v.milestones.some((m) => m.code === b.stage_code)) return fieldErr('/stage_code', 'unknown');
    if (v.tasks.some((x) => x.task_code === b.code)) return problem(409, 'duplicate', 'A task with this code exists already in the version.');
    if ((b.predecessors ?? []).some((p) => !v.tasks.some((x) => x.task_code === p))) return fieldErr('/predecessors', 'unknown');
    const n = Math.max(0, ...v.tasks.filter((x) => x.stage_code === b.stage_code).map((x) => x.sort_order)) + 10;
    v.tasks.push({ ...t(b.code!, b.stage_code!, 0, b.name_en ?? '', '', b.predecessors ?? []), sort_order: n, name_ar: b.name_ar ?? null, counts_toward_milestone: b.counts_toward_milestone ?? true });
    v.etag += 1;
    return HttpResponse.json({ task_code: b.code, warnings: [], version: json(v) }, { status: 201, headers: { ETag: `"${v.etag}"` } });
  }),
  http.patch(`${B}/workflow/versions/:version/tasks/:task`, async ({ params, request }) => {
    const b = (await request.json()) as { name_en?: string; name_ar?: string | null; counts_toward_milestone?: boolean; is_active?: boolean; stage_code?: string; reason?: string };
    const w = write(params, request, b); if ('r' in w) return w.r;
    const x = w.v.tasks.find((k) => k.task_code === params.task);
    if (!x) return problem(404, 'not_found', 'The task does not exist in this version.');
    if (b.stage_code !== undefined && b.stage_code !== x.stage_code) {
      if (w.v.status !== 'draft') return fieldErr('/stage_code', 'structural');
      if (!w.v.milestones.some((m) => m.code === b.stage_code)) return fieldErr('/stage_code', 'unknown');
      x.stage_code = b.stage_code;
    }
    if (b.is_active === false && w.v.tasks.some((k) => k.is_active && k.predecessors.includes(x.task_code))) return fieldErr('/is_active', 'has_dependents');
    Object.assign(x, { ...(b.name_en !== undefined ? { name_en: b.name_en } : {}), ...(b.name_ar !== undefined ? { name_ar: b.name_ar } : {}), ...(b.counts_toward_milestone !== undefined ? { counts_toward_milestone: b.counts_toward_milestone } : {}), ...(b.is_active !== undefined ? { is_active: b.is_active } : {}) });
    w.v.etag += 1;
    return reply(w.v);
  }),
  http.put(`${B}/workflow/versions/:version/tasks/:task/predecessors`, async ({ params, request }) => {
    const b = (await request.json()) as { predecessors?: string[]; reason?: string };
    const w = write(params, request, b); if ('r' in w) return w.r;
    const x = w.v.tasks.find((k) => k.task_code === params.task);
    if (!x) return problem(404, 'not_found', 'The task does not exist in this version.');
    const list = b.predecessors ?? [];
    if (list.includes(x.task_code)) return fieldErr('/predecessors', 'self');
    if (list.some((p) => !w.v.tasks.some((k) => k.task_code === p))) return fieldErr('/predecessors', 'unknown');
    if (list.some((p) => reaches(w.v, p, x.task_code))) return fieldErr('/predecessors', 'cycle');
    x.predecessors = [...list].sort();
    w.v.etag += 1;
    return reply(w.v);
  }),
  http.put(`${B}/workflow/versions/:version/milestones/:code/task-order`, async ({ params, request }) => {
    const b = (await request.json()) as { task_codes?: string[]; reason?: string };
    const w = write(params, request, b); if ('r' in w) return w.r;
    const rows = w.v.tasks.filter((k) => k.stage_code === params.code);
    const codes = b.task_codes ?? [];
    if (codes.length !== rows.length || rows.some((k) => !codes.includes(k.task_code))) return fieldErr('/task_codes', 'mismatch');
    codes.forEach((c, i) => { w.v.tasks.find((k) => k.task_code === c)!.sort_order = (i + 1) * 10; });
    w.v.etag += 1;
    return reply(w.v);
  }),
  http.patch(`${B}/workflow/versions/:version/milestones/:code`, async ({ params, request }) => {
    const b = (await request.json()) as { name_en?: string; name_ar?: string; reason?: string };
    const w = write(params, request, b); if ('r' in w) return w.r;
    const m = w.v.milestones.find((k) => k.code === params.code);
    if (!m) return problem(404, 'not_found', 'The milestone does not exist in this version.');
    if (b.name_en !== undefined) m.name_en = b.name_en;
    if (b.name_ar !== undefined) m.name_ar = b.name_ar || null;
    w.v.etag += 1;
    return HttpResponse.json(m, { headers: { ETag: `"${w.v.etag}"` } });
  }),
  http.patch(`${B}/workflow/versions/:version/gates/:code`, async ({ params, request }) => {
    const b = (await request.json()) as { name_en?: string; name_ar?: string; sla_min_wd?: number; sla_max_wd?: number; reason?: string };
    const w = write(params, request, b); if ('r' in w) return w.r;
    const g = w.v.gates.find((k) => k.code === params.code);
    if (!g) return problem(404, 'not_found', 'The gate does not exist in this version.');
    if (b.name_en !== undefined) g.name_en = b.name_en;
    if (b.name_ar !== undefined) g.name_ar = b.name_ar || null;
    if (b.sla_min_wd !== undefined) g.sla_min_wd = b.sla_min_wd;
    if (b.sla_max_wd !== undefined) g.sla_max_wd = b.sla_max_wd;
    w.v.etag += 1;
    return HttpResponse.json(g, { headers: { ETag: `"${w.v.etag}"` } });
  }),
  http.post(`${B}/workflow/versions/:version/publish`, async ({ params, request }) => {
    const b = (await request.json()) as { confirm_text?: string; reason?: string };
    const g = guard(); if (g) return g;
    if (!canEdit()) return problem(403, 'action_forbidden', 'You need administer on workflow versions.');
    if (b.confirm_text !== `v${String(params.version)}`) return problem(422, 'confirmation_mismatch', 'The typed confirmation does not match', { errors: [{ path: '/confirm_text', code: 'confirmation_mismatch' }] });
    const w = write(params, request, b); if ('r' in w) return w.r;
    if (w.v.status !== 'draft') return problem(409, 'invalid_transition', 'Only a draft can be published.');
    w.v.status = 'published'; w.v.etag += 1;
    return reply(w.v);
  }),
  http.get(`${B}/settings/task-definitions`, ({ request }) => {
    if (untouched()) return undefined;
    const g = guard(); if (g) return g;
    const n = new URL(request.url).searchParams.get('workflow_version');
    const v = n ? state.find((x) => x.version === Number(n)) : [...state].filter((x) => x.status === 'published').sort((a, b) => b.version - a.version)[0];
    if (!v) return problem(404, 'not_found', 'The workflow version does not exist.');
    return HttpResponse.json({ items: v.tasks.map((x) => ({ id: `td-${x.task_code}`, code: x.task_code, name_en: x.name_en, name_ar: x.name_ar, stage_code: x.stage_code, sort_order: x.sort_order, predecessors: x.predecessors, counts_toward_milestone: x.counts_toward_milestone, is_active: x.is_active, version: 1 })) });
  }),
];
