import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getExtra, isProgrammaticCopy } from '@/lib/uiExtras';
import { useToast } from './Toast';

/** True when the copy took something: a text selection on the page, or a selected range inside a text field (whose text the page selection does not report). */
function hasSelection(target: EventTarget | null): boolean {
  const el = target as (HTMLInputElement | HTMLTextAreaElement) | null;
  if (el && typeof el.selectionStart === 'number' && typeof el.selectionEnd === 'number' && el.selectionStart !== el.selectionEnd) return true;
  return (window.getSelection()?.toString() ?? '') !== '';
}

/**
 * The "Copied" notice for any copy the person makes by hand: Ctrl+C, right-click > Copy, the browser menu (item: global copied notice). One listener on the
 * document; it never touches the clipboard or the copied content. Copies made by a button write through the clipboard API (no copy event) or through
 * copyText (flagged), and those buttons show their own notice, so nothing is shown twice. A person can switch it off on this device.
 */
export function CopyToast() {
  const toast = useToast();
  const { t } = useTranslation();
  useEffect(() => {
    let last = 0;
    const on = (e: ClipboardEvent) => {
      if (isProgrammaticCopy() || !getExtra('copy_toast') || !hasSelection(e.target)) return;
      const now = Date.now();
      if (now - last < 800) return; // one notice per copy, even when several handlers run
      last = now;
      toast(t('toast.copied'), 'ok', { ms: 1800 });
    };
    document.addEventListener('copy', on);
    return () => document.removeEventListener('copy', on);
  }, [toast, t]);
  return null;
}
