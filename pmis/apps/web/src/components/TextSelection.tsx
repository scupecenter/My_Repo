import { GripVertical } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Every word on a screen can be selected with the mouse and copied (owner request 2026-11-28). Two things used to stop it:
 * 1. A draggable card, row or header starts a drag when the press lands on its text, so the text could not be highlighted.
 *    Now an element marked `draggable` drags only from a `DragGrip` inside it; a press anywhere else selects text.
 * 2. After a drag-select across a row or card, the browser sends a click to it, which opened the record or followed the link.
 *    A click that ends a text selection is now ignored (a plain click, with no selection, works as before).
 * Nothing is read from or written to the server. Inputs, text areas and buttons are left alone.
 */
export function DragGrip({ className = '' }: { className?: string }) {
  const { t } = useTranslation();
  const label = t('table.drag_grip');
  return (
    <span data-grip="" role="img" aria-label={label} title={label} className={`inline-flex shrink-0 cursor-grab items-center text-mute ${className}`}>
      <GripVertical size={14} aria-hidden />
    </span>
  );
}

const FORM = 'input, textarea, select, [contenteditable="true"]';

export function TextSelectionGuard() {
  useEffect(() => {
    let held: HTMLElement | null = null;
    const release = () => { if (held) { held.setAttribute('draggable', 'true'); held = null; } };
    const down = (e: Event) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      const d = t.closest('[draggable="true"]');
      if (!(d instanceof HTMLElement) || d.hasAttribute('data-any-drag')) return;
      if (t.closest('[data-grip]') && d.contains(t.closest('[data-grip]'))) return;
      // not from the grip: the press selects text instead of starting a drag
      d.setAttribute('draggable', 'false');
      held = d;
    };
    const click = (e: Event) => {
      const t = e.target;
      if (!(t instanceof Element) || t.closest(FORM)) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
      const [x, y] = [sel.anchorNode, sel.focusNode];
      // the click lands on the nearest common parent of where the press began and ended, so it holds one end of the selection
      if (!((x && (t.contains(x) || x.contains(t))) || (y && (t.contains(y) || y.contains(t))))) return;
      e.stopPropagation();
      e.preventDefault();
    };
    document.addEventListener('mousedown', down, true);
    document.addEventListener('mouseup', release, true);
    document.addEventListener('dragend', release, true);
    document.addEventListener('click', click, true);
    return () => {
      document.removeEventListener('mousedown', down, true);
      document.removeEventListener('mouseup', release, true);
      document.removeEventListener('dragend', release, true);
      document.removeEventListener('click', click, true);
    };
  }, []);
  return null;
}
