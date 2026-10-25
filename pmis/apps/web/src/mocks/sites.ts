import type { DocumentSlot, PipelineNode, SiteDetail, SiteListItem, SiteTasks } from '@/api/types';
import { db, toSummary, type MockTask } from './db';
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
];

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
  const na = m.scenario === 'expansion' && (s === 1 || s === 2);
  const state: MockTask['state'] = na ? 'na' : s < m.p ? 'approved' : s === m.p ? (j < i % 3 ? 'approved' : j === i % 3 ? 'entry' : 'locked') : 'locked';
  const planned = addDays(TODAY, -(m.p * 25 + (i % 9)) + s * 25 + j * 4);
  const actual = state === 'approved' ? addDays(planned, ((i + j) % 7) - 2) : null;
  const elapsed = state === 'approved' ? (i + j) % 7 : (i * 3 + j) % 9;
  const max = sla?.[1] ?? null;
  const colour = !sla ? 'none' : state === 'locked' || state === 'na' ? 'none' : elapsed > (max ?? 99) ? 'red' : elapsed > sla[0] ? 'amber' : 'green';
  const levels = s === 9 ? 1 : 3;
  const slots: DocumentSlot[] = doc ? [{
    id: slotIdOf(i, k, 0), doc_code: code, name_en: doc, kind: 'scanned_document', mandatory: true, formats: ['pdf', 'jpg', 'png'], max_size_mb: 20, min_files: 1, max_files: 3,
    status: state === 'approved' ? 'approved' : 'missing',
    files: state === 'approved' ? [{ id: slotIdOf(i, k, 9), file_group_id: slotIdOf(i, k, 8), version: 1, is_current: true, original_name: `${doc}.pdf`, download_name: `${m.code}_${code}_${doc.replace(/\W+/g, '')}.pdf`, size_bytes: 120000, uploaded_at: `${actual}T09:00:00Z` }] : [],
  }] : [];
  const locks = s > m.p ? [{ kind: 'gate_closed' as const, ref_code: STAGE_CODES[s - 1], message: `Milestone ${STAGE_EN[s - 1]} is not complete yet.` }]
    : [{ kind: 'predecessor_not_approved' as const, ref_code: DEFS[k - 1]?.[1], message: `${DEFS[k - 1]?.[1] ?? 'Previous task'} must be approved first.` }];
  return {
    id: taskIdOf(i, k), site_id: m.id, site_code: m.code, region_id: m.region_id as MockTask['region_id'], task_code: code, name_en: en, name_ar: ar, stage_code: STAGE_CODES[s], state,
    current_level: state === 'approved' ? levels : 1, levels_required: levels, planned_date: planned, actual_date: actual,
    sla: { colour, min_wd: sla?.[0] ?? null, max_wd: max, elapsed_wd: sla && state !== 'locked' ? elapsed : null, due_date: sla ? addDays(planned, max ?? 0) : null },
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
export function listItem(i: number): SiteListItem {
  const m = siteMeta(i), pipe = pipelineOf(i), tasks = siteTasks(i);
  const cur = pipe.find((n) => n.state === 'current' || n.state === 'late');
  return {
    id: m.id, site_code: m.code, name: m.name, region_id: m.region_id as SiteListItem['region_id'], cluster_code: m.cluster, delivery_scenario: m.scenario, overall_status: m.status,
    current_milestone: cur?.code ?? null, next_milestone: pipe.find((n) => n.state === 'planned')?.code ?? null, workflow_version: 1,
    late_task_count: tasks.filter((t) => t.sla?.colour === 'red' && t.state !== 'approved').length,
    waiting_approval_count: tasks.filter((t) => t.state === 'in_review' || t.state === 'in_approval').length, rail: bad(pipe) as SiteListItem['rail'],
  };
}

export function detail(i: number): SiteDetail {
  const m = siteMeta(i), pipe = pipelineOf(i);
  return {
    ...listItem(i), pipeline: pipe, version: 1, address: `${NAMES[i % NAMES.length]} road`, site_type: 'Macro', project_phase: 'Phase 2',
    cluster_progress: { cluster_code: m.cluster, sites_total: 9, sites_at_te_pac: 1 + (i % 6), kpi_acceptance_date: null },
    counts: { open_snags: i % 4, open_issues: i % 3, documents_missing: siteTasks(i).reduce((a, t) => a + (t.slots_required ?? 0) - (t.slots_filled ?? 0), 0) },
  } as SiteDetail;
}

export function gridOf(i: number): SiteTasks {
  const tasks = siteTasks(i);
  return {
    workflow_version: 1,
    stages: STAGE_CODES.map((code, s) => ({ code, name_en: STAGE_EN[s], name_ar: STAGE_AR[s], tasks: tasks.filter((t) => t.stage_code === code).map(toSummary) })),
  };
}
