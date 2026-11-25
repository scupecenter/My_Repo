import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { ViewMenu, type ViewOption } from './ViewMenu';

const OPTIONS: ViewOption[] = ['list', 'wide', 'board'].map((id) => ({ id, label: id.toUpperCase(), hint: `${id} hint`, icon: <span />, testid: `opt-${id}` }));
function Host() {
  const [v, setV] = useState('list');
  return <><ViewMenu testid="vm" title="View" value={v} options={OPTIONS} onChange={setV} /><output data-testid="picked">{v}</output></>;
}

describe('ViewMenu', () => {
  it('names the current view on the button and marks it in the menu', async () => {
    render(<Host />);
    const btn = screen.getByTestId('vm');
    expect(btn).toHaveAttribute('aria-label', 'View: LIST');
    await userEvent.click(btn);
    expect(await screen.findByTestId('opt-list')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('opt-wide')).toHaveAttribute('aria-checked', 'false');
  });

  it('works from the keyboard: Enter opens on the current view, arrows move, Enter picks, Escape closes and returns the focus', async () => {
    const u = userEvent.setup();
    render(<Host />);
    screen.getByTestId('vm').focus();
    await u.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByTestId('opt-list')).toHaveFocus());
    await u.keyboard('{ArrowDown}');
    expect(screen.getByTestId('opt-wide')).toHaveFocus();
    await u.keyboard('{End}');
    expect(screen.getByTestId('opt-board')).toHaveFocus();
    await u.keyboard('{ArrowDown}');
    expect(screen.getByTestId('opt-list')).toHaveFocus(); // wraps
    await u.keyboard('{ArrowUp}{Enter}');
    expect(screen.getByTestId('picked')).toHaveTextContent('board');
    await waitFor(() => expect(screen.queryByTestId('vm-panel')).toBeNull());
    await u.click(screen.getByTestId('vm'));
    await screen.findByTestId('vm-panel');
    await u.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('vm-panel')).toBeNull());
    expect(screen.getByTestId('vm')).toHaveFocus();
  });
});
