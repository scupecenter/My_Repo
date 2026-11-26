import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '@/App';
import { renderApp, signIn } from '@/test/utils';

describe('shortcut list', () => {
  it('? opens the list', async () => {
    await signIn('pm');
    renderApp(<App />, { route: '/dashboard' });
    await screen.findByTestId('dash-tv');
    fireEvent.keyDown(document.body, { key: '?' });
    expect(await screen.findByTestId('shortcuts-help')).toBeInTheDocument();
    expect(screen.getByTestId('shortcut-s')).toBeInTheDocument();
  });
});
