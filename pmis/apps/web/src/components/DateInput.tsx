import { CalendarDays } from 'lucide-react';
import { useRef, useState, type ChangeEvent, type InputHTMLAttributes } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The one date field of the system (visual review 2026-11-27, item 4). The browser's own date field shows the browser's locale (mm/dd/yyyy on an
 * English browser, even in the Arabic UI) while every date the system shows is ISO. This field is typed and shown as YYYY-MM-DD in both languages,
 * accepts Arabic-Indic digits and "/" or "." as separators, and has a calendar button (hover hint and accessible label) that opens the native
 * picker. It is a drop-in for `<input type="date">`: the value is always an ISO date or empty, and `onChange` fires only with a complete valid date or
 * an empty value, so a half-typed date never reaches a form. The whole control stays LTR in the Arabic UI too (the text always is), so the calendar
 * button keeps its place at the right of the field instead of landing on the text.
 */
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
/** Normalises typed text: Arabic-Indic digits to 0-9, "/" and "." to "-". */
export function normaliseDateText(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d))).replace(/[/.]/g, '-').trim();
}
export function isIsoDate(s: string): boolean {
  const m = ISO.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!;
}
const WRAP = /^(w-|min-w-|max-w-|m[tblrxyse]?-|flex-|grow|shrink|self-|justify-self|col-span)/;

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'defaultValue' | 'onChange' | 'placeholder'> & {
  value: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  /** false for a cell edited in place (it commits on blur, and a click on the calendar button would blur it): typed only. */
  picker?: boolean;
  'data-testid'?: string;
};

export function DateInput({ value, onChange, className = '', min, max, disabled, picker: withPicker = true, 'data-testid': testid, ...rest }: Props) {
  const { t } = useTranslation();
  const [text, setText] = useState(value ?? '');
  const [seen, setSeen] = useState(value ?? '');
  const picker = useRef<HTMLInputElement>(null);
  if ((value ?? '') !== seen) { setSeen(value ?? ''); setText(value ?? ''); }
  const tokens = className.split(/\s+/).filter(Boolean);
  const wrap = ['relative', ...tokens.filter((c) => WRAP.test(c))].join(' ');
  const inner = tokens.filter((c) => !WRAP.test(c)).join(' ');
  const out = (v: string) => !!v && ((typeof min === 'string' && min && v < min) || (typeof max === 'string' && max && v > max));
  const change = (e: ChangeEvent<HTMLInputElement>) => {
    const raw = normaliseDateText(e.target.value);
    setText(e.target.value);
    if (raw === '') onChange(e);
    else if (isIsoDate(raw)) { if (raw !== e.target.value) e.target.value = raw; onChange(e); }
  };
  const open = () => {
    const p = picker.current;
    if (!p || disabled) return;
    p.value = isIsoDate(text) ? text : '';
    try { p.showPicker(); } catch { p.focus(); p.click(); }
  };
  return (
    <span className={wrap} dir="ltr">
      <input
        {...rest}
        data-testid={testid}
        min={min} max={max}
        type="text" inputMode="numeric" dir="ltr" autoComplete="off" spellCheck={false}
        className={`${inner} ${withPicker ? 'pe-10' : ''} text-start`}
        placeholder="YYYY-MM-DD" maxLength={10} disabled={disabled}
        title={t('common.date_hint')}
        aria-invalid={out(normaliseDateText(text)) || (text !== '' && !isIsoDate(normaliseDateText(text))) || undefined}
        value={text} onChange={change}
        onBlur={(e) => { if (text !== '' && !isIsoDate(normaliseDateText(text))) setText(value ?? ''); rest.onBlur?.(e); }}
      />
      {withPicker && <button type="button" className="absolute inset-y-0 end-0 flex w-10 items-center justify-center text-mute hover:text-ink disabled:opacity-40" disabled={disabled}
        aria-label={t('common.pick_date')} data-testid={testid ? `${testid}-pick` : undefined} onClick={open}>
        <CalendarDays size={16} aria-hidden />
      </button>}
      {withPicker && <input ref={picker} type="date" tabIndex={-1} aria-hidden className="pointer-events-none absolute bottom-0 end-0 h-0 w-0 opacity-0" min={min} max={max}
        onChange={(e) => { if (e.target.value) { setText(e.target.value); onChange(e); } }} />}
    </span>
  );
}
