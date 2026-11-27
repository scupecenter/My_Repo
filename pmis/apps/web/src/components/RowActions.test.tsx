import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import '@/i18n';
import { RowActions } from './RowActions';
import { rowText, stepRow } from '@/lib/rowNav';

function Grid({ onOpen }: { onOpen: (n: string) => void }) {
  return (
    <div>
      <RowActions />
      <div role="list">
        {['a', 'b', 'c'].map((n) => (
          <div key={n} role="listitem" tabIndex={0} className="gx-row" data-testid={`r-${n}`} onClick={() => onOpen(n)}>
            <input type="checkbox" aria-label={`sel-${n}`} onClick={(e) => e.stopPropagation()} />
            <div data-col="x">code {n}</div>
            <div data-col="y">name {n}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

describe('row shortcuts and menu', () => {
  it('J and K move the focus between rows and stop at the ends', async () => {
    const u = userEvent.setup();
    render(<Grid onOpen={() => {}} />);
    await u.keyboard('j');
    expect(screen.getByTestId('r-a')).toHaveFocus();
    await u.keyboard('j');
    expect(screen.getByTestId('r-b')).toHaveFocus();
    await u.keyboard('jj');
    expect(screen.getByTestId('r-c')).toHaveFocus();
    await u.keyboard('k');
    expect(screen.getByTestId('r-b')).toHaveFocus();
  });

  it('right-click opens the row menu: open, select, copy; Escape closes it and returns the focus', async () => {
    const u = userEvent.setup();
    const open = vi.fn();
    render(<Grid onOpen={open} />);
    await u.pointer({ keys: '[MouseRight]', target: screen.getByTestId('r-b') });
    const menu = await screen.findByTestId('row-menu');
    expect(menu).toBeInTheDocument();
    await u.click(screen.getByTestId('row-menu-select'));
    expect(screen.getByLabelText('sel-b')).toBeChecked();
    await u.pointer({ keys: '[MouseRight]', target: screen.getByTestId('r-b') });
    expect(await screen.findByTestId('row-menu-select')).toHaveTextContent(/Unselect/);
    await u.keyboard('{Escape}');
    expect(screen.queryByTestId('row-menu')).toBeNull();
    expect(screen.getByTestId('r-b')).toHaveFocus();
    await u.pointer({ keys: '[MouseRight]', target: screen.getByTestId('r-c') });
    await u.click(screen.getByTestId('row-menu-open'));
    expect(open).toHaveBeenCalledWith('c');
  });

  it('keeps the browser menu with Shift and does not touch typing', async () => {
    const u = userEvent.setup();
    render(<><input aria-label="q" /><Grid onOpen={() => {}} /></>);
    await u.click(screen.getByLabelText('q'));
    await u.keyboard('jk');
    expect(screen.getByLabelText('q')).toHaveFocus();
  });

  it('helpers', () => {
    const els = ['a', 'b'].map((n) => { const d = document.createElement('div'); const c = document.createElement('span'); c.textContent = n; d.append(c); return d; });
    expect(stepRow(els, null, 1)).toBe(els[0]);
    expect(stepRow(els, null, -1)).toBe(els[1]);
    expect(stepRow(els, els[1]!, 1)).toBe(els[1]);
    expect(rowText(els[0]!)).toBe('a');
  });
});
