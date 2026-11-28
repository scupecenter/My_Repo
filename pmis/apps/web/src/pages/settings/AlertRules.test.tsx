import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './Settings';

/** Settings, Alerts, Rules (0.15.242): the seeded rule is listed, a new rule needs the required fields, and a create posts through the reason dialog. */
const page = () => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/alerts/rules' });

describe('Settings, alert rules', () => {
  it('lists the seeded rule with its kind and title', async () => {
    await signIn('pm');
    page();
    const row = await screen.findByTestId('ar-row-weekly-status-missing');
    expect(row).toHaveTextContent('weekly-status-missing');
    expect(row).toHaveTextContent('Weekly status missing');
    expect(row).toHaveTextContent('Weekly status missing: {{region}}');
  });

  it('keeps Save disabled until the required fields of a new rule are filled', async () => {
    const u = userEvent.setup();
    await signIn('pm');
    page();
    await u.click(await screen.findByTestId('ar-new'));
    expect(screen.getByTestId('ar-save')).toBeDisabled();
    await u.type(screen.getByTestId('ar-code'), 'idle-issues');
    expect(screen.getByTestId('ar-save')).toBeDisabled();
    await u.type(screen.getByTestId('ar-title_en'), 'Idle issues');
    await u.type(screen.getByTestId('ar-title_ar'), 'بلاغات خامدة');
    await u.type(screen.getByTestId('ar-body_en'), 'A record is idle.');
    await u.type(screen.getByTestId('ar-body_ar'), 'سجل خامد.');
    expect(screen.getByTestId('ar-save')).toBeEnabled();
  });

  it('creates a rule through the reason dialog and lists it', async () => {
    const u = userEvent.setup();
    await signIn('pm');
    page();
    await u.click(await screen.findByTestId('ar-new'));
    await u.type(screen.getByTestId('ar-code'), 'idle-issues');
    await u.selectOptions(screen.getByTestId('ar-kind'), 'record_idle');
    await u.selectOptions(screen.getByTestId('ar-register'), 'issues');
    await u.type(screen.getByTestId('ar-state'), 'open');
    await u.clear(screen.getByTestId('ar-days'));
    await u.type(screen.getByTestId('ar-days'), '30');
    await u.type(screen.getByTestId('ar-title_en'), 'Idle issues');
    await u.type(screen.getByTestId('ar-title_ar'), 'بلاغات خامدة');
    await u.type(screen.getByTestId('ar-body_en'), 'Record {{record}} idle {{days}} days.');
    await u.type(screen.getByTestId('ar-body_ar'), 'السجل {{record}} خامد {{days}} يوم.');
    await u.click(screen.getByTestId('ar-save'));
    const dialog = await screen.findByTestId('ar-dialog');
    await u.type(await screen.findByTestId('ar-dialog-reason'), 'Watch idle issues');
    await u.click(screen.getByTestId('ar-dialog-submit'));
    expect(await screen.findByTestId('ar-row-idle-issues')).toHaveTextContent('Record idle in a state');
    expect(dialog).not.toBeInTheDocument();
  });

  it('creates a kpi_threshold rule with its own editable threshold and locks it', async () => {
    const u = userEvent.setup();
    await signIn('pm');
    page();
    await u.click(await screen.findByTestId('ar-new'));
    await u.type(screen.getByTestId('ar-code'), 'sla-breach-high');
    await u.selectOptions(screen.getByTestId('ar-kind'), 'kpi_threshold');
    expect(screen.getByTestId('ar-save')).toBeDisabled();
    await u.selectOptions(screen.getByTestId('ar-kpi'), 'sla_breach');
    await u.selectOptions(screen.getByTestId('ar-op'), 'above');
    await u.type(screen.getByTestId('ar-value'), '8');
    await u.type(screen.getByTestId('ar-title_en'), 'SLA breaches above {{threshold}}');
    await u.type(screen.getByTestId('ar-title_ar'), 'تجاوزات SLA فوق {{threshold}}');
    await u.type(screen.getByTestId('ar-body_en'), '{{kpi}} is {{value}}.');
    await u.type(screen.getByTestId('ar-body_ar'), '{{kpi}} الآن {{value}}.');
    expect(screen.getByTestId('ar-save')).toBeEnabled();
    await u.click(screen.getByTestId('ar-save'));
    await u.type(await screen.findByTestId('ar-dialog-reason'), 'Watch the SLA band');
    await u.click(screen.getByTestId('ar-dialog-submit'));
    expect(await screen.findByTestId('ar-row-sla-breach-high')).toHaveTextContent('KPI crosses a threshold');

    // lock it: the row shows Locked, and a later edit that changes anything else is refused rule_locked until the unlock
    await u.click(screen.getByTestId('ar-edit-sla-breach-high'));
    await u.click(screen.getByTestId('ar-locked'));
    await u.click(screen.getByTestId('ar-save'));
    await u.type(await screen.findByTestId('ar-dialog-reason'), 'Freeze the rule');
    await u.click(screen.getByTestId('ar-dialog-submit'));
    const row = await screen.findByTestId('ar-row-sla-breach-high');
    expect(row.children[4]).toHaveTextContent('Yes');

    await u.click(screen.getByTestId('ar-edit-sla-breach-high'));
    await u.clear(screen.getByTestId('ar-title_en'));
    await u.type(screen.getByTestId('ar-title_en'), 'Changed while locked');
    await u.click(screen.getByTestId('ar-save'));
    await u.type(await screen.findByTestId('ar-dialog-reason'), 'Try an edit');
    await u.click(screen.getByTestId('ar-dialog-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent('rule_locked');
  });

  it('offers the two financial kinds with an optional days value', async () => {
    const u = userEvent.setup();
    await signIn('pm');
    page();
    await u.click(await screen.findByTestId('ar-new'));
    await u.selectOptions(screen.getByTestId('ar-kind'), 'advance_unsettled');
    await u.clear(screen.getByTestId('ar-days'));
    expect(screen.getByTestId('ar-days')).toHaveAttribute('placeholder');
    await u.selectOptions(screen.getByTestId('ar-kind'), 'invoice_due_soon');
    expect(screen.getByTestId('ar-days')).toBeInTheDocument();
  });

  it('offers the orphans alert kind with a register, a field and the minimum rows', async () => {
    const u = userEvent.setup();
    await signIn('pm');
    page();
    await u.click(await screen.findByTestId('ar-new'));
    await u.selectOptions(screen.getByTestId('ar-kind'), 'link_orphans');
    expect(screen.getByTestId('ar-min-rows')).toHaveValue(1);
    expect(screen.queryByTestId('ar-field-code')).toBeNull();
    await u.selectOptions(screen.getByTestId('ar-register'), 'issues');
    expect(screen.getByTestId('ar-field-code')).toBeInTheDocument();
  });
});
