import { Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAddListValue, useCreateList, useListCatalogues, useUpdateList, useUpdateListValue } from '@/api/lists';
import type { ListCatalogue, ListValue } from '@/api/types';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { fieldErrors } from '@/lib/fields';

const split = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
const nameOf = (c: ListCatalogue, lang: string) => (lang === 'ar' && c.name_ar) || c.name_en;
/** 0.13.2 (Q260): the Severity list mirrors the snag severities; its values are changed in Settings, QC snag severities, never here. */
const mirrored = (c: ListCatalogue) => c.code === 'Severity';

type Dlg =
  | { kind: 'new-list' }
  | { kind: 'edit-list'; list: ListCatalogue }
  | { kind: 'new-value'; list: ListCatalogue }
  | { kind: 'edit-value'; list: ListCatalogue; value: ListValue };

/**
 * Settings, lists (contract 0.12.5, Q104): every list of a register is data. A value keeps its code for ever (the code is what the records store); its labels,
 * aliases (old names that map to it), groups and order can change, and it is deactivated, never deleted. `pending` lists are drafts for the owner's review;
 * a critical list accepts only its own values and blocks approvals while it has none. Every save needs a reason and is audited.
 */
export function Lists() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const toast = useToast();
  const q = useListCatalogues(true);
  const [filter, setFilter] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const items = (q.data ?? []).filter((c) => !filter.trim() || `${c.code} ${c.name_en} ${c.name_ar ?? ''}`.toLowerCase().includes(filter.trim().toLowerCase()));
  const cur = q.data?.find((c) => c.code === sel) ?? null;

  return (
    <section className="space-y-3" data-testid="page-lists">
      <div className="card space-y-3 p-4">
        <h2 className="font-bold">{t('lists.title')}</h2>
        <p className="text-sm text-mute">{t('lists.note')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <input className="input max-w-64" data-testid="lists-filter" aria-label={t('lists.filter')} placeholder={t('lists.filter')} value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button type="button" className="btn btn-accent ms-auto" data-testid="lists-new" onClick={() => setDlg({ kind: 'new-list' })}><Plus size={14} />{t('lists.new')}</button>
        </div>
        {q.isLoading && <p className="text-mute">{t('common.loading')}</p>}
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="lists-table">
            <thead className="text-mute"><tr>
              <th className="p-2 text-start">{t('lists.code')}</th><th className="p-2 text-start">{t('lists.name')}</th><th className="p-2 text-start">{t('lists.status')}</th>
              <th className="p-2 text-end">{t('lists.values')}</th><th className="p-2 text-start">{t('lists.used_by')}</th>
            </tr></thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.code} className={`cursor-pointer border-t border-line hover:bg-hover ${sel === c.code ? 'bg-accentSoft' : ''} ${c.is_active ? '' : 'opacity-60'}`} data-testid={`lists-row-${c.code}`} onClick={() => setSel(c.code)}>
                  <td className="p-2 mono">{c.code}</td>
                  <td className="p-2">{nameOf(c, lang)}</td>
                  <td className="p-2">
                    <span className={`chip ${c.status === 'confirmed' ? 'bg-doneBg text-doneInk' : 'bg-waitBg text-waitInk'}`} data-testid={`lists-status-${c.code}`}>{t(`lists.status_${c.status}`)}</span>
                    {c.critical && <span className="chip ms-1 bg-lateBg text-lateInk" data-testid={`lists-critical-${c.code}`}>{t('lists.critical')}</span>}
                    {c.allow_other && <span className="chip ms-1 bg-card2">{t('lists.allow_other')}</span>}
                    {!c.is_active && <span className="chip ms-1 bg-lockBg text-lockInk">{t('lists.inactive')}</span>}
                  </td>
                  <td className="p-2 text-end mono">{c.values.filter((v) => v.is_active).length}</td>
                  <td className="p-2 text-mute">{c.used_by.map((u) => `${u.register_key}.${u.field_code}${u.column ? `.${u.column}` : ''}`).join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {cur && (
        <div className="card space-y-3 p-4" data-testid="lists-detail">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-bold">{nameOf(cur, lang)} <span className="mono text-sm text-mute">{cur.code}</span></h3>
            {cur.critical && cur.values.every((v) => !v.is_active) && <span role="alert" className="chip bg-lateBg text-lateInk" data-testid="lists-blocking">{t('lists.blocking')}</span>}
            <button type="button" className="btn ms-auto" data-testid="lists-edit" onClick={() => setDlg({ kind: 'edit-list', list: cur })}><Pencil size={14} />{t('lists.edit')}</button>
            {!mirrored(cur) && <button type="button" className="btn btn-accent" data-testid="lists-add-value" onClick={() => setDlg({ kind: 'new-value', list: cur })}><Plus size={14} />{t('lists.add_value')}</button>}
          </div>
          {cur.description && <p className="text-sm text-mute">{cur.description}</p>}
          {mirrored(cur) && <p className="rounded-md bg-card2 p-3 text-sm" data-testid="lists-mirrored">{t('lists.mirrored')}</p>}
          <table className="w-full text-sm" data-testid="lists-values">
            <thead className="text-mute"><tr>
              <th className="p-2 text-start">{t('lists.code')}</th><th className="p-2 text-start">{t('lists.label_en')}</th><th className="p-2 text-start">{t('lists.label_ar')}</th>
              <th className="p-2 text-start">{t('lists.aliases')}</th><th className="p-2 text-start">{t('lists.groups')}</th><th />
            </tr></thead>
            <tbody>
              {cur.values.map((v) => (
                <tr key={v.id} className={`border-t border-line ${v.is_active ? '' : 'opacity-60'}`} data-testid={`lists-value-${v.code}`}>
                  <td className="p-2 mono">{v.code}{!v.is_active && <span className="chip ms-1 bg-lockBg text-lockInk">{t('lists.inactive')}</span>}</td>
                  <td className="p-2">{v.label_en}</td><td className="p-2" dir="rtl">{v.label_ar ?? '—'}</td>
                  <td className="p-2 text-mute">{v.aliases.join(', ') || '—'}</td><td className="p-2 text-mute">{v.groups.join(', ') || '—'}</td>
                  <td className="p-2 text-end">{!mirrored(cur) && <button type="button" className="btn btn-ghost p-1" data-testid={`lists-value-edit-${v.code}`} aria-label={t('lists.edit_value', { code: v.code })} onClick={() => setDlg({ kind: 'edit-value', list: cur, value: v })}><Pencil size={14} /></button>}</td>
                </tr>
              ))}
              {!cur.values.length && <tr><td colSpan={6} className="p-2 text-mute">{t('lists.no_values')}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {dlg && <ListDialog dlg={dlg} onClose={() => setDlg(null)} onDone={(code) => { toast(t('settings.audited')); setDlg(null); if (code) setSel(code); }} />}
    </section>
  );
}

function ListDialog({ dlg, onClose, onDone }: { dlg: Dlg; onClose: () => void; onDone: (code?: string) => void }) {
  const { t } = useTranslation();
  const create = useCreateList(), update = useUpdateList(), addV = useAddListValue(), updV = useUpdateListValue();
  const list = dlg.kind === 'new-list' ? null : dlg.list;
  const value = dlg.kind === 'edit-value' ? dlg.value : null;
  const [f, setF] = useState({
    code: '', name_en: list?.name_en ?? '', name_ar: list?.name_ar ?? '', critical: list?.critical ?? false, allow_other: list?.allow_other ?? false,
    status: list?.status ?? 'pending', is_active: (value ?? list)?.is_active ?? true,
    label_en: value?.label_en ?? '', label_ar: value?.label_ar ?? '', aliases: value?.aliases.join(', ') ?? '', groups: value?.groups.join(', ') ?? '', sort_order: value?.sort_order ?? 0,
  });
  const m = { 'new-list': create, 'edit-list': update, 'new-value': addV, 'edit-value': updV }[dlg.kind];
  const errs = fieldErrors(m.error);
  const set = (k: keyof typeof f) => (v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const err = (p: string) => errs[p] && <p role="alert" className="text-xs text-lateInk" data-testid={`lists-err-${p.slice(1)}`}>{t(`listErrors.${errs[p]}`, { defaultValue: t(`fieldError.${errs[p]}`, { defaultValue: errs[p] }) })}</p>;
  const isList = dlg.kind === 'new-list' || dlg.kind === 'edit-list';
  const submit = (reason: string) => {
    const done = { onSuccess: (r: ListCatalogue) => onDone(r.code) };
    if (dlg.kind === 'new-list') create.mutate({ code: f.code.trim(), name_en: f.name_en.trim(), name_ar: f.name_ar.trim() || null, critical: f.critical, allow_other: f.allow_other, reason }, done);
    else if (dlg.kind === 'edit-list') update.mutate({ code: dlg.list.code, version: dlg.list.version, body: { name_en: f.name_en.trim(), name_ar: f.name_ar.trim() || null, critical: f.critical, allow_other: f.allow_other, status: f.status as 'pending' | 'confirmed', is_active: f.is_active, reason } }, done);
    else if (dlg.kind === 'new-value') addV.mutate({ code: dlg.list.code, body: { code: f.code.trim(), ...(f.label_en.trim() ? { label_en: f.label_en.trim() } : {}), label_ar: f.label_ar.trim() || null, aliases: split(f.aliases), groups: split(f.groups), reason } }, done);
    else updV.mutate({ code: dlg.list.code, id: dlg.value.id, version: dlg.value.version, body: { label_en: f.label_en.trim(), label_ar: f.label_ar.trim() || null, aliases: split(f.aliases), groups: split(f.groups), sort_order: Number(f.sort_order), is_active: f.is_active, reason } }, done);
  };
  const title = { 'new-list': t('lists.new'), 'edit-list': t('lists.edit'), 'new-value': t('lists.add_value'), 'edit-value': t('lists.edit_value', { code: value?.code ?? '' }) }[dlg.kind];
  const input = (k: keyof typeof f, label: string, extra: Record<string, unknown> = {}) => (
    <label className="block text-sm font-semibold">{label}<input className="input mt-1 font-normal" data-testid={`lists-in-${k}`} value={String(f[k])} onChange={(e) => set(k)(e.target.value)} {...extra} /></label>
  );
  const check = (k: keyof typeof f, label: string) => (
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid={`lists-in-${k}`} checked={f[k] === true} onChange={(e) => set(k)(e.target.checked)} />{label}</label>
  );
  return (
    <FormDialog open testid="lists-dialog" title={title} busy={m.isPending} error={m.isError && !Object.keys(errs).length ? errText(m.error, t) : null} onClose={onClose} onSubmit={submit}>
      <div className="space-y-2">
        {(dlg.kind === 'new-list' || dlg.kind === 'new-value') && <>{input('code', t('lists.code'), { maxLength: dlg.kind === 'new-list' ? 41 : 80 })}{err('/code')}<p className="text-xs text-mute">{t(dlg.kind === 'new-list' ? 'lists.code_hint_list' : 'lists.code_hint_value')}</p></>}
        {isList ? (
          <>
            {input('name_en', t('lists.name_en'))}{err('/name_en')}
            {input('name_ar', t('lists.name_ar'), { dir: 'rtl' })}
            {check('critical', t('lists.critical_hint'))}{err('/critical')}
            {check('allow_other', t('lists.allow_other_hint'))}{err('/allow_other')}
            {dlg.kind === 'edit-list' && (
              <>
                <label className="block text-sm font-semibold">{t('lists.status')}
                  <select className="input mt-1 font-normal" data-testid="lists-in-status" value={f.status} onChange={(e) => set('status')(e.target.value)}>
                    <option value="pending">{t('lists.status_pending')}</option><option value="confirmed">{t('lists.status_confirmed')}</option>
                  </select></label>{err('/status')}
                {check('is_active', t('lists.active'))}{err('/is_active')}
              </>
            )}
          </>
        ) : (
          <>
            {input('label_en', t('lists.label_en'))}{err('/label_en')}
            {input('label_ar', t('lists.label_ar'), { dir: 'rtl' })}
            {input('aliases', t('lists.aliases_hint'))}{err('/aliases')}
            {input('groups', t('lists.groups_hint'))}{err('/groups')}
            {dlg.kind === 'edit-value' && <>{input('sort_order', t('lists.sort_order'), { type: 'number', min: 0 })}{check('is_active', t('lists.active'))}{err('/is_active')}</>}
          </>
        )}
      </div>
    </FormDialog>
  );
}
