/**
 * The floating notification panel (appearance dimension `inbox_anchor`): the panel sits at one of the four corners of the window.
 * "start" and "end" are the logical inline sides, so the choice mirrors in RTL; a drag snaps to the nearest corner and the arrow
 * keys move it, so the choice is a small enumerated value in the appearance profile (no pixel coordinates are stored).
 */
export type InboxAnchor = 'end-top' | 'end-bottom' | 'start-top' | 'start-bottom';

export const ANCHOR_CLASS: Record<InboxAnchor, string> = {
  'end-top': 'end-4 top-16',
  'end-bottom': 'end-4 bottom-4',
  'start-top': 'start-4 top-16',
  'start-bottom': 'start-4 bottom-4',
};

/** The corner nearest to a point of the window; `rtl` flips the physical left/right to the inline start/end. */
export function anchorFromPoint(x: number, y: number, w: number, h: number, rtl: boolean): InboxAnchor {
  const right = x >= w / 2;
  const bottom = y >= h / 2;
  const inlineEnd = rtl ? !right : right;
  return `${inlineEnd ? 'end' : 'start'}-${bottom ? 'bottom' : 'top'}` as InboxAnchor;
}

/** An arrow key moves the panel to the next corner in that direction (physical arrows, mirrored in RTL); null for any other key. */
export function anchorFromKey(key: string, cur: InboxAnchor, rtl: boolean): InboxAnchor | null {
  let [side, vert] = cur.split('-') as ['start' | 'end', 'top' | 'bottom'];
  if (key === 'ArrowUp') vert = 'top';
  else if (key === 'ArrowDown') vert = 'bottom';
  else if (key === 'ArrowLeft') side = rtl ? 'end' : 'start';
  else if (key === 'ArrowRight') side = rtl ? 'start' : 'end';
  else return null;
  return `${side}-${vert}` as InboxAnchor;
}
