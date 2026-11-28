import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DragGrip, TextSelectionGuard } from './TextSelection';

describe('TextSelectionGuard', () => {
  it('a press on the text of a draggable card selects text; only the grip drags; the drag comes back after the press', () => {
    render(<><TextSelectionGuard />
      <div draggable data-testid="card"><DragGrip /><span data-testid="word">Ahmed Omran</span></div></>);
    const card = screen.getByTestId('card');
    fireEvent.mouseDown(screen.getByTestId('word'));
    expect(card).toHaveAttribute('draggable', 'false');
    fireEvent.mouseUp(screen.getByTestId('word'));
    expect(card).toHaveAttribute('draggable', 'true');
    fireEvent.mouseDown(screen.getByRole('img'));
    expect(card).toHaveAttribute('draggable', 'true');
  });

  it('a click that ends a text selection does not open the row, a plain click still does', () => {
    const open = vi.fn();
    render(<><TextSelectionGuard />
      <table><tbody><tr data-testid="row" onClick={open}><td data-testid="name">Ahmed Omran</td></tr></tbody></table></>);
    fireEvent.click(screen.getByTestId('name'));
    expect(open).toHaveBeenCalledTimes(1);
    window.getSelection()?.selectAllChildren(screen.getByTestId('name'));
    fireEvent.click(screen.getByTestId('name'));
    expect(open).toHaveBeenCalledTimes(1);
    window.getSelection()?.removeAllRanges();
    fireEvent.click(screen.getByTestId('name'));
    expect(open).toHaveBeenCalledTimes(2);
  });
});
