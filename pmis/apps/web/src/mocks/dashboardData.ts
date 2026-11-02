import type { Dashboard } from '@/api/dashboard';
import { tripoliToday } from '@/lib/today';

/**
 * Synthetic dashboard for the mock layer (fictional numbers). The shape is the contract's `Dashboard` (0.7.2); the real figures come from
 * the API (dash_overview). The mock follows the filters well enough for the screens: a region keeps only its row, a stream keeps only its
 * milestones, a scenario or a cluster scales the counts, and a past date is "computed as of" unless it is one of the snapshot dates.
 */
const REGIONS = [
  { id: 1, name_en: 'Tripoli', name_ar: 'طرابلس', sites: 40, done: [38, 34, 30, 26, 20, 16, 12, 9, 6, 3], progress: 61.2, late: 7 },
  { id: 2, name_en: 'Middle', name_ar: 'الوسطى', sites: 22, done: [20, 17, 14, 11, 8, 6, 4, 3, 2, 1], progress: 48.5, late: 5 },
  { id: 3, name_en: 'WM', name_ar: 'الغربية', sites: 18, done: [17, 15, 12, 9, 7, 5, 3, 2, 1, 0], progress: 44.1, late: 3 },
  { id: 4, name_en: 'Zawia', name_ar: 'الزاوية', sites: 20, done: [19, 16, 13, 10, 8, 6, 4, 2, 1, 1], progress: 52.8, late: 4 },
  { id: 5, name_en: 'Benghazi', name_ar: 'بنغازي', sites: 30, done: [27, 22, 18, 14, 10, 7, 5, 3, 2, 0], progress: 39.4, late: 9 },
  { id: 6, name_en: 'GM', name_ar: 'الجبل الأخضر', sites: 14, done: [12, 9, 7, 5, 3, 2, 1, 0, 0, 0], progress: 31.0, late: 2 },
  { id: 7, name_en: 'Sebha', name_ar: 'سبها', sites: 16, done: [13, 10, 8, 6, 4, 2, 1, 0, 0, 0], progress: 27.6, late: 6 },
];
const MS = [
  { code: 'MS1', en: 'Site Release', ar: 'إطلاق الموقع', stream: 'DESIGN_ACQ' }, { code: 'MS2', en: 'PRE-CW Completion', ar: 'اكتمال ما قبل الأعمال المدنية', stream: 'CW' },
  { code: 'MS3', en: 'CW Completion', ar: 'اكتمال الأعمال المدنية', stream: 'CW' }, { code: 'MS4', en: 'Site RFI', ar: 'جاهزية الموقع للتركيب (RFI)', stream: 'CW' },
  { code: 'MS5', en: 'TE Completion', ar: 'اكتمال تركيب TE', stream: 'TE' }, { code: 'MS6', en: 'On-Air', ar: 'التشغيل (On-Air)', stream: 'TE' },
  { code: 'MS7', en: 'TE PAC', ar: 'القبول الأولي لـ TE (PAC)', stream: 'TE' }, { code: 'MS8', en: 'KPI Acceptance', ar: 'قبول مؤشرات الأداء (KPI)', stream: 'TE' },
  { code: 'MS9', en: 'HOTO', ar: 'التسليم والاستلام (HOTO)', stream: 'CLOSURE' }, { code: 'MS10', en: 'Final Closure', ar: 'الإغلاق النهائي', stream: 'CLOSURE' },
];
const STREAMS = [
  { code: 'DESIGN_ACQ', name_en: 'Design & Acquisition', name_ar: 'التصميم والاستحواذ', sort_order: 1 }, { code: 'CW', name_en: 'Civil Works', name_ar: 'الأعمال المدنية', sort_order: 2 },
  { code: 'TE', name_en: 'Installation (TE)', name_ar: 'التركيبات', sort_order: 3 }, { code: 'CLOSURE', name_en: 'Handover & Closure', name_ar: 'التسليم والإغلاق', sort_order: 4 },
  { code: 'DISMANTLE', name_en: 'Dismantle', name_ar: 'الفك', sort_order: 99 },
];
export const MOCK_SNAPSHOT_DATES = ['2026-10-22', '2026-10-15', '2026-10-08'];
const SCENARIOS = ['new_build', 'expansion', 'hot_swap', 'cold_swap', 'relocation'] as const;

const sc = (n: number, f: number): number => Math.round(n * f);

export function buildDashboard(q: URLSearchParams, scope: number[] | null = null): Dashboard {
  const today = tripoliToday();
  const ref = q.get('ref_date') || today;
  const region = q.get('region_id');
  const stream = q.get('stream');
  const f = (q.get('scenario') ? 0.35 : 1) * (q.get('cluster_code') ? 0.2 : 1);
  const snapshot = ref !== today && MOCK_SNAPSHOT_DATES.includes(ref);
  const source = ref === today ? 'live' : snapshot ? 'snapshot' : 'as_of_computed';
  const rs = REGIONS.filter((r) => (scope === null || scope.includes(r.id)) && (!region || r.id === Number(region)));
  const past = ref === today ? 1 : 0.9;
  const total = rs.reduce((a, r) => a + sc(r.sites, f * past), 0);
  const doneOf = (i: number) => rs.reduce((a, r) => a + sc(r.done[i]!, f * past), 0);
  const inProg = Math.round(total * 0.46), hold = Math.round(total * 0.04), comp = doneOf(9), notStarted = Math.max(0, total - inProg - hold - comp);
  const nodesAll = MS.map((m, i) => {
    const done = doneOf(i);
    const plan = Math.min(total, done + (i % 3 === 0 ? 2 : -1));
    const open = Math.max(0, total - done);
    const waiting = Math.round(open * 0.6), blocked = i === 4 || i === 6 ? Math.min(open - waiting, 2) : 0;
    return {
      code: m.code, name_en: m.en, name_ar: m.ar, order: i + 1, stream_code: m.stream, counts_in_project_status: i < 9, sites_total: total, completed: done,
      in_progress: Math.max(0, open - waiting - blocked), late: Math.round(open * 0.2), not_started: waiting, not_applicable: 0, blocked,
      completed_pct: total ? Math.round((done * 1000) / total) / 10 : 0, plan, vs_plan: done - plan, baseline_missing: i === 9 ? 3 : 0, overdue_open: Math.round(open * 0.2),
      achieved_late: Math.round(done * 0.3), on_time: Math.round(done * 0.7), avg_variance_wd: 1.5, avg_delay_wd: 4.2, avg_working_days: 1.5,
      gate: i === 0 ? null : { code: `G${i + 1}`, name_en: `${m.en} gate`, name_ar: m.ar },
    };
  });
  const nodes = stream && stream !== 'DISMANTLE' ? nodesAll.filter((n) => n.stream_code === stream) : nodesAll;
  const progress = total ? Math.round(rs.reduce((a, r) => a + r.progress * r.sites, 0) / rs.reduce((a, r) => a + r.sites, 0) * 10) / 10 : 0;
  const score = 74.3;
  const streams = STREAMS.map((s) => {
    const base = s.code === 'DISMANTLE' ? 0.1 : 1;
    const done = Math.round(total * base * ({ DESIGN_ACQ: 0.8, CW: 0.55, TE: 0.25, CLOSURE: 0.08, DISMANTLE: 0.5 }[s.code] ?? 0.2));
    const prog = Math.round(total * base * 0.25), notDue = Math.round(total * base * ({ DESIGN_ACQ: 0, CW: 0.1, TE: 0.4, CLOSURE: 0.6, DISMANTLE: 0 }[s.code] ?? 0));
    const na = s.code === 'DISMANTLE' ? total - done - prog : Math.max(0, total - done - prog - notDue);
    return {
      code: s.code, name_en: s.name_en, name_ar: s.name_ar, sort_order: s.sort_order,
      counts: { done, in_progress: prog, not_due: s.code === 'DISMANTLE' ? 0 : notDue, not_started: s.code === 'DISMANTLE' ? Math.round(total * 0.05) : 0, na, on_hold: s.code === 'DISMANTLE' ? 0 : hold },
      by_region: rs.map((r) => ({ region_id: r.id, done: Math.round(sc(r.sites, f) * 0.4), in_progress: Math.round(sc(r.sites, f) * 0.25), not_due: Math.round(sc(r.sites, f) * 0.2), not_started: 0, na: 0, on_hold: 0 })),
    };
  });
  const stages = MS.slice(0, 8).map((m, i) => ({
    stage_code: m.code, name_en: m.en, name_ar: m.ar, order: i + 1, stream_code: m.stream,
    open_on_time: Math.max(0, 14 - i), open_at_risk: 5 + (i % 3), open_late: 3 + (i % 4), completed_on_time: 30 - i * 2, completed_late: 4 + i,
  }));
  const issues = scope !== null && scope.length === 0 ? null : {
    available: true, open_total: sc(23, f * (region ? 0.3 : 1)), sites_with_open_issue: sc(17, f * (region ? 0.3 : 1)), blocking_total: 3, oldest_age_wd: 38, avg_age_wd: 14.2,
    by_owner: [
      { owner_key: 'user:1', owner_kind: 'user' as const, owner_name: 'Sami Nuri', count: sc(8, f), sites: sc(6, f), oldest_age_wd: 38, avg_age_wd: 15 },
      { owner_key: 'party:1', owner_kind: 'party' as const, owner_name: 'A&T Global', count: sc(6, f), sites: sc(5, f), oldest_age_wd: 21, avg_age_wd: 11 },
      { owner_key: 'user:2', owner_kind: 'user' as const, owner_name: 'Lina Haddad', count: sc(4, f), sites: sc(4, f), oldest_age_wd: 12, avg_age_wd: 8 },
    ],
    age_buckets: [{ key: '0_7' as const, count: 8 }, { key: '8_15' as const, count: 6 }, { key: '16_30' as const, count: 6 }, { key: 'over_30' as const, count: 3 }],
  };
  return {
    meta: { as_of: new Date().toISOString(), workflow_versions: [1], override_flagged_count: 0, overrides_excluded: true, project_wide: !region && !q.get('scenario') && !q.get('cluster_code') && !stream && scope === null,
      central_items_hidden: scope === null && !region ? 0 : 14, scope_regions: scope, health_draft: true,
      weight_set: { id: '00000000-0000-4000-8000-000000000001', code: 'project_status', version: 1, effective_from: '2024-01-01', is_active: true } },
    basis: {
      ref_date: ref, today, source, snapshot_date: snapshot ? ref : null, snapshot_dates: MOCK_SNAPSHOT_DATES,
      note: source === 'live' ? null : source === 'snapshot' ? 'Figures come from the weekly snapshot.' : 'No snapshot exists for this date: computed as of the date from dated facts.',
    },
    filters: {
      regions: REGIONS.filter((r) => scope === null || scope.includes(r.id)).map((r) => ({ id: r.id, name_en: r.name_en, name_ar: r.name_ar })),
      clusters: ['CL-TR-01', 'CL-TR-02', 'CL-BN-01'], scenarios: [...SCENARIOS], streams: STREAMS.map((s) => ({ code: s.code, name_en: s.name_en, name_ar: s.name_ar })),
    },
    headline: {
      sites_total: total, sites_cancelled: region ? 1 : 3,
      by_overall_status: { not_started: notStarted, in_progress: inProg, on_hold: hold, completed: comp, cancelled: region ? 1 : 3 },
      milestones: nodesAll.map((n) => ({ code: n.code, name_en: n.name_en, name_ar: n.name_ar, order: n.order, applicable: n.sites_total, done: n.completed, done_pct: n.completed_pct, plan: n.plan, vs_plan: n.vs_plan, baseline_missing: n.baseline_missing })),
      on_air: { code: 'MS6', applicable: total, done: doneOf(5), done_pct: total ? Math.round((doneOf(5) * 1000) / total) / 10 : 0, plan: Math.min(total, doneOf(5) + 3), vs_plan: -3 },
      final_closure: {
        sites_total: doneOf(8), sites_closed: comp, closed_pct: doneOf(8) ? Math.round((comp * 1000) / doneOf(8)) / 10 : 0, active_sites: total, closed_pct_of_active: total ? Math.round((comp * 1000) / total) / 10 : 0,
        pending_cw_fac: { count: 4, not_due: 11, avg_age_days: 9.5, oldest_age_days: 17, sites: [{ site_id: '00000000-0000-4000-8000-0000000000a1', site_code: 'TR101', age_days: 17 }] },
        pending_te_fac: { count: 2, not_due: 6, avg_age_days: 6, oldest_age_days: 8, sites: [] },
      },
      project_status: {
        progress_pct: progress, planned_pct: null, spi: null, plan_coverage_pct: 42, central_items_hidden: scope === null && !region ? 0 : 14,
        activities: [
          { code: 'A1', name_en: 'Survey & Engineering', name_ar: 'المسح والهندسة', weight: 12, progress_pct: 82, measured: true, items: [] },
          { code: 'A2', name_en: 'Site Acquisition & Permits', name_ar: 'استحواذ الموقع والتصاريح', weight: 8, progress_pct: 74, measured: true, items: [] },
          { code: 'A3', name_en: 'Procurement & Supply', name_ar: 'المشتريات والتوريد', weight: 5, progress_pct: 0, measured: false, items: [] },
          { code: 'A4', name_en: 'Civil Work & Site Readiness', name_ar: 'الأعمال المدنية وجاهزية الموقع', weight: 25, progress_pct: 58, measured: true, items: [] },
          { code: 'A5', name_en: 'TE Installation', name_ar: 'تركيب TE', weight: 20, progress_pct: 36, measured: true, items: [] },
          { code: 'A6', name_en: 'Integration & On-Air', name_ar: 'التكامل والتشغيل', weight: 12, progress_pct: 29, measured: true, items: [] },
          { code: 'A7', name_en: 'Testing & Acceptance', name_ar: 'الاختبار والقبول', weight: 13, progress_pct: 14, measured: true, items: [] },
          { code: 'A8', name_en: 'Training & Handover', name_ar: 'التدريب والتسليم', weight: 5, progress_pct: 6, measured: true, items: [] },
        ],
      },
    },
    pipeline: { nodes },
    streams: { items: stream && stream !== 'DISMANTLE' ? streams.filter((s) => s.code === stream) : streams },
    sla: {
      totals: { open_on_time: 80, open_at_risk: 34, open_late: 28, completed_on_time: 190, completed_late: 41 }, by_stage: stages,
      top_late: [
        { task_id: '00000000-0000-4000-8000-0000000000b1', site_id: '00000000-0000-4000-8000-0000000000a1', site_code: 'TR101', region_id: 1, task_code: 'B8', task_name: 'Tower MOS', stage_code: 'MS3', due_date: '2026-09-20', days_late_wd: 24, state: 'open', party: 'Gulf Civil Co.' },
        { task_id: '00000000-0000-4000-8000-0000000000b2', site_id: '00000000-0000-4000-8000-0000000000a2', site_code: 'BN204', region_id: 5, task_code: 'D5', task_name: 'TE MOS', stage_code: 'MS5', due_date: '2026-10-01', days_late_wd: 16, state: 'open', party: 'A&T Global' },
      ],
    },
    gates: {
      available: ref === today, blocked_total: ref === today ? 2 : 0, by_gate: [],
      items: ref === today ? [
        { site_id: '00000000-0000-4000-8000-0000000000a1', site_code: 'TR101', region_id: 1, gate_code: 'G5', name_en: 'TE Installation Readiness', name_ar: 'جاهزية تركيب TE', to_code: 'MS5', since: '2026-10-20T08:00:00Z',
          reasons: [{ kind: 'condition_not_met', ref_code: 'Access - TE', message: 'Access - TE must be approved and valid on the gate date.' }] },
        { site_id: '00000000-0000-4000-8000-0000000000a2', site_code: 'BN204', region_id: 5, gate_code: 'G7', name_en: 'TE PAC Readiness', name_ar: 'جاهزية القبول الأولي لـ TE', to_code: 'MS7', since: '2026-10-22T08:00:00Z',
          reasons: [{ kind: 'stop_work', ref_code: 'PTW - TE', message: 'Stop work is active on PTW - TE.' }] },
      ] : [],
    },
    issues,
    health: {
      draft: true, formula_version: 1, bands: { green: 85, amber: 70 }, score, band: score >= 85 ? 'green' : score >= 70 ? 'amber' : 'red',
      components: [
        { code: 'P', name_en: 'Progress', name_ar: 'التقدم', weight: 16.666, value: progress, excluded: false, contribution: 10.2 },
        { code: 'B', name_en: 'Baseline adherence', name_ar: 'الالتزام بخط الأساس', weight: 16.666, value: 71.4, excluded: false, contribution: 11.9 },
        { code: 'S', name_en: 'SLA adherence', name_ar: 'الالتزام بمدد SLA', weight: 16.667, value: 82.3, excluded: false, contribution: 13.7 },
        { code: 'D', name_en: 'Documentation completeness', name_ar: 'اكتمال المستندات', weight: 16.667, value: null, excluded: true, contribution: 0 },
        { code: 'F', name_en: 'First-time approval', name_ar: 'الاعتماد من أول مرة', weight: 16.667, value: 88.1, excluded: false, contribution: 14.7 },
        { code: 'I', name_en: 'Critical issues', name_ar: 'المشاكل الحرجة', weight: 16.667, value: 90.2, excluded: false, contribution: 15 },
      ],
      by_region: rs.map((r) => ({ region_id: r.id, score: Math.round((60 + r.progress / 4) * 10) / 10, band: 'amber' as const })),
    },
    delay: {
      draft: true, total_late_working_days: 412, unattributed_pct: 18.5, overlapping_periods: 0, periods_supported: false,
      items: [
        { party: 'A&T Global', kind: 'external' as const, external_party_id: '00000000-0000-4000-8000-0000000000c1', party_type: 'te_vendor', late_tasks: 41, late_working_days: 190, share_pct: 46.1 },
        { party: 'cw_contractor', kind: 'default_type' as const, late_tasks: 22, late_working_days: 98, share_pct: 23.8 },
        { party: 'unassigned', kind: 'unassigned' as const, late_tasks: 19, late_working_days: 76, share_pct: 18.5 },
        { party: 'gecol', kind: 'default_type' as const, late_tasks: 8, late_working_days: 48, share_pct: 11.6 },
      ],
    },
    regions: {
      items: rs.map((r) => ({
        region_id: r.id, region_name: r.name_en, region_name_ar: r.name_ar, sites_total: sc(r.sites, f * past), completed: sc(r.done[9]!, f), in_progress: Math.round(sc(r.sites, f) * 0.46), late: r.late,
        by_overall_status: { not_started: Math.round(sc(r.sites, f) * 0.35), in_progress: Math.round(sc(r.sites, f) * 0.46), on_hold: Math.round(sc(r.sites, f) * 0.04), completed: sc(r.done[9]!, f), cancelled: 0 },
        progress_pct: r.progress, health_score: Math.round(60 + r.progress / 4), by_milestone: Object.fromEntries(MS.map((m, i) => [m.code, sc(r.done[i]!, f)])),
      })),
    },
  } as Dashboard;
}
