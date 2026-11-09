import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { sysQuery, EMPTY_SYS_FILTER } from '@/api/logs';
import { Shell } from '@/components/Shell';
import { ACCOUNTS } from '@/mocks/db';
import { renderApp, signIn } from '@/test/utils';
import { entryText, systemLogCsv, SystemLog, tripoliStamp } from './SystemLog';

/** The System Log screen (owner request 2026-11-09, contract 0.15.2, migration 0082). */
const rows = () => screen.getAllByTestId(/^syslog-table-row-/);
const shell = (locale: 'en' | 'ar' = 'en') =>
  renderApp(<Routes><Route element={<Shell />}><Route path="*" element={<div />} /></Route></Routes>, { route: '/my-work', locale });

/** Gives the synthetic auditor `view` on admin.system_log for one test (the mock derives the grants of /me and of GET /system-log from it). */
async function withSystemLogGrant(fn: () => Promise<void>) {
  const nav = ACCOUNTS.auditor!.nav;
  nav.push('admin.system_log');
  try { await fn(); } finally { nav.splice(nav.indexOf('admin.system_log'), 1); }
}

describe('System Log: the side menu entry', () => {
  it('shows "System Log" in Logs & monitoring, right after the Security log, to a System Admin', async () => {
    await signIn('pm');
    shell();
    const group = await screen.findByTestId('nav-group-logs');
    const link = within(group).getByTestId('nav-logs.system');
    expect(link).toHaveTextContent('System Log');
    expect(link).toHaveAttribute('href', '/admin/logs/system');
    const keys = [...group.querySelectorAll('a[data-testid^="nav-"]')].map((a) => a.getAttribute('data-testid'));
    expect(keys.indexOf('nav-logs.system')).toBe(keys.indexOf('nav-admin.security_log') + 1);
  }, 30_000);

  it('is hidden from a user without the right, and shows with view on admin.system_log (Arabic label)', async () => {
    await signIn('auditor');
    const a = shell();
    await screen.findByTestId('nav-admin.security_log');
    expect(screen.queryByTestId('nav-logs.system')).toBeNull();
    a.unmount();
    await withSystemLogGrant(async () => {
      shell('ar');
      expect(await screen.findByTestId('nav-logs.system')).toHaveTextContent('سجل النظام');
    });
  }, 30_000);

  it('is hidden from an engineer', async () => {
    await signIn('engineer');
    shell();
    await screen.findByTestId('nav-my_work');
    expect(screen.queryByTestId('nav-logs.system')).toBeNull();
  }, 30_000);
});

describe('System Log: the page', () => {
  it('lists the rows newest first with time (Tripoli), level, source, message, user with employee ID and request ID', async () => {
    await signIn('pm');
    renderApp(<SystemLog />);
    await waitFor(() => expect(rows().length).toBe(6));
    const first = rows()[0]!;
    expect(first).toHaveAttribute('data-testid', 'syslog-table-row-81');
    expect(first).toHaveTextContent('2026-11-09 10:12:44'); // 08:12:44Z on the Tripoli clock (UTC+2)
    expect(within(first).getByTestId('syslog-level-81')).toHaveTextContent('Warning');
    expect(first).toHaveTextContent('template-check');
    expect(first).toHaveTextContent('template upload rejected: not_xlsx');
    expect(first).toHaveTextContent('1204'); // the employee ID beside the name
    expect(first).toHaveTextContent('req-81a');
    expect(screen.getByTestId('syslog-count')).toHaveTextContent('6 shown');
  }, 30_000);

  it('filters by level, by source and by text in the message, with removable chips', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<SystemLog />);
    await waitFor(() => expect(rows().length).toBe(6));
    await u.selectOptions(screen.getByTestId('syslog-level'), 'error');
    await waitFor(() => expect(rows().map((r) => r.getAttribute('data-testid'))).toEqual(['syslog-table-row-80', 'syslog-table-row-76']));
    expect(screen.getByTestId('chip-level')).toHaveTextContent('Error');
    await u.click(screen.getByTestId('chip-remove-level'));
    await u.type(screen.getByTestId('syslog-source'), 'template-check');
    await waitFor(() => expect(rows().map((r) => r.getAttribute('data-testid'))).toEqual(['syslog-table-row-81', 'syslog-table-row-78']));
    await u.type(screen.getByTestId('syslog-q'), 'NOT_XLSX');
    await waitFor(() => expect(rows().map((r) => r.getAttribute('data-testid'))).toEqual(['syslog-table-row-81']));
    await u.click(screen.getByTestId('chips-clear'));
    await waitFor(() => expect(rows().length).toBe(6));
  }, 30_000);

  it('opens the drawer with the full message and the context as a key/value list, never as markup, and copies the row', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });
    renderApp(<SystemLog />);
    await waitFor(() => expect(rows().length).toBe(6));
    await u.click(screen.getByTestId('syslog-table-row-81'));
    const body = await screen.findByTestId('syslog-drawer-body');
    expect(within(body).getByTestId('syslog-message')).toHaveTextContent('template upload rejected: not_xlsx');
    for (const k of ['reason', 'detail', 'load_error', 'file_name', 'size', 'template']) expect(within(body).getByTestId(`syslog-ctx-${k}`)).toBeInTheDocument();
    expect(within(body).getByTestId('syslog-ctx-val-load_error')).toHaveTextContent('End of data reached');
    expect(within(body).getByTestId('syslog-ctx-val-reason')).toHaveTextContent('not_xlsx');
    expect(within(body).getByTestId('syslog-ctx-val-size')).toHaveTextContent('48213');
    // the file name holds markup: shown as text, no element is made from it
    expect(within(body).getByTestId('syslog-ctx-val-file_name').textContent).toBe('GECOL_Tripoli_<b>week45</b>.xlsx');
    expect(within(body).getByTestId('syslog-ctx-val-file_name').querySelector('b')).toBeNull();
    // a nested value is pretty JSON
    expect(within(body).getByTestId('syslog-ctx-val-template').tagName).toBe('PRE');
    expect(within(body).getByTestId('syslog-ctx-val-template').textContent).toBe(JSON.stringify({ code: 'TPL-GECOL', version: 3 }, null, 2));
    await u.click(within(body).getByTestId('syslog-copy'));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    const copied = JSON.parse(write.mock.calls[0]![0] as string);
    expect(copied).toMatchObject({ id: 81, message: 'template upload rejected: not_xlsx', context: { load_error: expect.stringContaining('End of data'), reason: 'not_xlsx' } });
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  }, 30_000);

  it('a row without context says so', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<SystemLog />);
    await waitFor(() => expect(rows().length).toBe(6));
    await u.click(screen.getByTestId('syslog-table-row-76'));
    expect(await screen.findByTestId('syslog-ctx-empty')).toHaveTextContent('No context was stored.');
  }, 30_000);

  it('is in Arabic, right to left, with the same data', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<SystemLog />, { locale: 'ar' });
    await waitFor(() => expect(rows().length).toBe(6));
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('سجل النظام');
    expect(screen.getByTestId('syslog-level-81')).toHaveTextContent('تحذير');
    await u.click(screen.getByTestId('syslog-table-row-81'));
    const body = await screen.findByTestId('syslog-drawer-body');
    expect(within(body).getByText('السياق')).toBeInTheDocument();
    expect(within(body).getByTestId('syslog-ctx-load_error')).toBeInTheDocument();
  }, 30_000);

  it('a holder of view on admin.system_log reads it; anyone else sees the error state', async () => {
    await signIn('auditor');
    const a = renderApp(<SystemLog />);
    expect(await screen.findByTestId('state-error')).toBeInTheDocument();
    a.unmount();
    await withSystemLogGrant(async () => {
      renderApp(<SystemLog />);
      await waitFor(() => expect(rows().length).toBe(6));
    });
  }, 30_000);
});

describe('System Log: helpers', () => {
  it('sends Tripoli calendar days: from the start of the day, to the start of the next day (exclusive)', () => {
    expect(sysQuery({ ...EMPTY_SYS_FILTER, from: '2026-11-09', to: '2026-11-09', source: ' mail ', q: ' x ' }))
      .toEqual({ level: '', source: 'mail', q: 'x', from: '2026-11-09T00:00:00+02:00', to: '2026-11-10T00:00:00+02:00' });
    expect(sysQuery({ ...EMPTY_SYS_FILTER, to: '2026-12-31' }).to).toBe('2027-01-01T00:00:00+02:00');
    expect(sysQuery({ ...EMPTY_SYS_FILTER, from: 'nope' }).from).toBe('');
    expect(tripoliStamp('2026-11-09T23:30:00Z')).toBe('2026-11-10 01:30:00');
  });

  it('the CSV neutralises spreadsheet formulas and keeps the context as JSON', () => {
    const csv = systemLogCsv([{ id: 1, at: '2026-11-09T08:00:00Z', level: 'warn', source: 'template-check', message: '=HYPERLINK("http://x")', request_id: null, user: null, details: { reason: 'not_xlsx' } }]);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv).toContain('"{""reason"":""not_xlsx""}"');
    expect(entryText({ id: 2, at: 'x', level: 'info', source: 'api', message: 'm' })).toContain('"context": null');
  });
});
