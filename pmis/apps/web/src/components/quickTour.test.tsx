import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '@/App';
import { renderApp, signIn } from '@/test/utils';

describe('Quick tour', () => {
  it('does not open by itself; opens from the shortcuts list and walks the 5 steps', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<App />, { route: '/my-work' });
    await screen.findByTestId('my-work-calendar');
    expect(screen.queryByTestId('quick-tour')).toBeNull();
    fireEvent.keyDown(document.body, { key: '?' });
    await u.click(await screen.findByTestId('shortcuts-tour'));
    expect(await screen.findByTestId('quick-tour')).toBeInTheDocument();
    for (let k = 0; k < 4; k++) await u.click(screen.getByTestId('tour-next'));
    expect(screen.getByTestId('tour-step')).toHaveTextContent('5');
    await u.click(screen.getByTestId('tour-next'));
    expect(screen.queryByTestId('quick-tour')).toBeNull();
  });
});
