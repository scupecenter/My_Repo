import { useEffect } from 'react';
import { swipeOn, swipeOf } from '@/lib/swipe';

/**
 * Item 17: swipe on a card (anything marked `data-swipe`) with a finger. Toward the end of the line runs the card's own main control (`data-swipe-action`, only if
 * enabled, so rights stay where they are). Toward the start opens the standard context menu of the card, which a phone cannot right-click.
 * Mouse and pen are never touched; text fields and buttons that are being pressed are left alone. Mounted once in the shell.
 */
export function CardSwipe() {
  useEffect(() => {
    let start: { x: number; y: number; el: HTMLElement } | null = null;
    const down = (e: PointerEvent) => {
      start = null;
      if (e.pointerType !== 'touch' || !swipeOn()) return;
      const tg = e.target as Element | null;
      if (tg?.closest('input,textarea,select,[contenteditable="true"]')) return;
      const el = tg?.closest<HTMLElement>('[data-swipe]');
      if (el) start = { x: e.clientX, y: e.clientY, el };
    };
    const up = (e: PointerEvent) => {
      const s = start; start = null;
      if (!s || e.pointerType !== 'touch') return;
      const dir = swipeOf(e.clientX - s.x, e.clientY - s.y, document.documentElement.dir === 'rtl');
      if (!dir) return;
      if (dir === 'forward') {
        const c = s.el.querySelector<HTMLElement>('[data-swipe-action]');
        if (c && !(c as HTMLButtonElement).disabled && c.getAttribute('aria-disabled') !== 'true') c.click();
      } else {
        s.el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY }));
      }
    };
    const cancel = () => { start = null; };
    window.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    return () => { window.removeEventListener('pointerdown', down); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); };
  }, []);
  return null;
}
