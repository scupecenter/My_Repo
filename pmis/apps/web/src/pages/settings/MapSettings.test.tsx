import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { MapSettings } from './MapSettings';

const page = () => renderApp(<Routes><Route path="/x" element={<MapSettings />} /></Routes>, { route: '/x' });

describe('Map settings (0.15.341)', () => {
  it('is off by default and refuses an address on another website', async () => {
    await signIn('pm');
    page();
    const on = await screen.findByTestId('maps-enabled');
    expect(on).not.toBeChecked();
    const url = screen.getByTestId('maps-tile-url');
    await userEvent.type(url, 'https://tile.example.org/{{z}/{{x}/{{y}.png');
    expect(await screen.findByTestId('maps-tile-url-bad')).toBeTruthy();
    expect(screen.getByTestId('maps-save')).toBeDisabled();
    await userEvent.clear(url);
    await userEvent.type(url, '/tiles/{{z}/{{x}/{{y}.png');
    expect(screen.queryByTestId('maps-tile-url-bad')).toBeNull();
    expect(screen.getByTestId('maps-save')).toBeEnabled();
  });
});
