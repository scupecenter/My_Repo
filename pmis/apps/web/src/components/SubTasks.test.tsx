import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/i18n';
import { SubTasks } from './SubTasks';

const mutate = vi.fn();
let list: unknown;
vi.mock('@/api/x', () => ({
  useSubTasks: () => ({ isLoading: false, isError: false, data: list, refetch: vi.fn() }),
  useSaveSubTask: () => ({ mutate, isPending: false, isError: false, error: null }),
}));
vi.mock('@/api/admin', () => ({ usePicker: () => ({ data: [] }) }));

const row = (o: Record<string, unknown>) => ({ id: 'a1', title: 'Check the cable', state: 'open', progress: 0, due_date: null, owner_id: null, owner_name: null, version: 3, mine: false, created_at: '', updated_at: '', ...o });

describe('SubTasks (0.15.474)', () => {
  beforeEach(() => { mutate.mockReset(); });
  it('shows the roll-up and lets the entry level change, add and remove', () => {
    list = { items: [row({}), row({ id: 'a2', state: 'done', progress: 100, version: 1 })], rollup: { total: 2, done: 1, progress: 50 }, can_edit: true };
    render(<SubTasks kind="task" parentId="t1" />);
    expect(screen.getByTestId('subtasks-rollup').textContent).toContain('1 of 2 done, 50%');
    fireEvent.click(screen.getByTestId('subtask-check-a1'));
    expect(mutate).toHaveBeenLastCalledWith({ id: 'a1', version: 3, patch: { state: 'done' } });
    fireEvent.change(screen.getByTestId('subtask-progress-a1'), { target: { value: '40' } });
    expect(mutate).toHaveBeenLastCalledWith({ id: 'a1', version: 3, patch: { progress: 40 } });
    fireEvent.click(screen.getByTestId('subtask-remove-a1'));
    expect(mutate).toHaveBeenLastCalledWith({ id: 'a1', version: 3, patch: { removed: true } });
    expect((screen.getByTestId('subtask-add-btn') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('subtask-title'), { target: { value: ' Pull the fibre ' } });
    fireEvent.click(screen.getByTestId('subtask-add-btn'));
    expect(mutate.mock.calls.at(-1)?.[0]).toEqual({ patch: { title: 'Pull the fibre', owner_id: null, due_date: null } });
  });
  it('lets a view-only owner move only the status and progress of their own line', () => {
    list = { items: [row({ mine: true }), row({ id: 'a2', title: 'Other' })], rollup: { total: 2, done: 0, progress: 0 }, can_edit: false };
    render(<SubTasks kind="record" parentId="e1" />);
    expect((screen.getByTestId('subtask-check-a1') as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByTestId('subtask-check-a2') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByTestId('subtask-remove-a1')).toBeNull();
    expect(screen.queryByTestId('subtask-add')).toBeNull();
    expect(screen.getByTestId('subtasks-readonly')).toBeTruthy();
  });
  it('explains that a global record takes none', () => {
    render(<SubTasks kind="record" parentId="e1" enabled={false} />);
    expect(screen.getByTestId('subtasks-global')).toBeTruthy();
  });
});
