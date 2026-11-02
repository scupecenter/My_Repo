// Seed data of the phase 4b mocks (inbox, follows, weekly status updates). Synthetic; the weeks follow today's date so "this week" is always editable.
import type { Comment, Follow, Notification, StatusUpdate } from '@/api/types';
import { tripoliToday } from '@/lib/today';
import { weekStartOf } from '@/lib/x';
import { staffRef } from './ids';
import { STAFF } from './staff';

const addDays = (day: string, n: number) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const person = (emp: string) => staffRef(STAFF.find((s) => s.employee_id === emp)!);

export function seedStatuses(): StatusUpdate[] {
  const week = weekStartOf(tripoliToday());
  const last = addDays(week, -7);
  const at = new Date().toISOString();
  const base = { created_at: at, updated_at: at, version: 1, editable: false };
  return [
    { ...base, id: '40000000-0000-4000-8000-000000000001', scope: 'region', region_id: 1, team: null, week_start: week, week_end: addDays(week, 6), health: 'on_track', summary: 'Civil works on plan in Tripoli. Three sites reach CW PAC this week.', author: person('1001') },
    { ...base, id: '40000000-0000-4000-8000-000000000002', scope: 'region', region_id: 5, team: null, week_start: week, week_end: addDays(week, 6), health: 'at_risk', summary: 'Benghazi: two sites wait for the access permit; TE installation may slip a week.', author: person('1102') },
    { ...base, id: '40000000-0000-4000-8000-000000000003', scope: 'team', region_id: null, team: 'cw', week_start: last, week_end: addDays(last, 6), health: 'off_track', summary: 'CW team: contractor capacity is short in the west; mitigation agreed with the contractor.', author: person('1001') },
  ];
}

const TASK1 = '10000000-0000-4000-8000-000000000001';
const TASK2 = '10000000-0000-4000-8000-000000000002';

/** The first two are the ones the mock always had; the others show a mention, a followed change and a snoozed item. */
export function seedNotifications(): Notification[] {
  return [
    { id: '30000000-0000-4000-8000-000000000001', kind: 'approval_due', title: 'WM105 D14 waits for your approval', created_at: '2026-10-24T08:30:00Z', read_at: null, link: '/approvals' },
    { id: '30000000-0000-4000-8000-000000000002', kind: 'task_returned', title: 'ZW310 B6 was returned with a note', created_at: '2026-10-23T10:00:00Z', read_at: null, link: '/my-work' },
    { id: '30000000-0000-4000-8000-000000000003', kind: 'mention', title: 'You were mentioned', body: 'WM105 / D14 PAT · NOC alarms: @1001 please check the NOC alarms before approval', entity_type: 'task', entity_id: TASK1, created_at: '2026-10-23T09:00:00Z', read_at: null, link: `/tasks/${TASK1}` },
    { id: '30000000-0000-4000-8000-000000000004', kind: 'followed_change', title: 'A followed site changed', body: 'GM117 / A2 TSSR approval: submit', entity_type: 'task', entity_id: TASK2, created_at: '2026-10-22T12:00:00Z', read_at: '2026-10-22T13:00:00Z', link: `/tasks/${TASK2}` },
    { id: '30000000-0000-4000-8000-000000000005', kind: 'system', title: 'Holiday dates are tentative', created_at: '2026-10-21T07:00:00Z', read_at: null, snoozed_until: '2099-01-01T00:00:00Z', link: '/admin/settings/calendar' },
  ] as Notification[];
}

export function initX() {
  return { follows: [] as Follow[], statuses: seedStatuses(), regComments: {} as Record<string, Comment[]> };
}
