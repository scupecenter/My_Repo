import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api } from '@/api/client';
import ar from '@/i18n/ar.json';
import en from '@/i18n/en.json';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './settings/Settings';

/** Contract 0.15.62 (migration 0146): Settings > Data > Data reset, two System Admins, the backup precondition, the plan, the result and the restore steps. */
const stepUpDone = () => api.post('/__mock/step-up');
const page = (opts: { locale?: 'en' | 'ar' } = {}) =>
  renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/data/reset', ...opts });

describe('Settings, data reset', () => {
  it('shows the danger notice, the backup, the plan with counts and the request form; the form needs a 10-character reason and the exact phrase', async () => {
    await signIn('pm'); await stepUpDone();
    const u = userEvent.setup();
    page();
    expect(await screen.findByTestId('dr-danger')).toHaveTextContent('This deletes ALL project data of pmis');
    expect(screen.getByTestId('dr-backup')).toHaveAttribute('data-ok', 'true');
    expect(screen.getByTestId('dr-backup-last')).toHaveTextContent('full, repository 1');
    expect(within(screen.getByTestId('dr-plan-delete')).getByTestId('dr-row-sites')).toHaveTextContent('12');
    expect(within(screen.getByTestId('dr-plan-delete')).getByTestId('dr-row-register_records')).toHaveTextContent('58 deleted, 6 kept');
    expect(within(screen.getByTestId('dr-plan-keep')).getByTestId('dr-row-users')).toHaveTextContent('25');
    expect(screen.getByTestId('settings-section-data-reset')).toHaveTextContent('Data reset');
    const submit = screen.getByTestId('dr-submit');
    expect(submit).toBeDisabled();
    await u.type(screen.getByTestId('dr-reason'), 'Owner decision: start the real data load');
    await u.type(screen.getByTestId('dr-phrase'), 'RESET pm');
    expect(submit).toBeDisabled();
    await u.type(screen.getByTestId('dr-phrase'), 'is');
    expect(submit).toBeEnabled();
    await u.click(submit);
    expect(await screen.findByTestId('dr-request')).toHaveAttribute('data-status', 'requested');
    expect(screen.getByTestId('dr-request-status')).toHaveTextContent('Waiting for approval');
    expect(screen.getByTestId('dr-wait-other')).toBeInTheDocument();
    expect(screen.queryByTestId('dr-approve')).not.toBeInTheDocument();     // nobody approves their own request
    expect(screen.getByTestId('dr-settings-edit')).toBeDisabled();           // the settings wait until the request is closed
    await u.click(screen.getByTestId('dr-cancel'));
    await u.type(screen.getByTestId('dr-cancel-dialog-reason'), 'Not this week');
    await u.click(screen.getByTestId('dr-cancel-dialog-submit'));
    expect(await screen.findByTestId('dr-form')).toBeInTheDocument();
    expect(screen.getByTestId('dr-last')).toHaveTextContent('Cancelled');
  });

  it('the second System Admin approves, then runs it with the phrase; the result shows the counts, the quarantine and how to restore', async () => {
    await signIn('pm'); await stepUpDone();
    await api.post('/__mock/data-reset/request-by-other');
    const u = userEvent.setup();
    page();
    expect(await screen.findByTestId('dr-requested-by')).toHaveTextContent('Second Admin (synthetic)');
    await u.click(screen.getByTestId('dr-approve'));
    const submit = screen.getByTestId('dr-approve-dialog-submit');
    expect(submit).toBeDisabled();
    await u.type(screen.getByTestId('dr-approve-dialog-reason'), 'Agreed with the owner today');
    await u.click(submit);
    await waitFor(() => expect(screen.getByTestId('dr-request')).toHaveAttribute('data-status', 'approved'));
    await u.click(screen.getByTestId('dr-run'));
    expect(screen.getByTestId('dr-run-dialog-submit')).toBeDisabled();
    await u.type(screen.getByTestId('dr-run-phrase'), 'RESET pmis');
    await u.click(screen.getByTestId('dr-run-dialog-submit'));
    expect(await screen.findByTestId('dr-result')).toHaveAttribute('data-status', 'completed');
    expect(screen.getByTestId('dr-result-sessions')).toHaveTextContent('7 sessions ended.');
    expect(screen.getByTestId('dr-result-files')).toHaveTextContent('30 moved, 1 not found');
    expect(screen.getByTestId('dr-result-quarantine')).toHaveTextContent('/var/lib/gsdn-pmis/files/.pre-reset-20261124-101500');
    expect(screen.getByTestId('dr-restore')).toHaveTextContent('cp -a -n /var/lib/gsdn-pmis/files/.pre-reset-20261124-101500/.');
    expect(screen.getByTestId('dr-restore')).toHaveTextContent('db-restore.sh');
  });

  it('without a recent backup the run button is disabled and says why', async () => {
    await signIn('pm'); await stepUpDone();
    await api.post('/__mock/data-reset/backup', { body: { ok: false } });
    await api.post('/__mock/data-reset/request-by-other');
    const u = userEvent.setup();
    page();
    await u.click(await screen.findByTestId('dr-approve'));
    await u.type(screen.getByTestId('dr-approve-dialog-reason'), 'Agreed with the owner today');
    await u.click(screen.getByTestId('dr-approve-dialog-submit'));
    expect(await screen.findByTestId('dr-run')).toBeDisabled();
    expect(screen.getByTestId('dr-run-blocked')).toHaveTextContent('No successful backup in the last 24 hours');
    expect(screen.getByTestId('dr-backup')).toHaveAttribute('data-ok', 'false');
  });

  it('is in Arabic too', async () => {
    await signIn('pm');
    page({ locale: 'ar' });
    expect(await screen.findByTestId('dr-danger')).toHaveTextContent(ar.dr.title);
    expect(screen.getByTestId('settings-section-data-reset')).toHaveTextContent(ar.settings.section_data_reset);
    expect(screen.getByTestId('dr-submit')).toHaveTextContent(ar.dr.submit);
  });

  it('is hidden from a user who is not a System Admin, and refused if opened directly', async () => {
    await signIn('engineer');
    page();
    expect(await screen.findByTestId('dr-forbidden')).toHaveTextContent(en.dr.admin_only);
    expect(screen.queryByTestId('settings-section-data-reset')).not.toBeInTheDocument();
    expect(screen.getByTestId('settings-section-data-imports')).toBeInTheDocument();
  });

  it('has every text in English and Arabic', () => {
    expect(Object.keys(ar.dr).sort()).toEqual(Object.keys(en.dr).sort());
    for (const k of ['single_admin', 'backup_missing', 'request_expired', 'reset_running', 'storage_not_supported', 'maintenance'] as const) {
      expect(en.errors[k]).toBeTruthy();
      expect(ar.errors[k]).toBeTruthy();
    }
  });
});
