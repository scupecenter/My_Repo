import { useEffect, useRef, useState } from 'react';

/**
 * A table cell that is edited in place: click (or Enter on the focused cell) turns the value into an input; Enter or leaving the field saves, Esc cancels.
 * The cell only asks `onCommit` to save; the caller decides where it goes (the DRAFT version for the SLA rules, so nothing goes live before Publish).
 * Nothing is saved when the value did not change or when `disabled`. A failed save keeps the editor open and shows the message.
 */
export interface InlineCellProps {
  value: string | number | null | undefined;
  /** What to show when not editing (defaults to the value, or "-" when empty). */
  display?: React.ReactNode;
  kind?: 'number' | 'text' | 'date' | 'select';
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  disabled?: boolean;
  label: string;
  testid?: string;
  onCommit: (next: string) => Promise<unknown> | void;
  dir?: 'rtl' | 'ltr';
}

export function InlineCell({ value, display, kind = 'text', options, min, max, disabled, label, testid, onCommit, dir }: InlineCellProps) {
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement & HTMLSelectElement>(null);
  const cur = value === null || value === undefined ? '' : String(value);
  useEffect(() => { if (edit) ref.current?.focus(); }, [edit]);

  const start = () => { if (disabled || busy) return; setV(cur); setErr(null); setEdit(true); };
  const cancel = () => { setEdit(false); setErr(null); };
  const commit = async () => {
    if (busy) return;
    if (v === cur) return cancel();
    if (kind === 'number' && v !== '' && (Number.isNaN(Number(v)) || (min !== undefined && Number(v) < min) || (max !== undefined && Number(v) > max))) {
      setErr(`${min ?? ''}-${max ?? ''}`);
      return;
    }
    setBusy(true);
    try { await onCommit(v); setEdit(false); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); void commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  };

  if (!edit) {
    const shown = display ?? (cur === '' ? '-' : cur);
    if (disabled) return <span data-testid={testid}>{shown}</span>;
    return (
      <button type="button" className="w-full rounded px-1 text-start hover:bg-hover focus-visible:outline focus-visible:outline-2" title={label} aria-label={`${label}: ${cur === '' ? '-' : cur}`} data-testid={testid} onClick={start}>
        {shown}
      </button>
    );
  }
  return (
    <span className="block">
      {kind === 'select' ? (
        <select ref={ref} className="input w-full" aria-label={label} data-testid={testid ? `${testid}-input` : undefined} value={v} disabled={busy} onChange={(e) => setV(e.target.value)} onKeyDown={onKey} onBlur={() => void commit()}>
          {(options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : (
        <input ref={ref} className="input w-full" type={kind} min={min} max={max} dir={dir} aria-label={label} data-testid={testid ? `${testid}-input` : undefined} value={v} disabled={busy} onChange={(e) => setV(e.target.value)} onKeyDown={onKey} onBlur={() => void commit()} />
      )}
      {err && <span role="alert" className="mt-1 block text-xs text-lateInk" data-testid={testid ? `${testid}-err` : undefined}>{err}</span>}
    </span>
  );
}
