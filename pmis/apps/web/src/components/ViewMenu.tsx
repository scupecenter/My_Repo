import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export type ViewOption = { id: string; label: string; hint?: string; icon: ReactNode; testid: string };

/**
 * One toolbar button that picks how a table is shown (list, wide table, grid, board, map). It takes the place of the row of layout buttons, so the
 * toolbar keeps its width: an icon and the name of the current view, a menu of the others. A menu button for the keyboard: Enter or Space opens it, the
 * arrows, Home and End move, Enter picks, Escape closes and the focus returns to the button. Every item keeps the test id of the old layout button.
 */
export function ViewMenu({ testid, title, value, options, onChange }: { testid: string; title: string; value: string; options: ViewOption[]; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = options.find((o) => o.id === value) ?? options[0];
  const focusAt = (i: number) => refs.current[(i + options.length) % options.length]?.focus();
  useEffect(() => {
    if (!open) return;
    const at = Math.max(0, options.findIndex((o) => o.id === value));
    const h = window.setTimeout(() => refs.current[at]?.focus(), 0);
    return () => window.clearTimeout(h);
  }, [open, options, value]);
  const onKey = (e: KeyboardEvent, i: number) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); focusAt(i + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusAt(i - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusAt(0); }
    else if (e.key === 'End') { e.preventDefault(); focusAt(options.length - 1); }
  };
  if (!current) return null;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className="btn px-2 py-1 text-xs" data-testid={testid} aria-haspopup="menu" aria-expanded={open} aria-label={`${title}: ${current.label}`} title={title}>
          {current.icon}<span className="hidden sm:inline">{current.label}</span><ChevronDown size={12} aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} role="menu" aria-label={title} className="card z-50 min-w-60 p-1 shadow-lg" data-testid={`${testid}-panel`}>
          {options.map((o, i) => (
            <button key={o.id} ref={(el) => { refs.current[i] = el; }} type="button" role="menuitemradio" aria-checked={o.id === current.id} data-testid={o.testid}
              className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-hover focus-visible:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              onKeyDown={(e) => onKey(e, i)} onClick={() => { setOpen(false); if (o.id !== current.id) onChange(o.id); }}>
              <span className="mt-0.5">{o.icon}</span>
              <span className="flex-1"><span className="block">{o.label}</span>{o.hint && <span className="block text-xs text-mute">{o.hint}</span>}</span>
              {o.id === current.id && <Check size={14} aria-hidden className="mt-0.5" />}
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
