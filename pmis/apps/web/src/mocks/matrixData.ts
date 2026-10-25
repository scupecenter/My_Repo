import type { Group, Matrix, MatrixAssignee, MatrixCell, Role } from '@/api/types';
import { byId, uid } from './ids';

type Row = Matrix['stages'][number];
export const STAGE_CODES = ['site_release', 'pre_cw', 'cw', 'site_rfi', 'te_installation', 'on_air', 'te_pac', 'kpi_acceptance', 'hoto', 'final_closure'] as const;

const rid = (n: number) => `90000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const gid = (n: number) => `91000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const ROLES = [
  ['Project Manager', 'مدير المشروع'], ['RF & Design / Acquisition Team Lead', 'قائد فريق RF والتصميم والاستحواذ'], ['CW Team Lead', 'قائد فريق الأعمال المدنية'],
  ['TE Team Lead', 'قائد فريق TE'], ['Inventory Supervisor', 'مشرف المخزون'], ['Project Support', 'دعم المشروع'],
].map(([en, ar], i) => ({ id: rid(i + 1), code: en.toLowerCase().replace(/\W+/g, '_'), name_en: en, name_ar: ar, is_active: true, can_hold_matrix_levels: true, description_en: `Duties of the ${en}.`, active_assignment_count: 1 + i })) as Role[];
export const GROUPS = [
  ['System Admins', 3, true], ['CW Reviewers Tripoli', 4, false], ['TE Reviewers', 3, false],
].map(([name, n, sys], i) => ({ id: gid(i + 1), name, member_count: n, is_system_admins: sys, is_active: true, matrix_cell_count: 1 })) as Group[];

export const asUser = (e: string): MatrixAssignee => ({ kind: 'user', ref_id: uid(e), user_id: uid(e), label: byId(e).name_en, employee_id: e });
export const asRole = (i: number): MatrixAssignee => ({ kind: 'role', ref_id: ROLES[i].id, label: ROLES[i].name_en, employee_id: null });
export const asGroup = (i: number): MatrixAssignee => ({ kind: 'group', ref_id: GROUPS[i].id, label: GROUPS[i].name, employee_id: null });

// entry / review / approve per stage (design/prototype-v2/data.js MATRIX; a few role/group cells as in the prototype)
const STAGE_ROWS: [string[], (string | MatrixAssignee)[], string[]][] = [
  [['1103', '1102'], ['1102'], ['1001']],
  [['1204', '1205', '1509'], [asGroup(1)], ['1203']],
  [['1204', '1205'], [asGroup(1), asRole(2)], ['1203']],
  [['1204', '1205', '1206', '1207'], ['1203'], ['1001']],
  [['1306'], [asGroup(2)], ['1305']],
  [['1306'], ['1305'], ['1305']],
  [['1306'], ['1305'], ['1001']],
  [['1103'], ['1102'], ['1001']],
  [['1307'], ['1305'], ['1001']],
  [['1001'], [], []], // 1 level: one person holds the only level, so a submission is the final approval (B5)
];
const STAGE_NAMES: [string, string][] = [
  ['Site Release', 'إطلاق الموقع'], ['PRE-CW', 'ما قبل الأعمال المدنية'], ['CW', 'الأعمال المدنية'], ['Site RFI', 'جاهزية الموقع'], ['TE Installation', 'تركيب TE'],
  ['On-Air', 'البث'], ['TE PAC', 'استلام مبدئي TE'], ['KPI Acceptance', 'قبول مؤشرات الأداء'], ['HOTO', 'التسليم والتسلّم'], ['Final Closure', 'الإغلاق النهائي'],
];
const REGISTERS: [string, string, string][] = [
  ['procurement', 'Procurement (PR/PO/WO)', 'المشتريات'], ['contractors', 'Contractors', 'المقاولون'], ['gecol', 'GECOL power', 'كهرباء GECOL'], ['hlc', 'HLC fiber', 'ألياف HLC'],
  ['permits_hse', 'Permits & HSE', 'التصاريح والسلامة'], ['warehouse', 'Warehouse', 'المخزن'], ['quality', 'Quality', 'الجودة'], ['issues', 'Issue Log', 'سجل المشاكل'],
  ['risks', 'Risk Register', 'سجل المخاطر'], ['change_control', 'Change Control', 'ضبط التغيير'], ['readiness_handover', 'Readiness & Handover', 'الجاهزية والتسليم'],
  ['as_built', 'As-Built', 'كما بُني'], ['meetings', 'Meetings', 'الاجتماعات'], ['dismantle', 'Dismantle', 'الإزالة'],
];

let cellSeq = 0;
const cell = (stage_code: string, level: number, holders: (string | MatrixAssignee)[]): MatrixCell => ({
  id: `92000000-0000-4000-8000-${String(++cellSeq).padStart(12, '0')}`, stage_code, task_code: null, level, region_id: null, rule: 'any_one',
  assignees: holders.map((h) => (typeof h === 'string' ? asUser(h) : h)),
});

/** Recomputes who holds two consecutive levels (the second is skipped for them, MX-06). */
export function recomputeSkip(m: Matrix): Matrix {
  for (const row of m.stages) {
    for (const c of row.cells) {
      const next = row.cells.find((x) => x.level === c.level + 1);
      const users = new Set(next && c.level < row.approval_levels ? next.assignees.filter((a) => a.kind === 'user').map((a) => a.ref_id) : []);
      c.skip_preview = c.assignees.filter((a) => a.kind === 'user' && users.has(a.ref_id)).map((a) => ({ id: a.ref_id, display_name: a.label, employee_id: a.employee_id ?? undefined })) as MatrixCell['skip_preview'];
    }
  }
  return m;
}

export function initialMatrix(): Matrix {
  const stages: Row[] = STAGE_CODES.map((code, i) => ({
    kind: 'stage', register_key: null, code, name_en: STAGE_NAMES[i][0], name_ar: STAGE_NAMES[i][1], approval_levels: i === 9 ? 1 : 3,
    cells: STAGE_ROWS[i][1].length === 0 && i === 9 ? [cell(code, 1, STAGE_ROWS[i][0])] : [cell(code, 1, STAGE_ROWS[i][0]), cell(code, 2, STAGE_ROWS[i][1]), cell(code, 3, STAGE_ROWS[i][2])],
  }));
  REGISTERS.forEach(([key, en, ar], i) => stages.push({
    kind: key === 'dismantle' ? 'dismantle' : 'register', register_key: key as Row['register_key'], code: key, name_en: en, name_ar: ar, approval_levels: 3,
    cells: [cell(key, 1, [['1509', '1204', '1407', '1408', '1508'][i % 5]]), cell(key, 2, ['1102']), cell(key, 3, ['1001'])],
  }));
  return recomputeSkip({ workflow_version: 1, version: 1, stages });
}

export const rowOf = (m: Matrix, code: string) => m.stages.find((s) => s.code === code);
export const holdersOf = (m: Matrix, code: string, level: number): MatrixAssignee[] => rowOf(m, code)?.cells.find((c) => c.level === level)?.assignees ?? [];
