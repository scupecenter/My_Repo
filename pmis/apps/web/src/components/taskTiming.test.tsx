import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { TaskSummary } from '@/api/types';
import { Approvals } from '@/pages/Approvals';
import { MyWork } from '@/pages/MyWork';
import { renderApp, signIn } from '@/test/utils';
import { TaskGrid } from './TaskGrid';
import { sortByTiming } from './TaskTiming';

/** F2 (contract 0.15.30): ball in court with its working days, the SLA overrun in working days with its colour, the stale badge, and the filters. */
const holder = (id: string, label: string) => ({ kind: 'user' as const, ref_id: id, user_id: id, label, employee_id: id.slice(-4) });
const mk = (id: string, o: { colour: 'green' | 'amber' | 'red'; elapsed: number; late: number; left: number | null; held: number; stale: boolean; who: ReturnType<typeof holder> }): TaskSummary => ({
  id, site_id: 's-f2', site_code: 'F2-SYN', task_code: id.toUpperCase(), name_en: `Task ${id}`, name_ar: `مهمة ${id}`, stage_code: 'MS1', state: 'entry', version: 1,
  current_level: 1, levels_required: 2, planned_date: null, actual_date: null, slots_filled: 0, slots_required: 0, return_count: 0, lock_reasons: [],
  ball_in_court: { level: 1, level_kind: 'entry', holders: [o.who], since: '2026-11-10T10:00:00.000Z', held_wd: o.held },
  sla: { min_wd: 3, max_wd: 5, elapsed_wd: o.elapsed, colour: o.colour, late_wd: o.late, left_wd: o.left, measured: true },
  idle_working_days: o.stale ? 4 : 0, stale: o.stale, stale_after_wd: 2, last_activity_at: '2026-11-10T10:00:00.000Z',
});
const A = holder('00000000-0000-4000-8000-000000001101', 'Alia Synthetic');
const B = holder('00000000-0000-4000-8000-000000001102', 'Bashir Synthetic');
const tasks = [
  mk('t1', { colour: 'green', elapsed: 1, late: 0, left: 4, held: 1, stale: false, who: A }),
  mk('t2', { colour: 'amber', elapsed: 4, late: 0, left: 1, held: 6, stale: true, who: B }),
  mk('t3', { colour: 'red', elapsed: 8, late: 3, left: 0, held: 3, stale: false, who: A }),
];
const grid = (locale: 'en' | 'ar' = 'en') =>
  renderApp(<TaskGrid siteId="s-f2" stages={[{ code: 'MS1', name_en: 'Site Release', name_ar: 'تسليم الموقع', tasks }]} selected={null} onVisible={() => undefined} onOpen={() => undefined} />, { locale });
const order = () => screen.getAllByTestId(/^grid-row-/).map((r) => r.getAttribute('data-testid')!.replace('grid-row-', ''));

describe('F2 in the task grid', () => {
  it('shows "+N wd late" and "N wd left" in the SLA colour, the ball since and its working days, and the stale badge (EN)', async () => {
    await signIn('pm');
    grid();
    expect(await screen.findByTestId('overrun-t3')).toHaveTextContent('+3 wd late');
    expect(screen.getByTestId('overrun-t3')).toHaveAttribute('data-colour', 'red');
    expect(screen.getByTestId('overrun-t2')).toHaveTextContent('1 wd left');
    expect(screen.getByTestId('overrun-t2')).toHaveAttribute('data-colour', 'amber');
    expect(screen.getByTestId('overrun-t1')).toHaveAttribute('data-colour', 'green');
    expect(screen.getByTestId('ball-since-t2')).toHaveTextContent('6 wd');
    expect(screen.getByTestId('ball-since-t2')).toHaveTextContent('2026-11-10');
    expect(screen.getByTestId('stale-t2')).toHaveTextContent('Stale');
    expect(screen.getByTestId('stale-t2')).toHaveAttribute('title', 'No activity for 4 working days (limit 2).');
    expect(screen.queryByTestId('stale-t1')).not.toBeInTheDocument();
  }, 30_000);

  it('filters by stale, near the limit and ball holder, and sorts by held time and overrun', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    grid();
    await screen.findByTestId('grid-row-t1');
    await u.click(screen.getByTestId('tf-stale'));
    expect(order()).toEqual(['t2']);
    await u.click(screen.getByTestId('tf-stale'));
    await u.click(screen.getByTestId('tf-amber'));
    expect(order()).toEqual(['t2']);
    await u.click(screen.getByTestId('tf-amber'));
    await u.selectOptions(screen.getByTestId('tf-holder'), A.ref_id);
    expect(order()).toEqual(['t1', 't3']);
    await u.selectOptions(screen.getByTestId('tf-holder'), '');
    await u.selectOptions(screen.getByTestId('tf-sort'), 'held');
    expect(order()).toEqual(['t2', 't3', 't1']);
    await u.selectOptions(screen.getByTestId('tf-sort'), 'overrun');
    expect(order()).toEqual(['t3', 't2', 't1']);
  }, 30_000);

  it('reads in Arabic, right to left', async () => {
    await signIn('pm');
    grid('ar');
    expect(await screen.findByTestId('overrun-t3')).toHaveTextContent('متأخرة 3 يوم عمل');
    expect(screen.getByTestId('overrun-t2')).toHaveTextContent('متبقٍّ 1 يوم عمل');
    expect(screen.getByTestId('stale-t2')).toHaveTextContent('راكدة');
    expect(screen.getByTestId('ball-since-t2')).toHaveTextContent('6 يوم عمل');
    expect(document.documentElement.dir).toBe('rtl');
  }, 30_000);
});

describe('F2 sort helper', () => {
  it('puts the most overdue first and keeps the server order on ties', () => {
    expect(sortByTiming(tasks, 'overrun', (x) => x).map((x) => x.id)).toEqual(['t3', 't2', 't1']);
    expect(sortByTiming(tasks, '', (x) => x).map((x) => x.id)).toEqual(['t1', 't2', 't3']);
  });
});

describe('F2 in Approvals and My Work', () => {
  it('Approvals: the overrun and the ball since show in the list and the detail; the colour and stale filters go to the server', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<Approvals />);
    const list = await screen.findByTestId('approvals-list');
    await waitFor(() => expect(within(list).getAllByRole('listitem').length).toBeGreaterThan(1));
    const first = within(list).getAllByRole('listitem')[0]!;
    expect(within(first).getByTestId(/^overrun-/)).toHaveTextContent('3 wd left');
    expect(within(first).getByTestId(/^ball-since-/)).toHaveTextContent('wd');
    await u.click(within(first).getByTestId(/^approval-open-/));
    expect(await screen.findByTestId('approval-overrun')).toHaveTextContent('3 wd left');
    // every mock inbox task is green: Late shows nothing, Within target all of them
    await u.click(screen.getByTestId('approvals-colour-red'));
    expect(await screen.findByTestId('approvals-empty')).toBeInTheDocument();
    await u.click(screen.getByTestId('approvals-colour-red'));
    await u.click(screen.getByTestId('approvals-stale'));
    expect(await screen.findByTestId('approvals-empty')).toBeInTheDocument();
  }, 30_000);

  it('My Work (AR): the late card shows how late it is in working days and the stale badge', async () => {
    await signIn('pm');
    renderApp(<MyWork />, { locale: 'ar' });
    const late = await screen.findByTestId('my-work-bucket-late');
    await waitFor(() => expect(within(late).getAllByTestId(/^overrun-/).length).toBe(1));
    expect(within(late).getByTestId(/^overrun-/)).toHaveTextContent('متأخرة 2 يوم عمل');
    expect(within(late).getByTestId(/^stale-/)).toHaveTextContent('راكدة');
  }, 30_000);
});
