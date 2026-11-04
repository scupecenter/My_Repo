import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { API_BASE } from '@/api/client';
import type { AlertSettings } from '@/api/logs';
import { NAV, ADMIN_ONLY } from '@/components/navItems';
import en from '@/i18n/en.json';
import ar from '@/i18n/ar.json';
import { resetP9Mocks } from '@/mocks/handlers.p9';
import { REAL_API_AUTH_USERS } from '@/mocks/realApi';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { ActivityReport } from './ActivityReport';
import { weakens } from './AlertRules';
import { IntegrityRuns } from './IntegrityRuns';
import { MailDelivery } from './MailDelivery';
import { SecurityAlerts } from './SecurityAlerts';

/** Work package P9 (contract 0.12.3): mail delivery, integrity checks as jobs, alert rules and the activity workbook. */
beforeEach(() => resetP9Mocks());

describe('Mail delivery screen', () => {
  it('shows the channel as not yet verified until a test mail went out, then verified', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<MailDelivery />);
    expect(await screen.findByTestId('mail-state')).toHaveAttribute('data-state', 'unverified');
    expect(screen.getByTestId('mail-settings')).toHaveTextContent('relay.aljeel.local:587');
    await u.click(screen.getByTestId('mail-test'));
    await waitFor(() => expect(screen.getByTestId('mail-state')).toHaveAttribute('data-state', 'verified'));
    expect(screen.getByTestId('mail-verified-at')).not.toHaveTextContent('—');
  });

  it('lists the outbox, hides a sensitive subject and sends a given-up mail again with a reason', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<MailDelivery />);
    const row = await screen.findByTestId('mail-row-9c000000-0000-4000-8000-000000000003');
    expect(row).toHaveTextContent(en.mail.hidden);
    await u.click(within(row).getByTestId('mail-retry-9c000000-0000-4000-8000-000000000003'));
    const dlg = await screen.findByTestId('mail-retry-dialog');
    await u.type(within(dlg).getByTestId('mail-retry-dialog-reason'), 'relay fixed');
    await u.click(within(dlg).getByTestId('mail-retry-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('mail-status-9c000000-0000-4000-8000-000000000003')).toHaveTextContent(en.mail.s_queued));
  });

  it('filters by status', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<MailDelivery />);
    await screen.findByTestId('mail-row-9c000000-0000-4000-8000-000000000001');
    await u.click(screen.getByTestId('mail-filter-sent'));
    await waitFor(() => expect(screen.queryByTestId('mail-row-9c000000-0000-4000-8000-000000000002')).toBeNull());
    expect(screen.getByTestId('mail-row-9c000000-0000-4000-8000-000000000001')).toBeInTheDocument();
  });

  it('explains a missing SMTP configuration and disables the test', async () => {
    server.use(http.get(`${API_BASE}/admin/mail/status`, () => HttpResponse.json({ enabled: false, state: 'disabled', settings: null, verified_at: null, counts: {}, last_sent_at: null, last_error: null })));
    await signIn('pm');
    renderApp(<MailDelivery />);
    expect(await screen.findByTestId('mail-state')).toHaveAttribute('data-state', 'disabled');
    expect(screen.getByTestId('mail-test')).toBeDisabled();
    expect(screen.getByTestId('mail-state-hint')).toHaveTextContent(en.mail.hint_disabled);
  });

  it('is refused to a user who is not an admin', async () => {
    await signIn('engineer');
    renderApp(<MailDelivery />);
    expect(await screen.findByTestId('state-error')).toBeInTheDocument();
    expect(screen.queryByTestId('mail-status')).toBeNull();
  });
});

describe('Integrity checks screen', () => {
  it('starts a check as a job and shows it running, then intact with full progress', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<IntegrityRuns />);
    await screen.findByTestId('integ-run-9d000000-0000-4000-8000-000000000001');
    expect(screen.getByTestId('integ-anchor-9d000000-0000-4000-8000-000000000001')).toHaveTextContent(en.integ.anchor_ok);
    await u.click(screen.getByTestId('integ-start-security'));
    const running = await screen.findByText(en.integ.s_running);
    const card = running.closest('li')!;
    expect(card).toHaveTextContent(en.integ.log_security);
    await waitFor(() => expect(card).toHaveAttribute('data-status', 'ok'), { timeout: 8000 });
    expect(within(card).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });

  it('shows a second start of the same log as refused', async () => {
    server.use(http.post(`${API_BASE}/admin/log-integrity/runs`, () => HttpResponse.json({ type: 'about:blank', title: 'x', status: 409, code: 'invalid_transition' }, { status: 409, headers: { 'Content-Type': 'application/problem+json' } })));
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<IntegrityRuns />);
    await screen.findByTestId('integ-list');
    await u.click(screen.getByTestId('integ-start-audit'));
    expect(await screen.findByTestId('integ-error')).toBeInTheDocument();
  });
});

describe('Alert rules on the security alerts screen', () => {
  it('saves severities, the mail floor and trusted networks with a reason; warns when it weakens', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    let sent: Record<string, unknown> | null = null;
    server.events.on('request:start', async ({ request }) => {
      if (request.method === 'PUT' && request.url.endsWith('/settings/security-alerts')) sent = (await request.clone().json()) as Record<string, unknown>;
    });
    renderApp(<SecurityAlerts />);
    const nets = await screen.findByTestId('rules-networks');
    await u.type(nets, '10.0.0.1');
    expect(screen.getByTestId('rules-bad-net')).toBeInTheDocument();
    expect(screen.getByTestId('rules-save')).toBeDisabled();
    await u.clear(nets);
    await u.type(nets, '10.20.0.0/16');
    expect(screen.getByTestId('rules-weaker')).toBeInTheDocument();
    await u.selectOptions(screen.getByTestId('rules-sev-failed_sign_ins'), 'high');
    await u.click(screen.getByTestId('rules-save'));
    const dlg = await screen.findByTestId('rules-dialog');
    await u.type(within(dlg).getByTestId('rules-dialog-reason'), 'office NAT');
    await u.click(within(dlg).getByTestId('rules-dialog-submit'));
    await waitFor(() => expect(screen.queryByTestId('rules-dialog')).toBeNull());
    expect(sent).toMatchObject({ reason: 'office NAT', trusted_networks: ['10.20.0.0/16'], severity: expect.objectContaining({ failed_sign_ins: 'high' }), email_min_severity: 'low',
      failed_sign_ins: { count: 5, minutes: 15 }, new_ip: true });
    server.events.removeAllListeners();
  });

  it('knows what weakens a protection', () => {
    const cur = { severity: { new_ip: 'low', failed_sign_ins: 'medium' }, email_min_severity: 'low', trusted_networks: ['10.0.0.0/8'] } as unknown as AlertSettings;
    expect(weakens(cur, { new_ip: 'low' }, 'low', ['10.0.0.0/8'])).toBe(false);
    expect(weakens(cur, { failed_sign_ins: 'high' }, 'low', [])).toBe(false);
    expect(weakens(cur, { failed_sign_ins: 'low' }, 'low', [])).toBe(true);
    expect(weakens(cur, {}, 'medium', [])).toBe(true);
    expect(weakens(cur, {}, 'low', ['172.16.0.0/12'])).toBe(true);
  });
});

describe('Activity report', () => {
  it('downloads the Excel workbook of the month', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    let asked = '';
    server.events.on('request:start', ({ request }) => { if (request.url.includes('/reports/activity') && request.url.includes('format=xlsx')) asked = request.url; });
    renderApp(<ActivityReport />);
    await screen.findByTestId('report-users');
    await u.click(screen.getByTestId('report-xlsx'));
    await waitFor(() => expect(asked).toMatch(/month=\d{4}-\d{2}/));
    server.events.removeAllListeners();
  });
});

describe('P9 wiring', () => {
  it('adds the two admin-only log screens to the menu', () => {
    expect(NAV.filter((n) => ['logs.mail', 'logs.integrity'].includes(n.key)).map((n) => n.to)).toEqual(['/admin/logs/integrity', '/admin/logs/mail']);
    expect(ADMIN_ONLY.has('logs.mail') && ADMIN_ONLY.has('logs.integrity')).toBe(true);
  });

  it('passes the new endpoints through in hybrid mode', () => {
    const lines = REAL_API_AUTH_USERS.map(([m, p]) => `${m.toUpperCase()} ${p}`);
    for (const l of ['GET /admin/mail/status', 'POST /admin/mail/test', 'GET /admin/mail/outbox', 'POST /admin/mail/outbox/:id/retry', 'GET /admin/log-integrity/runs',
      'POST /admin/log-integrity/runs', 'GET /admin/log-integrity/runs/:id', 'GET /health']) expect(lines).toContain(l);
  });

  it('has every new text in English and Arabic', () => {
    for (const ns of ['mail', 'integ', 'rules'] as const) {
      expect(Object.keys((ar as unknown as Record<string, Record<string, string>>)[ns]).sort()).toEqual(Object.keys((en as unknown as Record<string, Record<string, string>>)[ns]).sort());
    }
    for (const k of ['logs.mail', 'logs.integrity']) expect((ar.nav as Record<string, string>)[k]).toBeTruthy();
    for (const k of ['capabilities', 'cap_audit_full_reader', 'cap_team_lead', 'cap_hint']) expect((ar.roles as Record<string, string>)[k]).toBeTruthy();
    for (const k of ['too_many_rows', 'integrity_too_large', 'mail_not_configured']) expect((ar.errors as Record<string, string>)[k]).toBeTruthy();
  });
});
