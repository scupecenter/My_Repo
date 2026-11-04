import { useQuery } from '@tanstack/react-query';
import { Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { usePicker } from '@/api/sites';
import type { Page, RecordRefs, RegisterField, RegisterFieldColumn, SiteListItem } from '@/api/types';

/**
 * Contract 0.12.5 (work package P5): the inputs of the new register field types. Values are ids, as the API stores them; `refs` (RegisterRecord.refs)
 * and the names picked in this session give the labels. multi_user and multi_site are chips with a search, file picks one of the record's uploaded files,
 * child_list is a small table whose rows keep the id the server gave them, warehouse_item takes the item code.
 */
export type FieldCtx = { refs?: RecordRefs; files?: { id: string; name: string }[] };
type Row = Record<string, unknown>;

const label = (lang: string, o: { label_en: string; label_ar?: string | null }) => (lang === 'ar' && o.label_ar) || o.label_en;

function Chips({ items, onRemove, testid, disabled }: { items: { id: string; text: string }[]; onRemove: (id: string) => void; testid: string; disabled?: boolean }) {
  const { t } = useTranslation();
  return (
    <ul className="flex flex-wrap gap-1" data-testid={`${testid}-chips`}>
      {items.map((x) => (
        <li key={x.id} className="chip bg-openBg text-openInk" data-testid={`${testid}-chip`}>{x.text}
          {!disabled && <button type="button" className="ms-1" aria-label={t('fieldTypes.remove', { name: x.text })} onClick={() => onRemove(x.id)}><X size={12} /></button>}
        </li>
      ))}
    </ul>
  );
}

/** Several people (attendees): search by name or employee ID, add as a chip. */
export function MultiUserInput({ id, value, onChange, ctx, disabled }: { id: string; value: unknown; onChange: (v: string[]) => void; ctx?: FieldCtx; disabled?: boolean }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [names, setNames] = useState<Record<string, string>>({});
  const res = usePicker(q);
  const ids = Array.isArray(value) ? (value as string[]) : [];
  const text = (u: string) => names[u] ?? ctx?.refs?.users?.[u]?.display_name ?? u;
  return (
    <div className="space-y-1">
      <Chips testid={id} disabled={disabled} items={ids.map((u) => ({ id: u, text: text(u) }))} onRemove={(u) => onChange(ids.filter((x) => x !== u))} />
      {!disabled && (
        <div className="relative">
          <input id={id} data-testid={id} className="input" placeholder={t('picker.search')} value={q} onChange={(e) => setQ(e.target.value)} />
          {q.trim().length >= 2 && (
            <ul className="card absolute inset-x-0 z-10 mt-1 max-h-48 overflow-y-auto text-sm">
              {(res.data ?? []).filter((u) => !ids.includes(u.id)).map((u) => (
                <li key={u.id}><button type="button" data-testid={`${id}-opt-${u.employee_id ?? u.id}`} className="w-full p-2 text-start hover:bg-hover"
                  onClick={() => { setNames((n) => ({ ...n, [u.id]: u.display_name })); onChange([...ids, u.id]); setQ(''); }}>{u.display_name} <span className="mono text-xs text-mute">{u.employee_id}</span></button></li>
              ))}
              {res.isSuccess && !res.data.length && <li className="p-2 text-mute">{t('picker.none')}</li>}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Several sites (a meeting's linked sites): none = a project-wide record. */
export function MultiSiteInput({ id, value, onChange, ctx, disabled }: { id: string; value: unknown; onChange: (v: string[]) => void; ctx?: FieldCtx; disabled?: boolean }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [codes, setCodes] = useState<Record<string, string>>({});
  const res = useQuery({ queryKey: ['site-search', q], enabled: q.trim().length >= 2, queryFn: () => api.get<Page<SiteListItem>>('/sites', { query: { q: q.trim(), limit: 8 } }) });
  const ids = Array.isArray(value) ? (value as string[]) : [];
  return (
    <div className="space-y-1">
      <Chips testid={id} disabled={disabled} items={ids.map((s) => ({ id: s, text: codes[s] ?? ctx?.refs?.sites?.[s] ?? s }))} onRemove={(s) => onChange(ids.filter((x) => x !== s))} />
      {!ids.length && <p className="text-xs text-mute" data-testid={`${id}-project`}>{t('fieldTypes.project_wide')}</p>}
      {!disabled && (
        <div className="relative">
          <input id={id} data-testid={id} className="input" placeholder={t('registers.site_search')} value={q} onChange={(e) => setQ(e.target.value)} />
          {q.trim().length >= 2 && (
            <ul className="card absolute inset-x-0 z-10 mt-1 max-h-48 overflow-y-auto text-sm">
              {(res.data?.items ?? []).filter((s) => !ids.includes(s.id)).map((s) => (
                <li key={s.id}><button type="button" data-testid={`${id}-opt-${s.site_code}`} className="w-full p-2 text-start hover:bg-hover"
                  onClick={() => { setCodes((c) => ({ ...c, [s.id]: s.site_code })); onChange([...ids, s.id]); setQ(''); }}><b className="mono">{s.site_code}</b> {s.name}</button></li>
              ))}
              {res.isSuccess && !res.data.items.length && <li className="p-2 text-mute">{t('picker.none')}</li>}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** A file field: one of the files uploaded to the record's documents (a typed reference is not an upload, Q111). */
export function FileFieldInput({ id, value, onChange, ctx, disabled }: { id: string; value: unknown; onChange: (v: string) => void; ctx?: FieldCtx; disabled?: boolean }) {
  const { t } = useTranslation();
  const files = ctx?.files ?? [];
  const cur = typeof value === 'string' ? value : '';
  if (!files.length && !cur) return <p className="text-sm text-mute" data-testid={`${id}-none`}>{t('fieldTypes.file_none')}</p>;
  return (
    <select id={id} data-testid={id} className="input" disabled={disabled} value={cur} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t('registers.choose')}</option>
      {cur && !files.some((f) => f.id === cur) && <option value={cur}>{ctx?.refs?.files?.[cur] ?? t('fieldTypes.file_missing')}</option>}
      {files.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
    </select>
  );
}

/** One person of a child-list row: a small search that stores the id. */
export function CellUser({ id, value, onChange, ctx }: { id: string; value: unknown; onChange: (v: string | null) => void; ctx?: FieldCtx }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [name, setName] = useState<string | null>(null);
  const res = usePicker(q);
  if (typeof value === 'string' && value) {
    return <span className="chip bg-openBg text-openInk" data-testid={`${id}-chosen`}>{name ?? ctx?.refs?.users?.[value]?.display_name ?? value}
      <button type="button" className="ms-1" aria-label={t('common.clear')} onClick={() => onChange(null)}><X size={12} /></button></span>;
  }
  return (
    <div className="relative">
      <input data-testid={id} aria-label={t('fieldTypes.person')} className="input" placeholder={t('picker.search')} value={q} onChange={(e) => setQ(e.target.value)} />
      {q.trim().length >= 2 && (
        <ul className="card absolute inset-x-0 z-10 mt-1 max-h-40 overflow-y-auto text-sm">
          {(res.data ?? []).map((u) => <li key={u.id}><button type="button" data-testid={`${id}-opt-${u.employee_id ?? u.id}`} className="w-full p-2 text-start hover:bg-hover" onClick={() => { setName(u.display_name); onChange(u.id); setQ(''); }}>{u.display_name}</button></li>)}
        </ul>
      )}
    </div>
  );
}

function Cell({ col, value, onChange, id, ctx, lang }: { col: RegisterFieldColumn; value: unknown; onChange: (v: unknown) => void; id: string; ctx?: FieldCtx; lang: string }) {
  const { t } = useTranslation();
  const aria = label(lang, col);
  switch (col.type) {
    case 'date': return <input type="date" aria-label={aria} data-testid={id} className="input mono" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'number': return <input type="number" aria-label={aria} data-testid={id} className="input mono" value={(value as number | string) ?? ''} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />;
    case 'yes_no': return <input type="checkbox" aria-label={aria} data-testid={id} checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
    case 'user': return <CellUser id={id} value={value} onChange={onChange} ctx={ctx} />;
    case 'list': return (
      <select aria-label={aria} data-testid={id} className="input" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('registers.choose')}</option>
        {(col.options ?? []).map((o) => <option key={o.value} value={o.value}>{label(lang, o)}</option>)}
      </select>
    );
    case 'task': return typeof value === 'string' && ctx?.refs?.tasks?.[value]
      ? <span className="mono" data-testid={id}>{ctx.refs.tasks[value]}</span>
      : <input aria-label={aria} data-testid={id} className="input mono" placeholder={t('fieldTypes.task_hint')} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />;
    default: return <input aria-label={aria} data-testid={id} className="input" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />;
  }
}

/** A child list (the action items of a meeting): rows of the field's columns; a row keeps its server id, so it is never entered twice. */
export function ChildListInput({ field, value, onChange, ctx, disabled }: { field: RegisterField; value: unknown; onChange: (v: Row[]) => void; ctx?: FieldCtx; disabled?: boolean }) {
  const { t, i18n } = useTranslation();
  const rows = Array.isArray(value) ? (value as Row[]) : [];
  const cols = field.columns ?? [];
  const id = `reg-field-${field.code}`;
  const set = (i: number, code: string, v: unknown) => onChange(rows.map((r, j) => (j === i ? { ...r, [code]: v === '' || v === null ? undefined : v } : r)));
  return (
    <div className="overflow-x-auto" data-testid={id}>
      <table className="w-full text-sm">
        <thead className="text-mute"><tr>{cols.map((c) => <th key={c.code} className="p-1 text-start">{label(i18n.language, c)}{c.required ? ' *' : ''}</th>)}<th /></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={(r.id as string) ?? `new-${i}`} className="border-t border-line" data-testid={`${id}-row-${i}`}>
              {cols.map((c) => (
                <td key={c.code} className="p-1 align-top">
                  {disabled ? <span data-testid={`${id}-${i}-${c.code}`}>{showCell(c, r[c.code], i18n.language, t, ctx)}</span>
                    : <Cell col={c} value={r[c.code]} onChange={(v) => set(i, c.code, v)} id={`${id}-${i}-${c.code}`} ctx={ctx} lang={i18n.language} />}
                </td>
              ))}
              <td className="p-1">{!disabled && <button type="button" className="btn btn-ghost p-1" data-testid={`${id}-remove-${i}`} aria-label={t('fieldTypes.remove_row')} onClick={() => onChange(rows.filter((_, j) => j !== i))}><Trash2 size={14} /></button>}</td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={cols.length + 1} className="p-2 text-mute">{t('fieldTypes.no_rows')}</td></tr>}
        </tbody>
      </table>
      {!disabled && <button type="button" className="btn mt-1" data-testid={`${id}-add`} onClick={() => onChange([...rows, {}])}><Plus size={14} />{t('fieldTypes.add_row')}</button>}
    </div>
  );
}

export function showCell(c: RegisterFieldColumn, v: unknown, lang: string, t: ReturnType<typeof useTranslation>['t'], ctx?: FieldCtx): string {
  if (v === undefined || v === null || v === '') return '—';
  if (c.type === 'yes_no') return v ? t('common.yes') : t('common.no');
  if (c.type === 'user' && typeof v === 'string') return ctx?.refs?.users?.[v]?.display_name ?? v;
  if (c.type === 'task' && typeof v === 'string') return ctx?.refs?.tasks?.[v] ?? v;
  if (c.type === 'list') { const o = c.options?.find((x) => x.value === v); return o ? label(lang, o) : String(v); }
  return String(v);
}

/** Read-only text of a value of the new types. Returns null for the other types. */
export function showTyped(f: RegisterField, v: unknown, lang: string, t: ReturnType<typeof useTranslation>['t'], ctx?: FieldCtx): string | null {
  const refs = ctx?.refs;
  switch (f.type) {
    case 'multi_user': return Array.isArray(v) ? v.map((u) => refs?.users?.[u as string]?.display_name ?? String(u)).join(', ') : null;
    case 'multi_site': return Array.isArray(v) ? (v.length ? v.map((s) => refs?.sites?.[s as string] ?? String(s)).join(', ') : t('fieldTypes.project_wide')) : null;
    case 'multi_list': return Array.isArray(v) ? v.map((x) => { const o = f.options?.find((y) => y.value === x); return o ? label(lang, o) : String(x); }).join(', ') : null;
    case 'warehouse_item': return typeof v === 'string' ? (refs?.warehouse_items?.[v] ? `${refs.warehouse_items[v].item_code} — ${refs.warehouse_items[v].name}` : v) : null;
    case 'file': return typeof v === 'string' ? (refs?.files?.[v] ?? t('fieldTypes.file_missing')) : null;
    case 'child_list': return Array.isArray(v) ? t('fieldTypes.rows', { count: v.length }) : null;
    default: return null;
  }
}
