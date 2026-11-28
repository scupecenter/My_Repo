import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CopyToast } from '@/components/CopyToast';
import { ToastProvider } from '@/components/Toast';
import { copyText, setExtra } from '@/lib/uiExtras';

/** Global "Copied" notice: any hand copy of a selection shows it once; button copies and a switched-off device do not. */
const fire = (target: Element | Document = document) => act(() => { target.dispatchEvent(new Event('copy', { bubbles: true })); });
const select = (text: string) => { const p = document.createElement('p'); p.textContent = text; document.body.appendChild(p); const r = document.createRange(); r.selectNodeContents(p); const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r); return p; };
beforeEach(() => { localStorage.clear(); render(<ToastProvider><CopyToast /></ToastProvider>); });
afterEach(() => { window.getSelection()?.removeAllRanges(); act(() => setExtra('copy_toast', true)); });

describe('copy notice', () => {
  it('shows once for a copy of selected text', () => {
    select('abc');
    fire(); fire();
    expect(screen.getAllByTestId('toast')).toHaveLength(1);
  });
  it('is quiet when nothing is selected', () => {
    window.getSelection()?.removeAllRanges();
    fire();
    expect(screen.queryByTestId('toast')).toBeNull();
  });
  it('counts a selected range inside a text field', () => {
    const i = document.createElement('input'); i.value = 'hello'; document.body.appendChild(i); i.setSelectionRange(0, 3);
    fire(i);
    expect(screen.getAllByTestId('toast')).toHaveLength(1);
  });
  it('stays quiet for the copy a button makes through copyText, and when switched off', async () => {
    select('abc');
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => { document.dispatchEvent(new Event('copy')); return true; } });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    await act(async () => { await copyText('x'); });
    expect(screen.queryByTestId('toast')).toBeNull();
    act(() => setExtra('copy_toast', false));
    fire();
    expect(screen.queryByTestId('toast')).toBeNull();
  });
});
