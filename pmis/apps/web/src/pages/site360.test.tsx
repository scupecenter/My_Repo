import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { Sites } from './Sites';

describe('SITE 360 menus on the Sites page', () => {
  it('draws the CW menu as a grid with the three header rows and the totals row', async () => {
    await signIn('pm');
    renderApp(<Sites />, { route: '/sites?section=cw' });
    const grid = await screen.findByTestId('site360-grid');
    expect(grid.getAttribute('data-menu')).toBe('cw');
    expect(screen.getByTestId('site360-grid-band-row')).toBeTruthy();
    expect(screen.getByTestId('site360-grid-group-row')).toBeTruthy();
    expect(screen.getByTestId('site360-grid-field-row')).toBeTruthy();
    expect(screen.getByTestId('site360-grid-totals')).toBeTruthy();
  });

  it('switches to the vertical list and back to the grid', async () => {
    await signIn('pm');
    renderApp(<Sites />, { route: '/sites?section=cw' });
    await screen.findByTestId('site360-grid');
    fireEvent.click(screen.getByTestId('site360-layout-vertical'));
    expect(screen.queryByTestId('site360-grid')).toBeNull();
    expect(screen.getByTestId('site360-layout-vertical').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('site360-layout-grid'));
    expect(await screen.findByTestId('site360-grid')).toBeTruthy();
  });

  it('shows the Arabic labels of the layout toggle in the Arabic locale', async () => {
    await signIn('pm');
    renderApp(<Sites />, { route: '/sites?section=cw', locale: 'ar' });
    await screen.findByTestId('site360-grid');
    expect(screen.getByTestId('site360-layout-grid')).toHaveTextContent('شبكة');
    expect(screen.getByTestId('site360-layout-vertical')).toHaveTextContent('عمودي');
  });

  it('keeps the list when no menu is chosen', async () => {
    await signIn('pm');
    renderApp(<Sites />, { route: '/sites' });
    await screen.findByTestId('page-sites');
    expect(screen.queryByTestId('site360-grid')).toBeNull();
    expect(screen.queryByTestId('site360-layout')).toBeNull();
  });
});
