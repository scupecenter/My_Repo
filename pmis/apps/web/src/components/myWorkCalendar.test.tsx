import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '@/App';
import { renderApp, signIn } from '@/test/utils';

describe('My Work calendar', () => {
  it('opens on My Work and moves between months', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<App />, { route: '/my-work' });
    await screen.findByTestId('my-work-calendar');
    const before = (await screen.findByTestId('cal-title')).textContent;
    await u.click(screen.getByText(/Calendar \(my tasks/));
    await u.click(await screen.findByTestId('cal-next'));
    expect(screen.getByTestId('cal-title').textContent).not.toBe(before);
  });
});
