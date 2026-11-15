import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DocumentsGrid } from './DocumentsGrid';
import { renderApp, signIn } from '@/test/utils';

describe('documents grid', () => {
  it('shows one status per cell from the contract set', async () => {
    await signIn('pm');
    renderApp(<DocumentsGrid />);
    expect(await screen.findByTestId('docs-grid-table')).toBeTruthy();
    expect(screen.getByTestId('docs-grid-cell-GRD-001-A2').getAttribute('data-status')).toBe('approved');
    expect(screen.getByTestId('docs-grid-cell-GRD-001-B1').getAttribute('data-status')).toBe('pending');
  });

  it('narrows the rows to the Site IDs pasted in', async () => {
    await signIn('pm');
    renderApp(<DocumentsGrid />);
    await screen.findByTestId('docs-grid-table');
    fireEvent.change(screen.getByTestId('docs-grid-paste'), { target: { value: 'GRD-002, GRD-003' } });
    expect(await screen.findByTestId('docs-grid-row-GRD-002')).toBeTruthy();
    expect(screen.getByTestId('docs-grid-row-GRD-003')).toBeTruthy();
    expect(screen.queryByTestId('docs-grid-row-GRD-001')).toBeNull();
  });

  it('marks a document not required for one site with a reason', async () => {
    await signIn('pm');
    renderApp(<DocumentsGrid />);
    fireEvent.click(await screen.findByTestId('docs-grid-cell-GRD-001-B1'));
    const mark = screen.getByTestId('docs-grid-mark') as HTMLButtonElement;
    expect(mark.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('docs-grid-reason'), { target: { value: 'Not needed here' } });
    await waitFor(() => expect((screen.getByTestId('docs-grid-mark') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('docs-grid-mark'));
    await waitFor(() => expect(screen.queryByTestId('docs-grid-panel')).toBeNull());
  });
});
