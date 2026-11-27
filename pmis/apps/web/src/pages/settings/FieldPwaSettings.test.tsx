import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '@/App';
import { renderApp, signIn } from '@/test/utils';

describe('Settings > Screens > Field mode', () => {
  it('is off by default; the admin turns it on with a reason', async () => {
    await signIn('pm');
    renderApp(<App />, { route: '/admin/settings/screens/field-mode' });
    const sw = (await screen.findByTestId('fps-enabled')) as HTMLInputElement;
    expect(sw.checked).toBe(false);
    const u = userEvent.setup();
    await u.click(sw);
    fireEvent.change(screen.getByTestId('fps-max_queue'), { target: { value: '30' } });
    await u.click(screen.getByTestId('fps-save'));
    await u.type(await screen.findByTestId('fps-dialog-reason'), 'site teams pilot');
    await u.click(screen.getByTestId('fps-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('fps-save')).toBeDisabled());
    expect((screen.getByTestId('fps-enabled') as HTMLInputElement).checked).toBe(true);
  });

  it('is read only for a user who cannot edit display defaults', async () => {
    await signIn('reviewer');
    renderApp(<App />, { route: '/admin/settings/screens/field-mode' });
    expect(await screen.findByTestId('fps-read-only')).toBeInTheDocument();
  });
});
