import { fireEvent, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import ar from '@/i18n/ar.json';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './settings/Settings';

/** Contract 0.15.94: Settings > Workflow > Matrix coverage, read only. */
const page = (opts: { locale?: 'en' | 'ar' } = {}) =>
  renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/workflow/coverage', ...opts });

describe('Settings, Matrix coverage', () => {
  it('lists the gaps, can show all cells, filters by region and changes no data', async () => {
    await signIn('pm');
    page();
    expect(await screen.findByTestId('page-matrix-coverage')).toBeInTheDocument();
    expect(await screen.findByTestId('mc-summary')).toHaveTextContent('5 covered, 2 empty, 1 named but nobody active, of 8 cells');
    expect(screen.getByTestId('mc-row-MS1-2-L2')).toHaveTextContent('Empty');
    expect(screen.getByTestId('mc-row-gecol-1-L1')).toHaveTextContent('Nobody active');
    expect(screen.queryByTestId('mc-row-MS1-1-L1')).toBeNull();
    fireEvent.click(screen.getByTestId('mc-gaps-only'));
    expect(screen.getByTestId('mc-row-MS1-1-L1')).toHaveTextContent('Covered');
    fireEvent.change(screen.getByTestId('mc-region'), { target: { value: '2' } });
    expect(screen.queryByTestId('mc-row-MS1-1-L1')).toBeNull();
    expect(screen.getByTestId('mc-row-gecol-2-L1')).toBeInTheDocument();
    expect(screen.getByTestId('mc-open-matrix')).toHaveAttribute('href', '/admin/matrix');
    expect(screen.getByTestId('page-matrix-coverage').querySelectorAll('button')).toHaveLength(0);
  });

  it('is in Arabic too', async () => {
    await signIn('pm');
    page({ locale: 'ar' });
    expect(await screen.findByTestId('mc-summary')).toBeInTheDocument();
    expect(await screen.findByTestId('settings-section-workflow-coverage')).toHaveTextContent(ar.settings.section_workflow_coverage);
  });
});
