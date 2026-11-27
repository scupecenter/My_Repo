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
});
