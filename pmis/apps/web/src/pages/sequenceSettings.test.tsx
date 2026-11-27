import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import ar from '@/i18n/ar.json';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './settings/Settings';

/** D49: Settings > Workflow > Sequence, read only, with links to the editor and the historical load. */
const page = (opts: { locale?: 'en' | 'ar' } = {}) =>
  renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/workflow/sequence', ...opts });

describe('Settings, Sequence', () => {
  it('lists the versions with their mode and links to the editor and historical load', async () => {
    await signIn('pm');
    page();
    expect(await screen.findByTestId('page-sequence')).toBeInTheDocument();
    expect(await screen.findByTestId('seq-versions')).toBeInTheDocument();
    expect(screen.getByTestId('seq-link-editor')).toHaveAttribute('href', '/admin/settings/workflow/editor');
    expect(screen.getByTestId('seq-link-historical')).toHaveAttribute('href', '/admin/settings/data/historical');
  });
  it('has the Arabic section label', async () => {
    await signIn('pm');
    page({ locale: 'ar' });
    expect(await screen.findByTestId('settings-section-workflow-sequence')).toHaveTextContent(ar.settings.section_workflow_sequence);
  });
});
