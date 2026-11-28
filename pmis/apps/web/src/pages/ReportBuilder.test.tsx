import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { ReportBuilderPage } from './ReportBuilder';

/** Report builder: a report is a saved view of a register; running it is a view export, scheduling it a scheduled export with spec.view. */
const page = () => renderApp(<Routes><Route path="/reports" element={<ReportBuilderPage />} /></Routes>, { route: '/reports' });

describe('Report builder', () => {
  it('lists only registers the user may export, picks columns and their order, saves the report and reopens it', async () => {
    await signIn('pm');
    page();
    const src = (await screen.findByTestId('reports-source')) as HTMLSelectElement;
    expect([...src.options].map((o) => o.value)).toEqual(expect.arrayContaining(['permits_hse', 'quality']));
    expect([...src.options].map((o) => o.value)).not.toContain('sites');
    fireEvent.change(src, { target: { value: 'permits_hse' } });
    await waitFor(() => expect(screen.getByTestId('reports-col-count')).toHaveTextContent('(7)'));
    fireEvent.click(screen.getByTestId('reports-col-valid_to'));
    expect(screen.getByTestId('reports-col-count')).toHaveTextContent('(6)');
    fireEvent.click(screen.getByTestId('reports-up-status'));
    expect(screen.getByTestId('reports-order').textContent).toMatch(/status.*permit_type/i);
    expect(screen.getByTestId('reports-save')).toBeDisabled();
    fireEvent.change(screen.getByTestId('reports-name'), { target: { value: 'Open permits' } });
    fireEvent.click(screen.getByTestId('reports-save'));
    const item = await screen.findByText('Open permits');
    fireEvent.click(item);
    await waitFor(() => expect(screen.getByTestId('reports-save')).toHaveTextContent('Save changes'));
    expect(screen.getByTestId('reports-col-count')).toHaveTextContent('(6)');
  });

  it('runs the report as a view export and schedules it', async () => {
    await signIn('pm');
    page();
    await screen.findByTestId('reports-source');
    fireEvent.click(screen.getByTestId('reports-run'));
    expect(await screen.findByText(/being prepared/i)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('reports-schedule'));
    expect(await screen.findByText(/Scheduled\./)).toBeInTheDocument();
  });
});
