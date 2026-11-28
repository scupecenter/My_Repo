import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import ar from '@/i18n/ar.json';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './settings/Settings';

/** Contract 0.15.99: Settings > Data > Scheduled export (starts when the owner next opens Exports). */
const page = (opts: { locale?: 'en' | 'ar' } = {}) =>
  renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/data/export', ...opts });

describe('Settings, Scheduled export', () => {
  it('says plainly when the file is produced, lists the schedule as due, adds and deletes one', async () => {
    await signIn('pm');
    page();
    expect(await screen.findByTestId('page-export-schedules')).toBeInTheDocument();
    expect(await screen.findByTestId('es-note')).toHaveTextContent('when you next open Exports');
    const id = '00000000-0000-4000-8000-0000000000b1';
    expect(await screen.findByTestId(`es-row-${id}`)).toHaveTextContent('Every week on Monday');
    expect(screen.getByTestId(`es-due-${id}`)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('es-new'));
    fireEvent.change(screen.getByTestId('es-name'), { target: { value: 'Monthly full' } });
    fireEvent.change(screen.getByTestId('es-cadence'), { target: { value: 'monthly' } });
    fireEvent.click(screen.getByTestId('es-save'));
    expect(await screen.findByText('Monthly full')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`es-delete-${id}`));
    await waitFor(() => expect(screen.queryByTestId(`es-row-${id}`)).toBeNull());
  });

  it('shows the unattended switch (off by default), asks for a reason, turns it on, and saves the mail and unattended options', async () => {
    await signIn('pm');
    page();
    expect(await screen.findByTestId('es-switch-state')).toHaveTextContent('Off');
    const toggle = screen.getByTestId('es-switch-toggle');
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute('title', 'Turn on');
    fireEvent.change(screen.getByTestId('es-switch-reason'), { target: { value: 'Nightly exports for the PMO' } });
    fireEvent.click(screen.getByTestId('es-switch-toggle'));
    await waitFor(() => expect(screen.getByTestId('es-switch-state')).toHaveTextContent('On'));
    fireEvent.click(await screen.findByTestId('es-new'));
    fireEvent.change(screen.getByTestId('es-name'), { target: { value: 'Nightly full' } });
    fireEvent.click(screen.getByTestId('es-mail'));
    fireEvent.click(screen.getByTestId('es-unattended'));
    expect(screen.queryByTestId('es-unattended-off')).toBeNull();
    fireEvent.click(screen.getByTestId('es-save'));
    expect(await screen.findByText('Nightly full')).toBeInTheDocument();
    const row = screen.getByText('Nightly full').closest('tr') as HTMLElement;
    expect(row).toHaveTextContent('unattended');
    expect(row).toHaveTextContent('mail');
  });

  it('is in Arabic too', async () => {
    await signIn('pm');
    page({ locale: 'ar' });
    expect(await screen.findByTestId('page-export-schedules')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('settings-section-data-export')).toHaveTextContent(ar.settings.section_data_export));
  });
});
