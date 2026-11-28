import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CardSwipe } from './CardSwipe';
import { SWIPE_KEY, swipeOf } from '@/lib/swipe';

afterEach(() => { localStorage.removeItem(SWIPE_KEY); document.documentElement.dir = 'ltr'; });

function swipe(el: Element, dx: number, dy = 0, type = 'touch') {
  fireEvent.pointerDown(el, { pointerType: type, clientX: 100, clientY: 100 });
  fireEvent.pointerUp(el, { pointerType: type, clientX: 100 + dx, clientY: 100 + dy });
}

describe('swipe on cards', () => {
  it('direction follows the writing direction; short or vertical moves are ignored', () => {
    expect(swipeOf(80, 0, false)).toBe('forward');
    expect(swipeOf(-80, 0, false)).toBe('back');
    expect(swipeOf(80, 0, true)).toBe('back');
    expect(swipeOf(-80, 0, true)).toBe('forward');
    expect(swipeOf(30, 0, false)).toBeNull();
    expect(swipeOf(80, 70, false)).toBeNull();
  });
  it('forward runs the main control if enabled; back opens the menu; the mouse and the switch are respected', () => {
    const act = vi.fn(); const menu = vi.fn();
    window.addEventListener('contextmenu', menu);
    render(<div><CardSwipe /><div data-swipe data-testid="c"><button data-swipe-action onClick={act}>go</button><span data-testid="t">x</span></div></div>);
    swipe(screen.getByTestId('t'), 90);
    expect(act).toHaveBeenCalledTimes(1);
    swipe(screen.getByTestId('t'), -90);
    expect(menu).toHaveBeenCalledTimes(1);
    swipe(screen.getByTestId('t'), 90, 0, 'mouse');
    expect(act).toHaveBeenCalledTimes(1);
    localStorage.setItem(SWIPE_KEY, 'false');
    swipe(screen.getByTestId('t'), 90);
    expect(act).toHaveBeenCalledTimes(1);
    window.removeEventListener('contextmenu', menu);
  });
  it('a disabled main control does not run', () => {
    const act = vi.fn();
    render(<div><CardSwipe /><div data-swipe data-testid="c"><button data-swipe-action disabled onClick={act}>go</button></div></div>);
    swipe(screen.getByTestId('c'), 90);
    expect(act).not.toHaveBeenCalled();
  });
});
