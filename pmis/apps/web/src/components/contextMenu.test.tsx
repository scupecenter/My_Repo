import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import '@/i18n';
import { RowActions } from './RowActions';

function Card({ onEdit, onDelete, canDelete }: { onEdit: () => void; onDelete: () => void; canDelete: boolean }) {
  return (
    <div>
      <RowActions />
      <ul>
        <li tabIndex={0} data-ctx data-ctx-link="/sites/s1" data-testid="card">
          <button type="button" data-ctx-open>open card</button>
          <span data-ctx-value="ALX-01" data-testid="code">Alexandria 01</span>
          <button type="button" data-ctx-action="edit" onClick={onEdit}>edit</button>
          <button type="button" data-ctx-action="delete" disabled={!canDelete} onClick={onDelete}>del</button>
          <button type="button" data-ctx-action="assign" disabled>assign</button>
        </li>
      </ul>
      <input data-testid="field" />
    </div>
  );
}

describe('standard context menu on cards', () => {
  it('offers only the controls the card holds enabled; delete asks to confirm', async () => {
    const u = userEvent.setup();
    const edit = vi.fn(); const del = vi.fn();
    render(<Card onEdit={edit} onDelete={del} canDelete />);
    fireEvent.contextMenu(screen.getByTestId('code'));
    expect(await screen.findByTestId('row-menu-link')).toBeInTheDocument();
    expect(screen.getByTestId('row-menu-value')).toBeInTheDocument();
    expect(screen.queryByTestId('row-menu-assign')).toBeNull();
    await u.click(screen.getByTestId('row-menu-delete'));
    expect(del).not.toHaveBeenCalled();
    expect(screen.getByTestId('row-menu-delete')).toHaveTextContent(/Confirm/);
    await u.click(screen.getByTestId('row-menu-delete'));
    expect(del).toHaveBeenCalledTimes(1);
    fireEvent.contextMenu(screen.getByTestId('card'));
    await u.click(await screen.findByTestId('row-menu-edit'));
    expect(edit).toHaveBeenCalledTimes(1);
  });

  it('no delete item without the right; the menu opens from the keyboard; text fields keep the native menu', async () => {
    const u = userEvent.setup();
    render(<Card onEdit={() => {}} onDelete={() => {}} canDelete={false} />);
    screen.getByTestId('card').focus();
    await u.keyboard('{Shift>}{F10}{/Shift}');
    expect(await screen.findByTestId('row-menu')).toBeInTheDocument();
    expect(screen.queryByTestId('row-menu-delete')).toBeNull();
    await u.keyboard('{Escape}');
    expect(screen.queryByTestId('row-menu')).toBeNull();
    fireEvent.contextMenu(screen.getByTestId('field'));
    expect(screen.queryByTestId('row-menu')).toBeNull();
  });
});
