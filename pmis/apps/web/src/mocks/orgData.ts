// Synthetic state for departments, the direct manager, messages and announcements (contract 0.4.0). Lives inside the mock db.
// Everything is keyed by the user's UUID (the demo accounts' ids come from `uid(employee_id)`).
import type { AnnouncementAudience } from '@/api/types';
import { uid } from './ids';
import { STAFF } from './staff';

export type MockDept = { id: string; code: string; name_en: string; name_ar: string | null; is_active: boolean };
export type MockMsg = { id: string; author: string; body: string; created_at: string };
export type MockThreadRow = { id: string; subject: string; a: string; b: string; started_by: string; original: MockMsg; replies: MockMsg[]; read: Record<string, string | null> };
export type MockAnnRow = {
  id: string; title: string; body: string; created_at: string; created_by: string; audience: AnnouncementAudience; recipients: string[];
  answers: Record<string, { decision: 'agree' | 'disagree'; note: string | null; at: string }>;
};

const did = (n: number) => `96000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const DEPARTMENTS: MockDept[] = [
  { id: did(1), code: 'PMO', name_en: 'Project Management Office', name_ar: 'مكتب إدارة المشروع', is_active: true },
  { id: did(2), code: 'RF_DESIGN', name_en: 'RF & Design', name_ar: 'التصميم والترددات', is_active: true },
  { id: did(3), code: 'CIVIL', name_en: 'Civil Works', name_ar: 'الأعمال المدنية', is_active: true },
  { id: did(4), code: 'TE_OPS', name_en: 'Telecom Equipment', name_ar: 'معدات الاتصالات', is_active: true },
  { id: did(5), code: 'SUPPORT', name_en: 'Project Support', name_ar: 'دعم المشروع', is_active: true },
  { id: did(6), code: 'WAREHOUSE', name_en: 'Warehouse', name_ar: 'المخازن', is_active: true },
  { id: did(7), code: 'LEGACY', name_en: 'Legacy Unit', name_ar: 'وحدة سابقة', is_active: false },
];

/** [employee, manager, department number]; the chain ends at the Project Manager. */
const CHAIN: [string, string | null, number][] = [
  ['1001', null, 1],
  ['1102', '1001', 2], ['1103', '1102', 2], ['1104', '1102', 2],
  ['1203', '1001', 3], ['1204', '1203', 3], ['1205', '1203', 3], ['1206', '1203', 3], ['1207', '1203', 3], ['1208', '1203', 3], ['1209', '1203', 3], ['1210', '1203', 3], ['1211', '1203', 3], ['1999', '1203', 3],
  ['1305', '1001', 4], ['1306', '1305', 4], ['1307', '1305', 4], ['1308', '1305', 4], ['1309', '1305', 4], ['1310', '1305', 4],
  ['1508', '1001', 5], ['1509', '1508', 5], ['1510', '1508', 5],
  ['1407', '1001', 6], ['1408', '1407', 6],
];

const m = (id: string, author: string, body: string, at: string): MockMsg => ({ id: `98000000-0000-4000-8000-${id.padStart(12, '0')}`, author: uid(author), body, created_at: at });

export function initOrg() {
  const managers: Record<string, string | null> = {}, deptOf: Record<string, string | null> = {};
  for (const [e, mgr, d] of CHAIN) { managers[uid(e)] = mgr ? uid(mgr) : null; deptOf[uid(e)] = did(d); }

  const threads: MockThreadRow[] = [
    {
      id: '97000000-0000-4000-8000-000000000001', subject: 'Site visit schedule for Tripoli', a: uid('1103'), b: uid('1102'), started_by: uid('1103'),
      original: m('1', '1103', 'Hello Mona,\nI plan the Tripoli site visits for next week.\nCan you confirm the order?', '2026-10-26T08:00:00Z'),
      replies: [m('2', '1102', 'Start with WM105, then GM117.', '2026-10-26T09:30:00Z'), m('3', '1103', 'Understood, thank you.', '2026-10-27T07:45:00Z')],
      read: { [uid('1103')]: '2026-10-27T07:45:00Z', [uid('1102')]: '2026-10-26T09:30:00Z' },
    },
    {
      id: '97000000-0000-4000-8000-000000000002', subject: 'Weekly report format', a: uid('1001'), b: uid('1102'), started_by: uid('1001'),
      original: m('4', '1001', 'Please send the weekly report in the new format from Sunday.', '2026-10-27T10:00:00Z'), replies: [],
      read: { [uid('1001')]: '2026-10-27T10:00:00Z', [uid('1102')]: null },
    },
    {
      id: '97000000-0000-4000-8000-000000000003', subject: 'Access permit for ZW310', a: uid('1204'), b: uid('1203'), started_by: uid('1204'),
      original: m('5', '1204', 'The access permit for ZW310 is still missing.\nCould you chase the owner?', '2026-10-27T12:00:00Z'), replies: [m('6', '1203', 'I called him today. Expect it tomorrow.', '2026-10-27T15:10:00Z')],
      read: { [uid('1204')]: '2026-10-27T12:00:00Z', [uid('1203')]: '2026-10-27T15:10:00Z' },
    },
  ];

  // One sent announcement, answered by nearly everyone; Sami Nuri (1204) and Anis Gharyani (1310) have not answered yet.
  const recipients = STAFF.filter((s) => s.status === 'active' && !['1001', '1210', '1211'].includes(s.employee_id)).map((s) => uid(s.employee_id));
  const answers: MockAnnRow['answers'] = {};
  recipients.forEach((r, i) => {
    if (r === uid('1204') || r === uid('1310')) return;
    answers[r] = r === uid('1306') ? { decision: 'disagree', note: 'The new hours clash with the night shift.', at: '2026-10-25T09:00:00Z' } : { decision: 'agree', note: null, at: `2026-10-25T08:${String(10 + i).padStart(2, '0')}:00Z` };
  });
  const announcements: MockAnnRow[] = [{
    id: '99000000-0000-4000-8000-000000000001', title: 'Updated site access rules', created_at: '2026-10-24T09:00:00Z', created_by: uid('1001'), audience: { all: true }, recipients, answers,
    body: 'From Sunday every site visit needs the access permit number in the task comment.\nPlease read the rules and confirm.',
  }];
  return { departments: DEPARTMENTS.map((d) => ({ ...d })), managers, deptOf, threads, announcements };
}
export type OrgDb = ReturnType<typeof initOrg>;
