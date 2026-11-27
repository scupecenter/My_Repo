import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export type ComboOption = { id: string; label: string; hint?: string; icon?: ReactNode; badge?: ReactNode; disabled?: boolean; search?: string };

/**
 * The shared combobox of the Data hub: type to filter, arrows to move, Enter to pick, Escape to close, Home and End, full ARIA
 * (combobox, listbox, option, aria-activedescendant). It opens on focus-by-click or on ArrowDown, so a keyboard user can pick without the pointer. The list is
 * drawn in a popover, so it never grows the page. Every option may carry an icon, a hint line and a badge; the control has a visible label and a hover hint.
 */
export function Combobox({ testid, label, placeholder, value, options, onChange, emptyText, tip, width = 'w-full', autoFocus }: {
  testid: string; label: string; placeholder: string; value: string; options: ComboOption[]; onChange: (id: string) => void; emptyText: string; tip?: string; width?: string; autoFocus?: boolean;
}) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [nav, setNav] = useState<{ k: string; i: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const current = options.find((o) => o.id === value);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? options.filter((o) => `${o.label} ${o.search ?? ''} ${o.hint ?? ''}`.toLowerCase().includes(needle)) : options;
  }, [options, q]);
  // The highlighted row follows the selected one whenever the list, the value or the open state changes; arrows move it until then.
  const sig = `${open}|${value}|${shown.map((o) => o.id).join(',')}`;
  const active = nav && nav.k === sig ? nav.i : Math.max(0, shown.findIndex((o) => o.id === value));
  const setActive = (i: number) => setNav({ k: sig, i });
  useEffect(() => { if (autoFocus) input.current?.focus(); }, [autoFocus]);
  const pick = (o: ComboOption | undefined) => { if (!o || o.disabled) return; onChange(o.id); setOpen(false); setQ(''); };
  const move = (d: number) => { if (!shown.length) return; let i = active; for (let n = 0; n < shown.length; n++) { i = (i + d + shown.length) % shown.length; if (!shown[i]?.disabled) break; } setActive(i); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) setOpen(true); else move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (!open) setOpen(true); else move(-1); }
    else if (e.key === 'Home' && open) { e.preventDefault(); setActive(0); }
    else if (e.key === 'End' && open) { e.preventDefault(); setActive(Math.max(0, shown.length - 1)); }
    else if (e.key === 'Enter' && open) { e.preventDefault(); e.stopPropagation(); pick(shown[active]); }
    else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); setQ(''); }
  };
  const listId = `${uid}-list`, optId = (i: number) => `${uid}-opt-${i}`;
  return (
    <Popover.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQ(''); }}>
      <div className={`relative ${width}`}>
        <Popover.Anchor asChild>
          <div className="relative">
            <input
              ref={input} role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-label={label} title={tip ?? label}
              aria-activedescendant={open && shown[active] ? optId(active) : undefined} data-testid={testid} autoComplete="off" spellCheck={false}
              className="input w-full pe-8" placeholder={current ? current.label : placeholder}
              value={open ? q : (current?.label ?? '')} onChange={(e) => { setQ(e.target.value); if (!open) setOpen(true); }} onKeyDown={onKey}
              onClick={() => setOpen(true)} onFocus={(e) => e.currentTarget.select()}
            />
            <ChevronDown size={14} aria-hidden className="pointer-events-none absolute end-2 top-1/2 -translate-y-1/2 text-mute" />
          </div>
        </Popover.Anchor>
      </div>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={4} onOpenAutoFocus={(e) => e.preventDefault()} onInteractOutside={(e) => { if (e.target instanceof Node && input.current?.contains(e.target)) e.preventDefault(); }}
          className="card z-50 max-h-72 w-[var(--radix-popover-trigger-width)] min-w-56 overflow-auto p-1 shadow-lg" data-testid={`${testid}-panel`}>
          <div id={listId} role="listbox" aria-label={label}>
            {shown.map((o, i) => (
              <div key={o.id} id={optId(i)} role="option" aria-selected={o.id === value} aria-disabled={o.disabled || undefined} data-testid={`${testid}-opt-${o.id}`} data-active={i === active ? '' : undefined}
                onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o)}
                className={`flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 text-sm ${i === active ? 'bg-hover' : ''} ${o.disabled ? 'cursor-not-allowed opacity-50' : ''}`}>
                {o.icon && <span className="mt-0.5 shrink-0">{o.icon}</span>}
                <span className="min-w-0 flex-1"><span className={`block truncate ${o.id === value ? 'font-semibold' : ''}`}>{o.label}</span>{o.hint && <span className="block text-xs text-mute">{o.hint}</span>}</span>
                {o.badge}
                {o.id === value && <Check size={14} aria-hidden className="mt-0.5 shrink-0" />}
              </div>
            ))}
            {!shown.length && <p className="px-2 py-2 text-sm text-mute" role="status" data-testid={`${testid}-empty`}>{emptyText}</p>}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
