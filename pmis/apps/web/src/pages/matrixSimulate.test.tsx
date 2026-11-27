import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import ar from '@/i18n/ar.json';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './settings/Settings';

/** Contract 0.15.100: Settings > Workflow > Who approves?, read only. */
const page = (opts: { locale?: 'en' | 'ar' } = {}) =>
  renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/workflow/simulate', ...opts });

describe('Settings, Who approves?', () => {
  it('shows holders and the admin-path fallback for a chosen register and writes nothing', async () => {
    await signIn('pm');
    page();
    expect(await screen.findByTestId('page-matrix-simulate')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('ms-site-search'), { target: { value: 'S' } });
    await waitFor(() => expect((screen.getByTestId('ms-site') as HTMLSelectElement).options.length).toBeGreaterThan(1));
    fireEvent.change(screen.getByTestId('ms-site'), { target: { value: (screen.getByTestId('ms-site') as HTMLSelectElement).options[1]!.value } });
    fireEvent.change(screen.getByTestId('ms-kind'), { target: { value: 'register' } });
    await waitFor(() => expect((screen.getByTestId('ms-code') as HTMLSelectElement).options.length).toBeGreaterThan(1));
    fireEvent.change(screen.getByTestId('ms-code'), { target: { value: (screen.getByTestId('ms-code') as HTMLSelectElement).options[1]!.value } });
    expect(await screen.findByTestId('ms-holders-L1')).toHaveTextContent('Sara Ali');
    expect(screen.getByTestId('ms-nobody-L2')).toBeInTheDocument();
    expect(screen.getByTestId('ms-fallback-L2')).toHaveTextContent('system_admin');
    expect(screen.getByTestId('ms-open-coverage')).toHaveAttribute('href', '/admin/settings/workflow/coverage');
    expect(screen.getByTestId('page-matrix-simulate').querySelectorAll('button')).toHaveLength(0);
  });

  it('is in Arabic too', async () => {
    await signIn('pm');
    page({ locale: 'ar' });
    expect(await screen.findByTestId('settings-section-workflow-simulate')).toHaveTextContent(ar.settings.section_workflow_simulate);
  });
});
