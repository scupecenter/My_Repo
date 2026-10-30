import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { usePicker } from '@/api/sites';
import type { Page, RegisterField, SiteListItem } from '@/api/types';
import { DATE_MAX, DATE_MIN, type FieldIssue } from '@/lib/registerForms';

export const fieldLabel = (f: RegisterField, lang: string) => (lang === 'ar' && f.label_ar) || f.label_en;

/** Plain sentence for one field problem (client check or server 422). */
export function issueText(t: ReturnType<typeof useTranslation>['t'], label: string, i: FieldIssue, other?: (code: string) => string) {
  return t(`regErrors.${i.code}`, { field: label, other: other?.(i.params?.other ?? '') ?? '', min: i.params?.min, max: i.params?.max, defaultValue: t('regErrors.invalid', { field: label }) });
}

type Person = { id: string; display_name: string; employee_id?: string | null };

function UserField({ id, value, onChange, disabled }: { id: string; value: Person | null; onChange: (v: Person | null) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const res = usePicker(q);
  if (value) return (
    <span className="flex items-center gap-2" data-testid={`${id}-chosen`}><span className="chip bg-openBg text-openInk">{value.display_name}{value.employee_id && <span className="mono ms-1 text-xs">{value.employee_id}</span>}</span>
      {!disabled && <button type="button" className="btn px-2 py-0.5 text-xs" onClick={() => onChange(null)}>{t('common.clear')}</button>}</span>
  );
  return (
    <div className="relative">
      <input id={id} data-testid={id} className="input" placeholder={t('picker.search')} value={q} disabled={disabled} onChange={(e) => setQ(e.target.value)} />
      {q.trim().length >= 2 && (
        <ul className="card absolute inset-x-0 z-10 mt-1 max-h-48 overflow-y-auto text-sm">
          {(res.data ?? []).map((u) => <li key={u.id}><button type="button" className="w-full p-2 text-start hover:bg-hover" onClick={() => { onChange({ id: u.id, display_name: u.display_name, employee_id: u.employee_id }); setQ(''); }}>{u.display_name} <span className="mono text-xs text-mute">{u.employee_id}</span></button></li>)}
          {res.isSuccess && !res.data.length && <li className="p-2 text-mute">{t('picker.none')}</li>}
        </ul>
      )}
    </div>
  );
}

/** One input for one register field, from its contract type. `has_expiry` and other yes/no fields are switches (Q63c). */
export function FieldInput({ field, value, onChange, disabled, invalid }: { field: RegisterField; value: unknown; onChange: (v: unknown) => void; disabled?: boolean; invalid?: boolean }) {
  const { t, i18n } = useTranslation();
  const id = `reg-field-${field.code}`;
  const ro = disabled || field.read_only;
  const common = { id, 'data-testid': id, disabled: ro, 'aria-invalid': invalid || undefined, 'aria-describedby': invalid ? `${id}-error` : undefined };
  switch (field.type) {
    case 'date':
      return <input type="date" className="input mono" min={DATE_MIN} max={DATE_MAX} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} {...common} />;
    case 'number':
      return <input type="number" className="input mono" value={(value as number | string) ?? ''} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} {...common} />;
    case 'yes_no':
      return (
        <label className="flex items-center gap-2">
          <input type="checkbox" role="switch" checked={value === true} onChange={(e) => onChange(e.target.checked)} {...common} />
          <span className="text-sm">{value === true ? t('common.yes') : t('common.no')}</span>
        </label>
      );
    case 'list':
    case 'external_party':
      if (field.options?.length) return (
        <select className="input" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} {...common}>
          <option value="">{t('registers.choose')}</option>
          {field.options.map((o) => <option key={o.value} value={o.value}>{(i18n.language === 'ar' && o.label_ar) || o.label_en}</option>)}
        </select>
      );
      return <input className="input" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} {...common} />;
    case 'user':
      return <UserField id={id} value={(value as Person | null) ?? null} onChange={onChange} disabled={ro} />;
    default:
      return <input className="input" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} {...common} />;
  }
}

/** Read-only text of a value (list label, yes/no, person name). */
export function showValue(f: RegisterField, v: unknown, lang: string, t: ReturnType<typeof useTranslation>['t']): string {
  if (v === undefined || v === null || v === '') return '—';
  if (f.type === 'yes_no') return v ? t('common.yes') : t('common.no');
  if (f.type === 'user') return (v as Person).display_name ?? '—';
  if (f.type === 'list' || f.type === 'external_party') { const o = f.options?.find((x) => x.value === v); return o ? ((lang === 'ar' && o.label_ar) || o.label_en) : String(v); }
  return String(v);
}

/** Site chooser: search the Site Register by code or name (V1: the site must exist). */
export function SitePicker({ value, onChange, disabled, invalid }: { value: { id: string; code: string } | null; onChange: (s: { id: string; code: string; region_id: number } | null) => void; disabled?: boolean; invalid?: boolean }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const res = useQuery({ queryKey: ['site-search', q], enabled: q.trim().length >= 2, queryFn: () => api.get<Page<SiteListItem>>('/sites', { query: { q: q.trim(), limit: 8 } }) });
  if (value) return (
    <span className="flex items-center gap-2" data-testid="reg-site-chosen"><b className="mono">{value.code}</b>
      {!disabled && <button type="button" className="btn px-2 py-0.5 text-xs" data-testid="reg-site-clear" onClick={() => onChange(null)}>{t('common.clear')}</button>}</span>
  );
  return (
    <div className="relative">
      <input data-testid="reg-site-search" id="reg-site" className="input" aria-invalid={invalid || undefined} aria-describedby={invalid ? 'reg-site-error' : undefined} placeholder={t('registers.site_search')} value={q} onChange={(e) => setQ(e.target.value)} />
      {q.trim().length >= 2 && (
        <ul className="card absolute inset-x-0 z-10 mt-1 max-h-48 overflow-y-auto text-sm" data-testid="reg-site-results">
          {(res.data?.items ?? []).map((s) => <li key={s.id}><button type="button" data-testid={`reg-site-opt-${s.site_code}`} className="w-full p-2 text-start hover:bg-hover" onClick={() => { onChange({ id: s.id, code: s.site_code, region_id: s.region_id }); setQ(''); }}><b className="mono">{s.site_code}</b> {s.name}</button></li>)}
          {res.isSuccess && !res.data.items.length && <li className="p-2 text-mute">{t('picker.none')}</li>}
        </ul>
      )}
    </div>
  );
}
