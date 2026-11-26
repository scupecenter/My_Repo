import * as Tooltip from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';

/** Radix tooltip (plan T3/G5): names an icon-only control, explains an action (what it does, its state), or shows the full value of a truncated cell. Content is not rendered when `text` is empty. The trigger carries `data-has-tip` so AutoHints leaves it alone. */
export function Tip({ text, children, side = 'top' }: { text?: string | null; children: ReactNode; side?: 'top' | 'bottom' }) {
  if (!text) return <>{children}</>;
  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild data-has-tip="">{children}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content side={side} sideOffset={4} className="card z-[80] max-w-80 break-words px-2 py-1 text-xs" data-testid="tip">{text}</Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
