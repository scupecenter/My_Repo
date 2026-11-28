import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DisplayExtrasCard } from '@/components/DisplayExtrasCard';
import { DrawerFrame } from '@/components/DrawerFrame';
import { copyText, setExtra } from '@/lib/uiExtras';

/** Item 16: copy-link button in the record drawer, switchable on this device. */
beforeEach(() => { localStorage.clear(); });
afterEach(() => { act(() => setExtra('copy_link', true)); });

describe('copy link in a drawer', () => {
  it('copies the absolute address of the record and says so', async () => {
    const u = userEvent.setup();
    render(<DrawerFrame name="t" testid="d" open onClose={() => undefined} link="/sites/abc?task=xyz"><p>body</p></DrawerFrame>);
    await u.click(screen.getByTestId('drawer-copy-link'));
    expect(await navigator.clipboard.readText()).toBe(`${window.location.origin}/sites/abc?task=xyz`);
    expect(await screen.findByText(/copied|نسخ/i)).toBeInTheDocument();
  });

  it('has no button without a link (a new record) or when the person switched it off', () => {
    const { rerender } = render(<DrawerFrame name="t" testid="d" open onClose={() => undefined}><p>x</p></DrawerFrame>);
    expect(screen.queryByTestId('drawer-copy-link')).toBeNull();
    rerender(<DrawerFrame name="t" testid="d" open onClose={() => undefined} link="/a"><p>x</p></DrawerFrame>);
    expect(screen.getByTestId('drawer-copy-link')).toBeInTheDocument();
    act(() => setExtra('copy_link', false));
    expect(screen.queryByTestId('drawer-copy-link')).toBeNull();
  });

  it('the Interface settings card flips the switch', async () => {
    const u = userEvent.setup();
    render(<DisplayExtrasCard />);
    const box = screen.getByTestId('ui-extra-copy_link') as HTMLInputElement;
    expect(box.checked).toBe(true);
    await u.click(box);
    expect(box.checked).toBe(false);
    expect(localStorage.getItem('pmis.extra.copy_link')).toBe('false');
  });

  it('falls back to the textarea copy where the clipboard API is missing', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    document.execCommand = vi.fn(() => true);
    expect(await copyText('x')).toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith('copy');
  });
});
