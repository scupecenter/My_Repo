import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderApp } from '@/test/utils';
import type { TableApi } from './TableKit';
import { LayoutPanel, type ViewOption } from './LayoutPanel';

const OPTIONS: ViewOption[] = ['list', 'wide', 'board'].map((id) => ({ id, label: id.toUpperCase(), hint: `${id} hint`, icon: <span />, testid: `opt-${id}` }));

function tableStub(): TableApi {
  return {
    prefs: { order: [], hidden: [], width: {} },
    display: { size: 'md', align: 'start', density: 'comfortable', wrap: false, zebra: true },
    setDisplay: vi.fn(),
    setDensity: vi.fn(),
    setPinned: vi.fn(),
    resetDisplay: vi.fn(),
  } as unknown as TableApi;
}

function Host({ withTable = true, withOptions = true }: { withTable?: boolean; withOptions?: boolean }) {
  const [v, setV] = useState('list');
  const table = withTable ? tableStub() : undefined;
  return (
    <>
      <LayoutPanel testid="lp" views={{ value: v, options: OPTIONS, onChange: setV }}
        options={withOptions && v === 'board' ? <span data-testid="board-opts">board options</span> : undefined}
        table={v === 'board' ? undefined : table} />
      <output data-testid="picked">{v}</output>
    </>
  );
}

describe('LayoutPanel', () => {
  it('names the current view on the button and marks it in the panel', async () => {
    renderApp(<Host />);
    const btn = screen.getByTestId('lp');
    expect(btn).toHaveAttribute('aria-label', 'Layout: LIST');
    await userEvent.click(btn);
    expect(await screen.findByTestId('opt-list')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('opt-wide')).toHaveAttribute('aria-checked', 'false');
  });

  it('works from the keyboard: Enter opens on the current view, arrows move, Enter picks, Escape closes and returns the focus', async () => {
    const u = userEvent.setup();
    renderApp(<Host />);
    screen.getByTestId('lp').focus();
    await u.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByTestId('opt-list')).toHaveFocus());
    await u.keyboard('{ArrowDown}');
    expect(screen.getByTestId('opt-wide')).toHaveFocus();
    await u.keyboard('{End}');
    expect(screen.getByTestId('opt-board')).toHaveFocus();
    await u.keyboard('{ArrowDown}');
    expect(screen.getByTestId('opt-list')).toHaveFocus(); // wraps
    await u.keyboard('{ArrowUp}{Enter}');
    await waitFor(() => expect(screen.getByTestId('picked')).toHaveTextContent('board'));
    await waitFor(() => expect(screen.queryByTestId('lp-panel')).toBeNull());
    await u.click(screen.getByTestId('lp'));
    await screen.findByTestId('lp-panel');
    await u.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('lp-panel')).toBeNull());
    expect(screen.getByTestId('lp')).toHaveFocus();
  });

  it('shows the Display section only on a table view and the view options only on their view', async () => {
    const u = userEvent.setup();
    renderApp(<Host />);
    await u.click(screen.getByTestId('lp'));
    expect(await screen.findByTestId('lp-display')).toBeInTheDocument();
    expect(screen.queryByTestId('lp-options')).toBeNull();
    // switch to the board: its options come, the Display section goes
    await u.click(screen.getByTestId('opt-board'));
    await u.click(screen.getByTestId('lp'));
    expect(await screen.findByTestId('board-opts')).toBeInTheDocument();
    expect(screen.queryByTestId('lp-display')).toBeNull();
  });

  it('the Display controls call the table api and keep their test ids', async () => {
    const u = userEvent.setup();
    const table = tableStub();
    function Fixed() {
      const [v] = useState('list');
      return <LayoutPanel testid="lp" views={{ value: v, options: OPTIONS, onChange: () => undefined }} table={table} />;
    }
    renderApp(<Fixed />);
    await u.click(screen.getByTestId('lp'));
    await u.click(await screen.findByTestId('display-size-lg'));
    expect(table.setDisplay).toHaveBeenCalledWith({ size: 'lg' });
    await u.click(screen.getByTestId('display-density-compact'));
    expect(table.setDensity).toHaveBeenCalledWith('compact');
    await u.click(screen.getByTestId('display-pin'));
    expect(table.setPinned).toHaveBeenCalledWith(false);
    await u.click(screen.getByTestId('display-reset'));
    expect(table.resetDisplay).toHaveBeenCalled();
  });

  it('without views the button is just the Layout panel of the display options', async () => {
    renderApp(<LayoutPanel testid="lp" table={tableStub()} />);
    expect(screen.getByTestId('lp')).toHaveAttribute('aria-label', 'Layout');
    await userEvent.click(screen.getByTestId('lp'));
    expect(await screen.findByTestId('lp-display')).toBeInTheDocument();
    expect(screen.queryByTestId('lp-views')).toBeNull();
  });
});
