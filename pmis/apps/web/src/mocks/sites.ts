import type { DocumentSlot, PipelineNode, SiteDetail, SiteListItem, SiteTasks, StreamStatus } from '@/api/types';
import type { View } from '@/api/types';
import { db, toSummary, viewer, type MockTask } from './db';
import { STAGE_CODES } from './matrixData';

export const TODAY = '2026-10-25';
export const SITE_COUNT = 150;
const REG = ['TR', 'MI', 'WM', 'ZW', 'BG', 'GM', 'SB'];
const NAMES = ['Souq Al Juma', 'Ain Zara', 'Tajoura', 'Janzour', 'Gargaresh', 'Hay Al Andalus', 'Abu Salim', 'Fashloum', 'Misurata Port', 'Zliten', 'Khoms', 'Gharyan', 'Yefren', 'Nalut', 'Zawia Center', 'Sabratha', 'Derna Road', 'Marj', 'Brak', 'Ubari'];
const SCEN = ['new_build', 'expansion', 'hot_swap', 'cold_swap', 'relocation'] as const;
const STAGE_AR = ['إطلاق الموقع', 'ما قبل الأعمال المدنية', 'الأعمال المدنية', 'جاهزية الموقع', 'تركيب TE', 'البث', 'استلام مبدئي TE', 'قبول مؤشرات الأداء', 'التسليم والتسلّم', 'الإغلاق النهائي'];
const STAGE_EN = ['Site Release', 'PRE-CW', 'CW', 'Site RFI', 'TE Installation', 'On-Air', 'TE PAC', 'KPI Acceptance', 'HOTO', 'Final Closure'];

// stage, code, EN, AR, sla [min,max] | null, document | null, template | null  (design/prototype-v2/data.js STEPS)
const DEFS: [number, string, string, string, [number, number] | null, string | null, string | null][] = [
  [0, 'A1', 'Site search · first SAR', 'البحث عن الموقع · SAR الأول', [10, 20], 'SAR', 'TPL-ACQ'], [0, 'A2', 'TSSR approval', 'اعتماد TSSR', [1, 2], 'TSSR', 'TPL-RF'],
  [0, 'A3', 'Site acquisition · contract signed', 'استحواذ الموقع · توقيع العقد', null, 'Contract', 'TPL-ACQ'], [0, 'A4', 'LLD approval', 'اعتماد LLD', null, 'LLD', 'TPL-RF'],
  [1, 'B1', 'PR', 'طلب الشراء', null, 'PR Email', 'TPL-PO'], [1, 'B2', 'PO / WO and contractor', 'أمر الشراء والمقاول', [1, 2], 'PO / WO Email', 'TPL-PO'],
  [1, 'B3', 'CW access permission', 'تصريح دخول الأعمال المدنية', [1, 2], 'Access Permission', 'TPL-PRM'], [1, 'B4', 'CW survey', 'مسح الأعمال المدنية', [1, 2], null, 'TPL-SITE'],
  [1, 'B6', 'Layout submission', 'تقديم المخطط', [1, 2], 'Layout', 'TPL-SITE'], [1, 'B7', 'Layout and CW DN approval', 'اعتماد المخطط وإشعار التسليم', [1, 2], 'Approval Email', 'TPL-SITE'],
  [2, 'B9', 'CW MOS', 'MOS الأعمال المدنية', [1, 2], 'MOS Proof', 'TPL-SITE'], [2, 'B11', 'Tower / adaption items', 'بنود البرج والتهيئة', [4, 8], null, 'TPL-SITE'],
  [3, 'B13', 'CW PAC · snags cleared', 'استلام مبدئي · إغلاق الملاحظات', [1, 3], 'CW PAC', 'TPL-SITE'], [3, 'C2', 'GECOL Power-On', 'تشغيل كهرباء GECOL', [7, 10], 'Power-On Certificate', 'TPL-GECOL'],
  [3, 'C4', 'HLC TX link tested', 'اختبار وصلة HLC', [7, 10], 'TX Test Report', 'TPL-HLC'],
  [4, 'D1', 'TE access permission', 'تصريح دخول TE', [3, 5], 'Access Permission', 'TPL-PRM'], [4, 'D2', 'TE survey', 'مسح TE', [1, 2], 'Link Budget', 'TPL-SITE'],
  [4, 'D3', 'TE DN submission', 'تقديم إشعار TE', [1, 2], 'TE DN', 'TPL-SITE'], [4, 'D5', 'TE MOS', 'MOS لـ TE', [1, 1], 'MOS Proof', 'TPL-SITE'], [4, 'D6', 'TE installation', 'تركيب TE', [3, 5], null, 'TPL-SITE'],
  [5, 'D7', 'Commissioning', 'التشغيل التجريبي', [1, 1], null, 'TPL-SITE'], [5, 'D8', 'MW alignment', 'محاذاة الميكروويف', [1, 1], null, 'TPL-SITE'], [5, 'D9', 'Integration', 'الدمج', [1, 1], null, 'TPL-SITE'],
  [6, 'D11', 'SSV', 'SSV', [3, 5], 'SSV Report', 'TPL-SITE'], [6, 'D14', 'PAT · NOC alarms', 'PAT · إنذارات NOC', [3, 5], 'PAT', 'TPL-SITE'], [6, 'D16', 'TE PAC', 'TE PAC', [5, 10], 'TE PAC', 'TPL-SITE'],
  [7, 'F1', 'Cluster optimization', 'تحسين المجموعة', null, 'Optimization Report', 'TPL-SITE'],
  [8, 'D17', 'HOTO package', 'حزمة HOTO', [3, 5], 'HOTO', 'TPL-SITE'],
  [9, 'B15', 'CW FAC', 'FAC الأعمال المدنية', [3, 10], 'CW FAC', 'TPL-SITE'], [9, 'D18', 'TE FAC', 'FAC لـ TE', [3, 10], 'TE FAC', 'TPL-SITE'],
  [9, 'B14', 'CW DLP', 'فترة ضمان الأعمال المدنية', null, null, 'TPL-SITE'], // appended last so the ids of the other tasks do not move
];

/** Default streams (CLAUDE.md) and the stage -> stream mapping of the mock stage codes. The API has no DISMANTLE stream yet, so the mock has none either. */
export const STREAMS = [
  { code: 'DESIGN_ACQ', name_en: 'Design & Acquisition', name_ar: 'التصميم والاستحواذ', sort_order: 1 },
  { code: 'CW', name_en: 'Civil Works', name_ar: 'الأعمال المدنية', sort_order: 2 },
  { code: 'TE', name_en: 'Installation (TE)', name_ar: 'التركيبات', sort_order: 3 },
  { code: 'CLOSURE', name_en: 'Handover & Closure', name_ar: 'التسليم والإغلاق', sort_order: 4 },
];
const STREAM_OF = ['DESIGN_ACQ', 'CW', 'CW', 'CW', 'TE', 'TE', 'TE', 'TE', 'CLOSURE', 'CLOSURE'];
/** The views of contract 0.4.7 with the seed membership (migration 0023) while `views.om_team_assigned` is false: B15 in CW, D18 in TE, B14 in OM. Stage 1 and Z1 are in no view. */
export const VIEWS: View[] = [
  { code: 'CW', name_en: 'Civil Works', name_ar: 'الأعمال المدنية', sort_order: 1, stage_codes: [STAGE_CODES[1], STAGE_CODES[2], STAGE_CODES[3]], task_codes: ['B15'] },
  { code: 'TE', name_en: 'Installation (TE)', name_ar: 'التركيبات', sort_order: 2, stage_codes: STAGE_CODES.slice(4, 9), task_codes: ['D18'] },
  { code: 'OM', name_en: 'O&M', name_ar: 'التشغيل والصيانة', sort_order: 3, stage_codes: [], task_codes: ['B14'] },
];
export const VIEW_REFS = VIEWS.map(({ code, name_en, name_ar, sort_order }) => ({ code, name_en, name_ar, sort_order }));
const inView = (t: { stage_code: string; task_code: string }, view?: string) => {
  const v = VIEWS.find((x) => x.code === view);
  return !view || (!!v && (v.stage_codes.includes(t.stage_code) || v.task_codes.includes(t.task_code)));
};
export const streamOfStage = (code: string) => STREAM_OF[STAGE_CODES.indexOf(code as never)] ?? null;

const pad = (n: number, w = 12) => String(n).padStart(w, '0');
export const siteIdOf = (i: number) => `50000000-0000-4000-8000-${pad(i + 1)}`;
export const taskIdOf = (i: number, k: number) => `60000000-0000-4000-8000-${pad((i + 1) * 100 + k)}`;
export const slotIdOf = (i: number, k: number, s: number) => `70000000-0000-4000-8000-${pad(((i + 1) * 100 + k) * 10 + s)}`;
const tail = (id: string) => Number(id.slice(-12));
export const siteIndex = (siteId: string) => (siteId.startsWith('50000000') ? tail(siteId) - 1 : -1);
export const isGenTask = (id: string) => id.startsWith('60000000');

const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const progress = (i: number) => (i * 7) % 11; // stages complete

export function siteMeta(i: number) {
  const p = progress(i), region = i % 7;
  const status = p === 10 ? 'completed' : p === 0 && i % 4 === 0 ? 'not_started' : i % 13 === 0 ? 'on_hold' : 'in_progress';
  return {
    i, p, id: siteIdOf(i), region_id: region + 1, code: `${REG[region]}${101 + i}`, name: `${NAMES[i % NAMES.length]} ${1 + Math.floor(i / NAMES.length)}`,
    scenario: SCEN[i % 5], status: status as SiteListItem['overall_status'], cluster: `CL-${REG[region]}-${1 + (i % 3)}`,
  };
}

function genTask(i: number, k: number): MockTask {
  const m = siteMeta(i), [s, code, en, ar, sla, doc, tpl] = DEFS[k];
  const j = DEFS.filter((d, q) => q < k && d[0] === s).length;
  // expansion: PRE-CW and CW only apply with adaption work; on every second expansion site there is none, and no new power or fiber either, so the whole Civil Works stream is N/A
  const na = m.scenario === 'expansion' && (s === 1 || s === 2 || (s === 3 && i % 2 === 0));
  const state: MockTask['state'] = na ? 'na' : s < m.p ? 'approved' : s === m.p ? (j < i % 3 ? 'approved' : j === i % 3 ? (i % 6 === 5 ? 'open' : 'entry') : 'locked') : 'locked';
  const planned = addDays(TODAY, -(m.p * 25 + (i % 9)) + s * 25 + j * 4);
  const actual = state === 'approved' ? addDays(planned, ((i + j) % 7) - 2) : null;
  const elapsed = state === 'approved' ? (i + j) % 7 : (i * 3 + j) % 9;
  const max = sla?.[1] ?? null;
  const colour = !sla ? 'none' : state === 'locked' || state === 'na' ? 'none' : elapsed > (max ?? 99) ? 'red' : elapsed > sla[0] ? 'amber' : 'green';
  const levels = s === 9 ? 1 : 3;
  const slots: DocumentSlot[] = doc ? [{
    id: slotIdOf(i, k, 0), doc_code: code, name_en: doc, kind: 'scanned_document', mandatory: true, formats: ['pdf', 'jpg', 'png'], max_size_mb: 20, min_files: 1, max_files: null,
    status: state === 'approved' ? 'approved' : 'missing',
    files: state === 'approved' ? [{ id: slotIdOf(i, k, 9), file_group_id: slotIdOf(i, k, 8), version: 1, is_current: true, original_name: `${doc}.pdf`, download_name: `${m.code}_${code}_${doc.replace(/\W+/g, '')}.pdf`, size_bytes: 120000, uploaded_at: `${actual}T09:00:00Z` }] : [],
  }] : [];
  const locks = s > m.p ? [{ kind: 'gate_closed' as const, ref_code: STAGE_CODES[s - 1], message: `Milestone ${STAGE_EN[s - 1]} is not complete yet.` }]
    : [{ kind: 'predecessor_not_approved' as const, ref_code: DEFS[k - 1]?.[1], message: `${DEFS[k - 1]?.[1] ?? 'Previous task'} must be approved first.` }];
  return {
    id: taskIdOf(i, k), site_id: m.id, site_code: m.code, region_id: m.region_id as MockTask['region_id'], task_code: code, name_en: en, name_ar: ar, stage_code: STAGE_CODES[s], stream_code: STREAM_OF[s], state,
    current_level: state === 'approved' ? levels : 1, levels_required: levels, planned_date: planned, actual_date: actual,
    sla: { colour, min_wd: sla?.[0] ?? null, max_wd: max, elapsed_wd: sla && state !== 'locked' ? elapsed : null, due_date: sla ? addDays(planned, max ?? 0) : null,
      // contract 0.12.0 (P1): Q135 C-3 Pending SLA Confirmation; Q2 D-1 not measured on Swap sites; D4b a tentative holiday inside every 11th open period
      pending_confirmation: code === 'C3', measured: !(code === 'D1' && (m.scenario === 'hot_swap' || m.scenario === 'cold_swap')),
      ...(sla && state !== 'approved' && state !== 'na' && (i + k) % 11 === 0 ? { tentative_holidays: [addDays(planned, Math.max(1, (max ?? 2) - 1))], due_date_tentative: true } : { tentative_holidays: [], due_date_tentative: false }) },
    slots_filled: slots.filter((x) => x.files.length).length, slots_required: slots.length, template_id: tpl, return_count: 0, version: 1,
    holder_absent: state === 'entry' && i % 17 === 0, submitted_by: '1102', waiting_since: `${TODAY}T08:00:00Z`, level_kind: 'review', docs: [], external: 'A&T Global', entered_by: '1102',
    gen: true, slots, locks,
  } as MockTask;
}

/** Generated task merged with the user's changes. Read-only; use `touch` before mutating. */
export const taskOf = (id: string): MockTask | undefined => {
  if (!isGenTask(id)) return undefined;
  const n = tail(id), i = Math.floor(n / 100) - 1, k = n % 100;
  if (i < 0 || i >= SITE_COUNT || k >= DEFS.length) return undefined;
  return db().ov[id] ?? genTask(i, k);
};
export const touch = (id: string) => { const t = taskOf(id); if (t) db().ov[id] = t; return t; };
export const siteTasks = (i: number) => DEFS.map((_, k) => taskOf(taskIdOf(i, k))!);

export function pipelineOf(i: number): PipelineNode[] {
  const tasks = siteTasks(i);
  return STAGE_CODES.map((code, s) => {
    const own = tasks.filter((t) => t.stage_code === code && t.state !== 'na');
    const done = own.filter((t) => t.state === 'approved').length;
    const planned = own.map((t) => t.planned_date ?? '').sort().pop() || null;
    const complete = own.length > 0 && done === own.length;
    const late = !complete && own.some((t) => t.sla?.colour === 'red');
    const started = own.some((t) => t.state !== 'locked');
    return {
      code, kind: 'milestone', name_en: STAGE_EN[s], name_ar: STAGE_AR[s], progress: own.length ? done / own.length : 0, planned_date: planned,
      actual_date: complete ? own.map((t) => t.actual_date ?? '').sort().pop() : null, variance_wd: complete ? (i + s) % 4 : null,
      state: !own.length ? 'na' : complete ? 'done' : late ? 'late' : started ? 'current' : 'planned',
    } as PipelineNode;
  });
}

const bad = (p: PipelineNode[]) => p.map((n) => ({ code: n.code, state: n.state === 'locked' || n.state === 'awaiting_confirmation' ? 'planned' : n.state }));

/** The status of one site in each stream, with the real shape of `StreamStatus` (stages and counting tasks of the stream only). */
export function streamStatuses(i: number, view?: string): StreamStatus[] {
  const tasks = siteTasks(i).filter((t) => inView(t, view));
  return STREAMS.map((s) => {
    const stages = STAGE_CODES.filter((c) => streamOfStage(c) === s.code);
    const own = tasks.filter((t) => stages.includes(t.stage_code as never) && t.state !== 'na');
    const done = own.filter((t) => t.state === 'approved').length;
    const cur = stages.find((c) => own.some((t) => t.stage_code === c && t.state !== 'approved'));
    const state: StreamStatus['state'] = !own.length ? 'na' : done === own.length ? 'done' : own.some((t) => t.state !== 'locked') ? 'in_progress' : 'not_started';
    return {
      ...s, state, current_stage: state === 'done' || state === 'na' ? null : cur ?? null, done_tasks: done, total_tasks: own.length,
      late_count: own.filter((t) => t.state !== 'approved' && t.sla?.colour === 'red').length,
      milestone_date: state === 'done' ? own.map((t) => t.actual_date ?? '').sort().pop() || null : null,
    };
  });
}

/** Tasks of a site in the stream and the view (an intersection, contract 0.4.7). */
export const scopedTasks = (i: number, stream?: string, view?: string) => siteTasks(i).filter((t) => (!stream || streamOfStage(t.stage_code) === stream) && inView(t, view));

/** 0.15.4 (migration 0085): the workflow locks of a mock site (switched in `db().siteLocks`), and a synthetic data-gap count (every seventh site has two). */
export const locksOf = (siteId: string): boolean => db().siteLocks?.[siteId] ?? true;
export const gapsOf = (i: number): number => (i % 7 === 3 ? 2 : 0);
const gapItemsOf = (i: number): SiteDetail['data_gap_items'] => (gapsOf(i) ? [{ kind: 'missing_actual_date', task_code: 'B3', successor_code: 'B4' }, { kind: 'missing_field', field: 'delivery_scenario' }] : []);

export function listItem(i: number, stream?: string, view?: string): SiteListItem {
  const m = siteMeta(i), tasks = scopedTasks(i, stream, view);
  const pipe = pipelineOf(i).filter((n) => (!stream || streamOfStage(n.code) === stream) && (!view || tasks.some((t) => t.stage_code === n.code)));
  const cur = pipe.find((n) => n.state === 'current' || n.state === 'late');
  return {
    id: m.id, site_code: m.code, name: m.name, name_ar: i % 2 === 0 ? `موقع ${m.name}` : null, region_id: m.region_id as SiteListItem['region_id'], cluster_code: m.cluster, delivery_scenario: m.scenario, overall_status: m.status,
    current_milestone: cur?.code ?? null, next_milestone: pipe.find((n) => n.state === 'planned')?.code ?? null, workflow_version: 1,
    late_task_count: tasks.filter((t) => t.sla?.colour === 'red' && t.state !== 'approved').length,
    waiting_approval_count: tasks.filter((t) => t.state === 'in_review' || t.state === 'in_approval').length, rail: bad(pipe) as SiteListItem['rail'],
    streams: streamStatuses(i, view), views: VIEW_REFS, workflow_locks: locksOf(m.id), data_gaps: gapsOf(i),
  };
}

export function detail(i: number): SiteDetail {
  const m = siteMeta(i), pipe = pipelineOf(i);
  return {
    ...listItem(i), pipeline: pipe, version: 1, address: `${NAMES[i % NAMES.length]} road`, site_type: 'Macro', project_phase: 'Phase 2',
    // the map has synthetic coordinates (mapGeo); the site page keeps none, so the identity proposals start empty
    tower_owner: mapGeo(i).tower_owner, sub_region: NAMES[i % NAMES.length], owner_site_id: `OWN-${1000 + i}`, tower_type: i % 3 === 0 ? 'Monopole' : 'Lattice', tower_height_m: 24 + (i % 4) * 6,
    cluster_progress: { cluster_code: m.cluster, sites_total: 9, sites_at_te_pac: 1 + (i % 6), kpi_acceptance_date: null },
    workflow_locks_info: { changed_at: null, changed_by: null, reason: null, can_manage: viewer()?.key === 'pm' }, data_gap_items: gapItemsOf(i),
    counts: { open_snags: i % 4, open_issues: i % 3, documents_missing: siteTasks(i).reduce((a, t) => a + (t.slots_required ?? 0) - (t.slots_filled ?? 0), 0) },
  } as SiteDetail;
}

export function gridOf(i: number, stream?: string, view?: string): SiteTasks {
  const tasks = siteTasks(i).filter((t) => inView(t, view));
  return {
    workflow_version: 1,
    streams: STREAMS, views: VIEWS,
    stages: STAGE_CODES.map((code, s) => ({ code, stream_code: STREAM_OF[s], name_en: STAGE_EN[s], name_ar: STAGE_AR[s], tasks: tasks.filter((t) => t.stage_code === code).map(toSummary) }))
      .filter((st) => (!stream || st.stream_code === stream) && (!view || st.tasks.length)),
  };
}

// ---------------------------------------------------------------- 0.14.5: the site map (synthetic coordinates spread over Libya, fictional tower owners)
/** Synthetic centres per region (around the main city of each region) and a fixed scatter, so the map looks like a real spread without any real site. */
const CENTRE: [number, number][] = [[32.82, 13.15], [31.55, 15.6], [31.95, 11.4], [32.68, 12.45], [32.0, 20.25], [32.6, 21.7], [26.9, 14.4]];
const SPREAD: [number, number][] = [[0.35, 0.6], [0.9, 1.6], [0.5, 1.0], [0.25, 0.5], [0.45, 0.9], [0.35, 0.9], [1.4, 1.8]];
const OWNERS = ['TowerCo Alpha (synthetic)', 'TowerCo Beta (synthetic)', 'Own tower'];
const jit = (i: number, k: number) => (((i * 9301 + k * 49297) % 233280) / 233280) * 2 - 1;
/** Every 17th site has no coordinates and every 29th a point outside Libya: both are counted as "without valid coordinates". */
export function mapGeo(i: number): { latitude: number | null; longitude: number | null; tower_owner: string | null } {
  const r = siteMeta(i).region_id - 1;
  const owner = i % 5 === 4 ? null : OWNERS[i % OWNERS.length]!;
  if (i % 17 === 16) return { latitude: null, longitude: null, tower_owner: owner };
  if (i % 29 === 28) return { latitude: 41.2, longitude: 12.1, tower_owner: owner };
  const [la, lo] = CENTRE[r]!, [sla, slo] = SPREAD[r]!;
  return { latitude: Math.round((la + jit(i, 1) * sla) * 1e5) / 1e5, longitude: Math.round((lo + jit(i, 2) * slo) * 1e5) / 1e5, tower_owner: owner };
}
const validGeo = (la: number | null, lo: number | null) => la !== null && lo !== null && la > 18 && la < 34.5 && lo > 8 && lo < 26;
export const hasValidCoords = (i: number) => { const g = mapGeo(i); return validGeo(g.latitude, g.longitude); };

/** One row of GET /dashboard/site-map from the mock site: the current milestone is the first stage neither done nor N/A, On-Air is the on_air stage done. */
export function mapItem(i: number) {
  const m = siteMeta(i), pipe = pipelineOf(i), li = listItem(i), g = mapGeo(i), tasks = siteTasks(i).filter((t) => t.state !== 'na');
  const cur = pipe.find((n) => n.state !== 'done' && n.state !== 'na');
  const last = [...pipe].reverse().find((n) => n.state === 'done');
  const late = li.late_task_count ?? 0, behind = !!cur && i % 9 === 0;
  return {
    id: m.id, site_code: m.code, name: m.name, name_ar: li.name_ar ?? null, region_id: m.region_id as SiteListItem['region_id'], sub_region: NAMES[i % NAMES.length]!, cluster_code: m.cluster,
    latitude: g.latitude, longitude: g.longitude, has_coordinates: validGeo(g.latitude, g.longitude), overall_status: m.status, delivery_scenario: m.scenario, tower_owner: g.tower_owner,
    stream_code: cur ? streamOfStage(cur.code) : null, milestone_code: cur?.code ?? null, last_milestone_code: last?.code ?? null,
    on_air_reached: pipe.find((n) => n.code === 'on_air')?.state === 'done', late_task_count: late, behind_baseline: behind, late: late > 0 || behind,
    task_progress_pct: tasks.length ? Math.round((tasks.filter((t) => t.state === 'approved').length * 1000) / tasks.length) / 10 : null,
  };
}
export const MAP_MILESTONES = STAGE_CODES.map((code, s) => ({ code, name_en: STAGE_EN[s]!, name_ar: STAGE_AR[s]!, sort_order: s + 1, stream_code: STREAM_OF[s]! }));
