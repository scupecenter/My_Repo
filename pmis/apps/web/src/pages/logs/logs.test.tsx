import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api, API_BASE } from '@/api/client';
import { FieldHistory } from '@/components/logs/FieldHistory';
import { Shell } from '@/components/Shell';
import { TaskDrawer } from '@/components/TaskDrawer';
import { FIRST_TASK, POWER_ON_RECORD } from '@/mocks/logsWebData';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { ActivityReport, reportCsv } from './ActivityReport';
import { AuditLog } from './AuditLog';
import { FieldChanges } from './FieldChanges';
import { Deployments, JobRuns } from './JobRuns';
import { OnlineSessions } from './OnlineSessions';
import { SecurityAlerts } from './SecurityAlerts';

const stepUpDone = () => api.post('/__mock/step-up');

describe('Audit Log screen', () => {
  it('lists entries, filters by via, shows chips and clears them', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<AuditLog />);
    const rows = await screen.findAllByTestId(/^audit-table-row-/);
    expect(rows.length).toBe(25); // first page; "Load more" brings the rest
    await u.click(screen.getByTestId('audit-table-more'));
    await waitFor(() => expect(screen.getAllByTestId(/^audit-table-row-/).length).toBe(48));
    await u.selectOptions(screen.getByTestId('f-via'), 'bulk');
    await waitFor(() => expect(screen.getAllByTestId(/^audit-table-row-/).length).toBeLessThan(10));
    for (const r of screen.getAllByTestId(/^audit-table-row-/)) expect(within(r).getByText('Bulk')).toBeInTheDocument();
    expect(screen.getByTestId('chip-via')).toBeInTheDocument();
    await u.click(screen.getByTestId('chips-clear'));
    await waitFor(() => expect(screen.queryByTestId('chip-via')).toBeNull());
    await waitFor(() => expect(screen.getAllByTestId(/^audit-table-row-/).length).toBe(48)); // the unfiltered pages are still cached
  });

  it('filters by action and by free text', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<AuditLog />);
    await screen.findAllByTestId(/^audit-table-row-/);
    await u.type(screen.getByTestId('f-q'), 'Document unreadable');
    await waitFor(() => { const r = screen.getAllByTestId(/^audit-table-row-/); expect(r.length).toBeGreaterThan(0); expect(r.length).toBeLessThan(10); });
    await u.click(screen.getByTestId('chips-clear'));
    await u.click(screen.getByTestId('f-more'));
    await u.type(screen.getByTestId('f-action'), 'settings.update');
    await waitFor(() => { const r = screen.getAllByTestId(/^audit-table-row-/); expect(r.length).toBeLessThan(10); r.forEach((x) => expect(x).toHaveTextContent('settings.update')); });
  });

  it('opens the drawer with the before/after diff, highlights only what changed, and shows device, ip, session, method and MFA', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<AuditLog />);
    const list = await screen.findAllByTestId(/^audit-table-row-/);
    const row = list.find((r) => r.textContent?.includes('task.update'))!;
    await u.click(row);
    const diff = await screen.findByTestId('audit-diff');
    expect(within(diff).getByTestId('diff-row-planned_date')).toHaveAttribute('data-changed', 'true');
    expect(within(diff).getByTestId('diff-row-state')).toHaveAttribute('data-changed', 'false');
    expect(within(diff).getByTestId('diff-before-planned_date')).not.toHaveTextContent('—');
    expect(screen.getByTestId('ad-device')).toHaveTextContent(/·/);
    expect(screen.getByTestId('ad-ip')).toHaveTextContent(/^IP10\.20\./);
    expect(screen.getByTestId('ad-session')).toHaveTextContent(/^Session9/);
    expect(screen.getByTestId('ad-auth')).toHaveTextContent(/Microsoft 365|Local account/);
    expect(screen.getByTestId('ad-mfa')).toBeInTheDocument();
  });

  it('shows "on behalf of" and the self-approval flag', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<AuditLog />);
    await screen.findAllByTestId(/^audit-table-row-/);
    expect(screen.getByTestId('flag-self-1848')).toBeInTheDocument();
    await u.click(screen.getByTestId('audit-table-row-1848'));
    expect(await screen.findByTestId('ad-self-approval')).toBeInTheDocument();
    await u.click(screen.getByTestId('audit-drawer-close'));
    // entry 4 (index 4) was done on behalf of the Project Manager
    await u.click(screen.getByTestId('audit-table-row-1846'));
    expect(await screen.findByTestId('ad-behalf')).toHaveTextContent('Ahmed Salem');
  });

  it('saves a view and applies it again', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<AuditLog />);
    await screen.findAllByTestId(/^audit-table-row-/);
    await u.selectOptions(screen.getByTestId('f-via'), 'api');
    await u.click(screen.getByTestId('views-save'));
    await u.type(screen.getByTestId('views-name'), 'API writes');
    await u.click(screen.getByTestId('views-name-ok'));
    await u.click(screen.getByTestId('chips-clear'));
    await u.selectOptions(screen.getByTestId('views-select'), screen.getByRole('option', { name: 'API writes' }));
    expect(screen.getByTestId('f-via')).toHaveValue('api');
    // P10: the view is kept on the server (mocked), never in the browser
    expect(localStorage.getItem('pmis.logviews.audit-log')).toBeNull();
  });

  it('hides and shows a column through the column control', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<AuditLog />);
    await screen.findAllByTestId(/^audit-table-row-/);
    expect(screen.queryByTestId('audit-table-head')!.querySelector('[data-col="reason"]')).toBeNull();
    await u.click(screen.getByTestId('cols-menu'));
    await u.click(await screen.findByTestId('col-toggle-reason'));
    await waitFor(() => expect(screen.getByTestId('audit-table-head').querySelector('[data-col="reason"]')).not.toBeNull());
  });

  it('runs the integrity check and lists the breaks', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<AuditLog />);
    await u.click(await screen.findByTestId('audit-integrity'));
    expect(await screen.findByTestId('integrity-status-audit')).toHaveTextContent('Intact');
    server.use(http.get(`${API_BASE}/audit-log/integrity`, () => HttpResponse.json({
      log: 'audit', status: 'broken', row_count: 1842, first_seq: 1, last_seq: 1842, head_hash: 'a1'.repeat(32), checked_at: new Date().toISOString(),
      breaks: [{ seq: 77, kind: 'previous_hash_mismatch' }, { seq: 90, kind: 'sequence_gap' }],
    })));
    await u.click(screen.getByTestId('audit-integrity'));
    await waitFor(() => expect(screen.getByTestId('integrity-status-audit')).toHaveTextContent('Broken'));
    expect(screen.getByTestId('integrity-breaks-audit')).toHaveTextContent('2');
    expect(screen.getByTestId('integrity-break-list-audit')).toHaveTextContent('#77');
  });

  it('exports through the export job and says so', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<AuditLog />);
    await u.click(await screen.findByTestId('audit-export'));
    await waitFor(() => expect(screen.getByTestId('toast')).toHaveTextContent('Export downloaded'), { timeout: 5000 });
  });

  it('is readable in Arabic and the auditor (view_audit) sees no integrity button', async () => {
    await signIn('auditor');
    renderApp(<AuditLog />, { locale: 'ar' });
    await screen.findAllByTestId(/^audit-table-row-/);
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('سجل');
    expect(screen.queryByTestId('audit-integrity')).toBeNull();
  });

  it('a person without the audit right gets a 403 from the API', async () => {
    await signIn('engineer');
    await expect(api.get('/audit-log')).rejects.toMatchObject({ status: 403 });
  });
});

describe('Field changes screen', () => {
  it('answers: who changed the Power-On date, from what to what, when, from which device', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<FieldChanges />);
    await screen.findAllByTestId(/^fc-table-row-/);
    await u.click(screen.getByTestId('f-more'));
    await u.type(screen.getByTestId('f-entity-id'), POWER_ON_RECORD);
    await u.type(screen.getByTestId('f-field'), 'power_on_date');
    await waitFor(() => expect(screen.getAllByTestId(/^fc-table-row-/)).toHaveLength(3));
    expect(screen.getByTestId('fc-old-fc-002')).toHaveTextContent('2026-10-27');
    expect(screen.getByTestId('fc-new-fc-002')).toHaveTextContent('2026-11-03');
    const top = screen.getByTestId('fc-table-row-fc-002');
    expect(within(top).getByText('Ahmed Salem')).toBeInTheDocument();
    await u.click(top);
    expect(await screen.findByTestId('fc-device')).toHaveTextContent(/Chrome|Safari|Edge|Firefox/);
    expect(screen.getByTestId('fc-ip')).toHaveTextContent('10.20.');
    expect(screen.getByTestId('fc-via')).toBeInTheDocument();
  });

  it('filters by who, entity id and via', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<FieldChanges />);
    await screen.findAllByTestId(/^fc-table-row-/);
    await u.click(screen.getByTestId('f-more'));
    await u.type(screen.getByTestId('f-entity-id'), POWER_ON_RECORD);
    await waitFor(() => expect(screen.getAllByTestId(/^fc-table-row-/)).toHaveLength(3));
    await u.selectOptions(screen.getByTestId('f-via'), 'template');
    await waitFor(() => expect(screen.getAllByTestId(/^fc-table-row-/)).toHaveLength(1));
    await u.click(screen.getByTestId('chips-clear'));
    await u.type(screen.getByTestId('f-who-search'), 'Mona');
    await u.click(await screen.findByTestId('f-who-opt-1102'));
    await waitFor(() => { const r = screen.getAllByTestId(/^fc-table-row-/); r.forEach((x) => expect(x).toHaveTextContent('Mona Fathi')); });
  });
});

describe('History of this field', () => {
  const history = () => renderApp(<FieldHistory entityType="register_record" entityId={POWER_ON_RECORD} field="power_on_date" label="Power-On date" />);

  it('fetches only when opened, then lists old to new, who, when, device and via', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    const seen: string[] = [];
    const on = ({ request }: { request: Request }) => { if (request.url.includes('field-history')) seen.push(request.url); };
    server.events.on('request:start', on);
    try {
      history();
      const btn = await screen.findByTestId('field-history-power_on_date');
      expect(seen).toHaveLength(0);
      await u.click(btn);
      const list = await screen.findByTestId('fh-list');
      expect(seen).toHaveLength(1);
      const items = within(list).getAllByTestId(/^fh-item-/);
      expect(items).toHaveLength(3);
      expect(items[0]).toHaveTextContent('2026-10-27');
      expect(items[0]).toHaveTextContent('2026-11-03');
      expect(items[0]).toHaveTextContent('Ahmed Salem');
      expect(within(items[0]).getByTestId('person-id-1001')).toBeInTheDocument();
      expect(within(items[0]).getByTestId('fh-device-fc-002')).toHaveAttribute('aria-label', expect.stringMatching(/·/));
      expect(items[1]).toHaveTextContent('Template');
    } finally { server.events.removeListener('request:start', on); }
  });

  it('shows nothing to a person who cannot read the Audit Log', async () => {
    await signIn('engineer');
    history();
    await new Promise((r) => setTimeout(r, 150));
    await screen.findByTestId('field-history-power_on_date').then(
      () => { throw new Error('icon must be hidden'); },
      () => undefined,
    );
  });

  it('says so when a field has no recorded changes', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<FieldHistory entityType="task" entityId="10000000-0000-4000-8000-000000000099" field="planned_date" />);
    await u.click(await screen.findByTestId('field-history-planned_date'));
    expect(await screen.findByTestId('fh-empty')).toBeInTheDocument();
  });
});

describe('History icon in the task drawer', () => {
  it('sits beside each date for an Audit Log reader and opens the changes of that date', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<TaskDrawer taskId={FIRST_TASK} onClose={() => undefined} />);
    await u.click(await screen.findByTestId('field-history-planned_date'));
    const items = await screen.findAllByTestId(/^fh-item-/);
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('2026-10-14');
    expect(items[0]).toHaveTextContent('2026-10-21');
  });

  it('is absent for a person without the audit right', async () => {
    await signIn('engineer');
    renderApp(<TaskDrawer taskId={FIRST_TASK} onClose={() => undefined} />);
    await screen.findByTestId('drawer-plan-date');
    expect(screen.queryByTestId('field-history-planned_date')).toBeNull();
  });
});

describe('Online now (sessions)', () => {
  it('ends a session with a reason after step-up and removes the row', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<OnlineSessions />);
    const rows = await screen.findAllByTestId(/^asession-/);
    expect(rows).toHaveLength(5);
    expect(screen.queryByTestId('session-end-90000000-0000-4000-8000-000000001000')).toBeNull(); // own session
    await stepUpDone();
    await u.click(screen.getByTestId('session-end-90000000-0000-4000-8000-000000001002'));
    await u.type(await screen.findByTestId('end-session-dialog-reason'), 'ab');
    await u.click(screen.getByTestId('end-session-dialog-submit'));
    expect(await screen.findByTestId('end-session-dialog-reason-error')).toBeInTheDocument();
    await u.type(screen.getByTestId('end-session-dialog-reason'), 'c shared device');
    await u.click(screen.getByTestId('end-session-dialog-submit'));
    await waitFor(() => expect(screen.queryByTestId('asession-90000000-0000-4000-8000-000000001002')).toBeNull());
    expect(screen.getAllByTestId(/^asession-/)).toHaveLength(4);
  });

  it('rolls the row back when the server refuses', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    server.use(http.post(`${API_BASE}/admin/sessions/:id/end`, () => HttpResponse.json({ type: 'x', title: 'no', status: 403, code: 'action_forbidden' }, { status: 403 })));
    renderApp(<OnlineSessions />);
    await screen.findAllByTestId(/^asession-/);
    await u.click(screen.getByTestId('session-end-90000000-0000-4000-8000-000000001003'));
    await u.type(await screen.findByTestId('end-session-dialog-reason'), 'Left unlocked');
    await u.click(screen.getByTestId('end-session-dialog-submit'));
    expect(await screen.findByTestId('end-session-dialog-error')).toBeInTheDocument();
    expect(screen.getByTestId('asession-90000000-0000-4000-8000-000000001003')).toBeInTheDocument();
  });
});

describe('Security alerts', () => {
  it('filters open / acknowledged and acknowledges with a note', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<SecurityAlerts />);
    await screen.findByTestId('alert-al-1');
    expect(screen.getAllByTestId(/^alert-al-\d$/)).toHaveLength(3);
    await u.click(screen.getByTestId('alert-ack-al-1'));
    await u.type(await screen.findByTestId('ack-dialog-reason'), 'Checked with the owner of 10.20.2.90');
    await u.click(screen.getByTestId('ack-dialog-submit'));
    await waitFor(() => expect(screen.queryByTestId('alert-al-1')).toBeNull());
    await u.click(screen.getByTestId('alerts-filter-acknowledged'));
    await waitFor(() => expect(screen.getAllByTestId(/^alert-al-\d$/)).toHaveLength(3));
    expect(screen.getByTestId('alert-status-al-1')).toHaveTextContent('Acknowledged');
    expect(screen.getByTestId('alert-al-1')).toHaveTextContent('Ahmed Salem');
  });

  it('keeps the alert open when the acknowledgement fails', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    server.use(http.post(`${API_BASE}/admin/security-alerts/:id/ack`, () => HttpResponse.json({ type: 'x', title: 'no', status: 500, code: 'unknown' }, { status: 500 })));
    renderApp(<SecurityAlerts />);
    await u.click(await screen.findByTestId('alert-ack-al-2'));
    await u.type(await screen.findByTestId('ack-dialog-reason'), 'Reviewed');
    await u.click(screen.getByTestId('ack-dialog-submit'));
    expect(await screen.findByTestId('ack-dialog-error')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('alert-status-al-2')).toHaveTextContent('Open'));
  });
});

describe('Job runs and deployments', () => {
  it('lists job runs with outcomes and pages', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<JobRuns />);
    await screen.findByTestId('job-job-1');
    expect(screen.getByTestId('job-outcome-job-1')).toHaveTextContent('Running');
    expect(screen.getByTestId('job-outcome-job-5')).toHaveTextContent('Failed');
    expect(screen.getAllByTestId(/^job-job-/)).toHaveLength(25);
    await u.click(screen.getByTestId('jobs-more'));
    await waitFor(() => expect(screen.getAllByTestId(/^job-job-/)).toHaveLength(30));
  });

  it('lists deployments with version, sha and migrations', async () => {
    await signIn('pm');
    renderApp(<Deployments />);
    const row = await screen.findByTestId('deployment-dep-8');
    expect(row).toHaveTextContent('0.12.0');
    expect(row).toHaveTextContent('_logs_field_changes.sql');
  });
});

describe('Monthly activity report', () => {
  it('shows the per-user table and sensitive changes, changes month, and exports a safe CSV', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<ActivityReport />);
    await screen.findByTestId('report-user-1001');
    expect(screen.getAllByTestId(/^report-user-/)).toHaveLength(5);
    expect(screen.getAllByTestId(/^report-sens-/).length).toBeGreaterThan(0);
    const before = screen.getByTestId('report-user-1001').textContent;
    const month = screen.getByTestId('report-month');
    fireEvent.change(month, { target: { value: '2026-08' } });
    await waitFor(() => expect(screen.getByTestId('report-user-1001').textContent).not.toBe(before));
    expect(screen.getByTestId('report-sens-0')).toHaveTextContent('2026-08-03');
    let blob: Blob | null = null;
    URL.createObjectURL = (b: Blob | MediaSource) => { blob = b as Blob; return 'blob:x'; };
    URL.revokeObjectURL = () => undefined;
    await u.click(screen.getByTestId('report-csv'));
    const text = await (blob as unknown as Blob).text();
    expect(text).toContain('employee_id,name,actions');
    expect(text).toContain('Ahmed Salem');
  });

  it('neutralises spreadsheet formulas in the CSV', () => {
    const csv = reportCsv({ month: '2026-10', users: [{ user: { id: 'x', display_name: '=HYPERLINK("http://x")', employee_id: '1' }, actions: 1, field_changes: 2, approvals: 3, sign_ins: 4, failed_sign_ins: 5 }], sensitive: [] });
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
  });
});

describe('Navigation: Logs & monitoring', () => {
  const app = (locale: 'en' | 'ar' = 'en') => renderApp(<Routes><Route element={<Shell />}><Route path="*" element={<div />} /></Route></Routes>, { route: '/my-work', locale });

  it('shows the section and the open-alert badge to an admin', async () => {
    await signIn('pm');
    app();
    await screen.findByTestId('nav-group-logs');
    for (const k of ['audit', 'logs.field_changes', 'admin.security_log', 'logs.online', 'logs.alerts', 'logs.job_runs', 'logs.deployments', 'logs.activity_report']) expect(screen.getByTestId(`nav-${k}`)).toBeInTheDocument();
    expect(await screen.findByTestId('alerts-badge')).toHaveTextContent('3');
  });

  it('shows an auditor only what the grants allow', async () => {
    await signIn('auditor');
    app();
    await screen.findByTestId('nav-group-logs');
    expect(screen.getByTestId('nav-audit')).toBeInTheDocument();
    expect(screen.getByTestId('nav-logs.field_changes')).toBeInTheDocument();
    expect(screen.getByTestId('nav-admin.security_log')).toBeInTheDocument();
    for (const k of ['logs.online', 'logs.alerts', 'logs.job_runs', 'logs.deployments']) expect(screen.queryByTestId(`nav-${k}`)).toBeNull();
    expect(screen.queryByTestId('alerts-badge')).toBeNull();
  });

  it('shows no logs section to an engineer', async () => {
    await signIn('engineer');
    app();
    await screen.findByTestId('nav-my_work');
    expect(screen.queryByTestId('nav-group-logs')).toBeNull();
    cleanup();
  });
});
