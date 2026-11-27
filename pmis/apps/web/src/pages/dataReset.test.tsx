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

  it('the scope picker: everything by default, chosen parts take their dependents along with a note, the identity parts carry a red warning (0.15.71)', async () => {
    await signIn('pm'); await stepUpDone();
    const u = userEvent.setup();
    page();
    expect(await screen.findByTestId('dr-scope')).toHaveAttribute('data-mode', 'everything');
    expect(screen.getByTestId('dr-scope-everything')).toBeChecked();
    await u.click(screen.getByTestId('dr-scope-custom'));
    expect(screen.getByTestId('dr-scope-none')).toHaveTextContent(en.dr.none_chosen);
    await u.type(screen.getByTestId('dr-reason'), 'Owner decision: reset the orders only');
    await u.type(screen.getByTestId('dr-phrase'), 'RESET pmis');
    expect(screen.getByTestId('dr-submit')).toBeDisabled();                  // nothing chosen
    await u.click(screen.getByTestId('dr-part-procurement'));
    expect(screen.getByTestId('dr-part-row-car_dispatcher')).toHaveAttribute('data-added', 'true');
    expect(screen.getByTestId('dr-part-car_dispatcher')).toBeDisabled();     // taken along while procurement is chosen
    expect(screen.getByTestId('dr-scope-added')).toHaveTextContent('Car Dispatcher bookings (the vehicles stay), Financial Advances');
    expect(screen.getByTestId('dr-part-row-sites')).toHaveAttribute('data-selected', 'false');
    expect(screen.getByTestId('dr-part-count-procurement')).toHaveTextContent('14 rows');
    expect(screen.queryByTestId('dr-scope-identity')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('dr-plan-note')).toHaveTextContent(en.dr.plan_scope_note));
    await u.click(screen.getByTestId('dr-part-users'));
    expect(screen.getByTestId('dr-scope-identity')).toHaveTextContent('Users: deactivate every account except the System Admins');
    expect(screen.getByTestId('dr-part-count-users')).toHaveTextContent('23 accounts');
    await waitFor(() => expect(screen.getByTestId('dr-plan-accounts')).toHaveTextContent('23 accounts would be deactivated'));
    expect(screen.getByTestId('dr-submit')).toBeEnabled();
    await u.click(screen.getByTestId('dr-submit'));
    expect(await screen.findByTestId('dr-request-scope')).toHaveAttribute('data-everything', 'false');
    expect(screen.getByTestId('dr-request-scope-part-procurement')).toHaveTextContent('Procurement');
    expect(screen.getByTestId('dr-request-scope-part-car_dispatcher')).toHaveTextContent(en.dr.added_badge);
    expect(screen.getByTestId('dr-request-scope-identity')).toBeInTheDocument();
  });

  it('the approver sees the scope read-only with its counts and approves exactly it', async () => {
    await signIn('pm'); await stepUpDone();
    await api.post('/__mock/data-reset/request-by-other', { body: { parts: ['issues', 'staff'] } });
    const u = userEvent.setup();
    page();
    const scope = await screen.findByTestId('dr-request-scope');
    expect(within(scope).getByTestId('dr-request-scope-part-issues')).toHaveTextContent('Issue Log · 5 rows');
    expect(within(scope).getByTestId('dr-request-scope-identity')).toHaveTextContent('Staff registry and absences');
    expect(within(scope).getByTestId('dr-request-scope-hash').textContent).toMatch(/^[0-9a-f]{12}$/);
    expect(screen.queryByTestId('dr-scope')).not.toBeInTheDocument();       // no picker while a request is open
    await u.click(screen.getByTestId('dr-approve'));
    const dialog = screen.getByTestId('dr-approve-dialog');
    expect(dialog).toHaveTextContent(en.dr.approve_scope);
    expect(within(dialog).getByTestId('dr-request-scope-part-staff')).toBeInTheDocument();
    await u.type(screen.getByTestId('dr-approve-dialog-reason'), 'Agreed with the owner today');
    await u.click(screen.getByTestId('dr-approve-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('dr-request')).toHaveAttribute('data-status', 'approved'));
  });

  it('the backup choice: require by default; "without a backup" shows the red warning and needs the typed phrase NO BACKUP (0.15.72)', async () => {
    await signIn('pm'); await stepUpDone();
    const u = userEvent.setup();
    page();
    const choice = await screen.findByTestId('dr-backup-choice');
    expect(choice).toHaveAttribute('data-require', 'true');
    expect(screen.getByTestId('dr-backup-require')).toBeChecked();
    expect(screen.queryByTestId('dr-no-backup-warning')).not.toBeInTheDocument();
    await u.type(screen.getByTestId('dr-reason'), 'Owner decision: clean test data, no backup');
    await u.type(screen.getByTestId('dr-phrase'), 'RESET pmis');
    expect(screen.getByTestId('dr-submit')).toBeEnabled();
    await u.click(screen.getByTestId('dr-backup-none-option'));
    expect(screen.getByTestId('dr-no-backup-warning')).toHaveTextContent(en.dr.no_backup_warning);
    expect(screen.getByTestId('dr-submit')).toBeDisabled();                  // NO BACKUP not typed yet
    await u.type(screen.getByTestId('dr-no-backup-phrase'), 'NO BACKU');
    expect(screen.getByTestId('dr-submit')).toBeDisabled();
    await u.type(screen.getByTestId('dr-no-backup-phrase'), 'P');
    expect(screen.getByTestId('dr-submit')).toBeEnabled();
    await u.click(screen.getByTestId('dr-submit'));
    const view = await screen.findByTestId('dr-request-backup');
    expect(view).toHaveAttribute('data-require', 'false');
    expect(view).toHaveTextContent(en.dr.no_backup_warning);
  });

  it('a request without a backup: the approver sees the warning, the run is allowed although no recent backup exists, the result says so', async () => {
    await signIn('pm'); await stepUpDone();
    await api.post('/__mock/data-reset/backup', { body: { ok: false } });
    await api.post('/__mock/data-reset/request-by-other', { body: { require_backup: false } });
    const u = userEvent.setup();
    page();
    expect(await screen.findByTestId('dr-request-backup')).toHaveAttribute('data-require', 'false');
    await u.click(screen.getByTestId('dr-approve'));
    expect(screen.getByTestId('dr-approve-backup')).toHaveTextContent(en.dr.no_backup_warning);
    await u.type(screen.getByTestId('dr-approve-dialog-reason'), 'Agreed with the owner today');
    await u.click(screen.getByTestId('dr-approve-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('dr-request')).toHaveAttribute('data-status', 'approved'));
    expect(screen.getByTestId('dr-run')).toBeEnabled();
    expect(screen.queryByTestId('dr-run-blocked')).not.toBeInTheDocument();
    await u.click(screen.getByTestId('dr-run'));
    expect(screen.getByTestId('dr-run-backup')).toHaveTextContent(en.dr.no_backup_warning);
    await u.type(screen.getByTestId('dr-run-phrase'), 'RESET pmis');
    await u.click(screen.getByTestId('dr-run-dialog-submit'));
    expect(await screen.findByTestId('dr-result-no-backup')).toHaveTextContent(en.dr.result_no_backup);
  });

  it('a request that requires a backup and has none: the disabled run says a new request can be made without the requirement', async () => {
    await signIn('pm'); await stepUpDone();
    await api.post('/__mock/data-reset/backup', { body: { ok: false } });
    await api.post('/__mock/data-reset/request-by-other');
    const u = userEvent.setup();
    page();
    expect(await screen.findByTestId('dr-request-backup')).toHaveAttribute('data-require', 'true');
    await u.click(screen.getByTestId('dr-approve'));
    await u.type(screen.getByTestId('dr-approve-dialog-reason'), 'Agreed with the owner today');
    await u.click(screen.getByTestId('dr-approve-dialog-submit'));
    expect(await screen.findByTestId('dr-run')).toBeDisabled();
    expect(screen.getByTestId('dr-run-blocked')).toHaveTextContent(en.dr.backup_missing_new_request);
  });

  it('is in Arabic too', async () => {
    await signIn('pm');
    page({ locale: 'ar' });
    expect(await screen.findByTestId('dr-danger')).toHaveTextContent(ar.dr.title);
    expect(screen.getByTestId('settings-section-data-reset')).toHaveTextContent(ar.settings.section_data_reset);
    expect(screen.getByTestId('dr-submit')).toHaveTextContent(ar.dr.submit);
    expect(screen.getByTestId('dr-scope')).toHaveTextContent(ar.dr.everything);
    await userEvent.setup().click(screen.getByTestId('dr-scope-custom'));
    expect(screen.getByTestId('dr-part-row-sites')).toHaveTextContent('المواقع ومهامها');
    expect(screen.getByTestId('dr-scope-group-identity')).toHaveTextContent(ar.dr.group_identity);
    expect(screen.getByTestId('dr-backup-choice')).toHaveTextContent(ar.dr.require_backup);
    await userEvent.setup().click(screen.getByTestId('dr-backup-none-option'));
    expect(screen.getByTestId('dr-no-backup-warning')).toHaveTextContent(ar.dr.no_backup_warning);
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
    for (const k of ['single_admin', 'backup_missing', 'request_expired', 'reset_running', 'storage_not_supported', 'maintenance', 'scope_changed'] as const) {
      expect(en.errors[k]).toBeTruthy();
      expect(ar.errors[k]).toBeTruthy();
    }
  });
  it('narrowing (0.15.265): the picker appears for narrowable parts only, the filter reaches the request and the approver view, a clear button resets it', async () => {
    await signIn('pm'); await stepUpDone();
    const u = userEvent.setup();
    page();
    await u.click(await screen.findByTestId('dr-scope-custom'));
    expect(screen.getByTestId('dr-narrow-whole')).toHaveTextContent(en.dr.narrow_whole);
    await u.click(screen.getByTestId('dr-part-sites'));
    expect(screen.queryByTestId('dr-narrow')).not.toBeInTheDocument();       // sites go whole
    await u.click(screen.getByTestId('dr-part-sites'));
    await u.click(screen.getByTestId('dr-part-procurement'));
    expect(await screen.findByTestId('dr-narrow')).toBeInTheDocument();
    await u.click(await screen.findByTestId('dr-narrow-region-1'));
    expect(screen.getByTestId('dr-narrow-active')).toBeInTheDocument();
    expect(screen.getByTestId('dr-narrow-clear')).toHaveAccessibleName(en.dr.narrow_clear);
    await u.click(screen.getByTestId('dr-narrow-clear'));
    expect(screen.queryByTestId('dr-narrow-active')).not.toBeInTheDocument();
    await u.click(screen.getByTestId('dr-narrow-region-1'));
    await u.type(screen.getByTestId('dr-reason'), 'Owner decision: only Tripoli orders');
    await u.type(screen.getByTestId('dr-phrase'), 'RESET pmis');
    await u.click(screen.getByTestId('dr-submit'));
    await screen.findByTestId('dr-request-narrow');
    await waitFor(() => expect(screen.getByTestId('dr-request-narrow')).toHaveTextContent('Tripoli'));
  });

  it('the narrowing strings exist in English and Arabic', () => {
    for (const k of Object.keys(en.dr).filter((x) => x.startsWith('narrow_'))) expect((ar.dr as Record<string, string>)[k]).toBeTruthy();
  });
});
