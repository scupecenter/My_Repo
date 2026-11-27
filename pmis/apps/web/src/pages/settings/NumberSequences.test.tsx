import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '@/App';
import { renderApp, signIn } from '@/test/utils';

describe('Settings > Documents > Numbering', () => {
  it('lists the sequences and lets the admin change the pattern with a reason', async () => {
    await signIn('pm');
    renderApp(<App />, { route: '/admin/settings/documents/numbering' });
    const row = await screen.findByTestId('seq-row-PL-WH');
    expect(within(row).getByText('PL-WH-{YYYY}-{SEQ:4}')).toBeInTheDocument();
    const u = userEvent.setup();
    await u.click(within(row).getByTestId('seq-edit-PL-WH'));
    const pattern = screen.getByTestId('seq-pattern');
    fireEvent.change(pattern, { target: { value: 'PL-X-{YYYY}-{SEQ:4}' } });
    await u.click(screen.getByTestId('seq-panel-submit'));
    expect(await screen.findByTestId('seq-panel-reason-error')).toBeInTheDocument();
    await u.type(screen.getByTestId('seq-panel-reason'), 'new prefix');
    await u.click(screen.getByTestId('seq-panel-submit'));
    expect(await within(await screen.findByTestId('seq-row-PL-WH')).findByText('PL-X-{YYYY}-{SEQ:4}')).toBeInTheDocument();
    expect(screen.queryByTestId('seq-panel')).not.toBeInTheDocument();
  });

  it('shows the sequences read only to a user who is not admin', async () => {
    await signIn('reviewer');
    renderApp(<App />, { route: '/admin/settings/documents/numbering' });
    expect(await screen.findByTestId('seq-row-PL-WH')).toBeInTheDocument();
    expect(screen.queryByTestId('seq-edit-PL-WH')).toBeNull();
  });
});
