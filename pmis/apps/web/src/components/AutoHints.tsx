import { useEffect } from 'react';

/**
 * Hover hints everywhere (owner request 2026-11-26). Native `title` is the system default for a hover hint, and an icon-only control already
 * carries its name in `aria-label`. This gives such a control (button, link, tab) the same words as a hover hint, the first time the pointer
 * or the keyboard reaches it, so no screen needs a hand-written `title` for its icon buttons. It never replaces words someone wrote: a control
 * with its own `title`, or inside a `Tip` (marked `data-has-tip`), is left alone. Nothing is read from or written to the server.
 */
export function AutoHints() {
  useEffect(() => {
    const give = (e: Event) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      const el = t.closest('button, a[href], [role="button"], [role="tab"]');
      if (!el || el.hasAttribute('title') || el.hasAttribute('data-has-tip') || el.closest('[data-has-tip]')) return;
      const name = el.getAttribute('aria-label')?.trim();
      if (name) el.setAttribute('title', name);
    };
    document.addEventListener('pointerover', give, true);
    document.addEventListener('focusin', give, true);
    return () => { document.removeEventListener('pointerover', give, true); document.removeEventListener('focusin', give, true); };
  }, []);
  return null;
}
