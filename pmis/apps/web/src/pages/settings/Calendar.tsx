import { AlertTriangle, CalendarCheck, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCalendar, useCreateHoliday, useDeleteHoliday, useHolidayChange, useHolidays, useImportHolidays, useSetWeekend } from '@/api/settings';
import type { Holiday } from '@/api/types';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { fieldErrors } from '@/lib/fields';

export const FieldErr = ({ errs, path }: { errs: Record<string, string>; path: string }) => {
  const { t } = useTranslation();
  const c = errs[path];
  return c ? <p role="alert" className="mt-1 text-xs text-lateInk" data-testid={`err${path.replace(/\//g, '-')}`}>{t(`fieldError.${c}`, { defaultValue: c })}</p> : null;
};

function HolidayDialog({ h, onClose }: { h: Holiday | null; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const create = useCreateHoliday(), change = useHolidayChange();
  const [f, setF] = useState({ date: h?.date ?? '', name_en: h?.name_en ?? '', name_ar: h?.name_ar ?? '', kind: h?.kind ?? 'national', tentative: h?.tentative ?? false });
  const m = h ? change : create;
  const errs = fieldErrors(m.error);
  const done = { onSuccess: () => { toast(t('settings.audited')); onClose(); } };
  return (
    <FormDialog open onClose={onClose} testid="holiday-dialog" title={t(h ? 'cal.edit' : 'cal.add')} busy={m.isPending} error={m.isError && !Object.keys(errs).length ? errText(m.error, t) : null}
      onSubmit={(reason) => {
        const body = { date: f.date, name_en: f.name_en, ...(f.name_ar ? { name_ar: f.name_ar } : {}), kind: f.kind, reason };
        if (h) change.mutate({ h, patch: body }, done); else create.mutate({ ...body, tentative: f.tentative }, done);
      }}>
      <label className="block text-sm font-semibold">{t('cal.date')}<input type="date" className="input mt-1 font-normal" data-testid="holiday-date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
      <FieldErr errs={errs} path="/date" />
      <label className="block text-sm font-semibold">{t('cal.name_en')}<input className="input mt-1 font-normal" data-testid="holiday-name-en" value={f.name_en} onChange={(e) => setF({ ...f, name_en: e.target.value })} /></label>
      <FieldErr errs={errs} path="/name_en" />
      <label className="block text-sm font-semibold">{t('cal.name_ar')}<input className="input mt-1 font-normal" dir="rtl" data-testid="holiday-name-ar" value={f.name_ar} onChange={(e) => setF({ ...f, name_ar: e.target.value })} /></label>
      <label className="block text-sm font-semibold">{t('cal.kind')}
        <select className="input mt-1 font-normal" data-testid="holiday-kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as Holiday['kind'] })}>
          <option value="national">{t('cal.kind_national')}</option><option value="religious">{t('cal.kind_religious')}</option></select></label>
      {!h && <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="holiday-tentative" checked={f.tentative} onChange={(e) => setF({ ...f, tentative: e.target.checked })} />{t('cal.tentative')}</label>}
      <p className="text-xs text-mute">{t('cal.recalc_note')}</p>
    </FormDialog>
  );
}

export function Calendar() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [year, setYear] = useState(2026);
  const list = useHolidays(year), cal = useCalendar();
  const del = useDeleteHoliday(), change = useHolidayChange(), imp = useImportHolidays(), weekend = useSetWeekend();
  const [dlg, setDlg] = useState<null | { kind: 'edit'; h: Holiday | null } | { kind: 'delete' | 'confirm'; h: Holiday } | { kind: 'weekend' }>(null);
  const [days, setDays] = useState<number[] | null>(null);
  const [confirmDate, setConfirmDate] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const ar = i18n.language === 'ar';
  const sum = list.data?.summary;
  const wk = days ?? cal.data?.weekend_days ?? [5, 6];
  const bad = !wk.length || wk.length > 6;
  return (
    <div data-testid="page-calendar" className="space-y-4">
      {sum?.tentative_reminder_due && <div role="status" className="flex gap-2 rounded-md bg-waitBg p-3 text-sm text-waitInk" data-testid="cal-banner-tentative"><AlertTriangle size={16} />{t('cal.banner_tentative', { date: sum.next_tentative_date })}</div>}
      {sum?.next_year_table_empty && <div role="status" className="flex gap-2 rounded-md bg-lateBg p-3 text-sm text-lateInk" data-testid="cal-banner-empty"><AlertTriangle size={16} />{t('cal.banner_empty', { year: sum.next_year })}</div>}
      <section className="card p-4" data-testid="cal-weekend">
        <h2 className="mb-2 font-bold">{t('cal.weekend')}</h2>
        <div className="flex flex-wrap gap-3 text-sm">
          {[0, 1, 2, 3, 4, 5, 6].map((d) => <label key={d} className="flex items-center gap-1"><input type="checkbox" data-testid={`weekend-${d}`} checked={wk.includes(d)} onChange={(e) => setDays(e.target.checked ? [...wk, d] : wk.filter((x) => x !== d))} />{t(`weekday.${d}`)}</label>)}
          <button className="btn btn-accent" data-testid="weekend-save" disabled={bad || !days} onClick={() => setDlg({ kind: 'weekend' })}>{t('common.save')}</button>
        </div>
        {bad && <p role="alert" className="mt-1 text-xs text-lateInk">{t('cal.weekend_invalid')}</p>}
      </section>
      <section className="card p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="me-auto font-bold">{t('cal.holidays')}</h2>
          <select className="input w-auto" aria-label={t('cal.year')} data-testid="cal-year" value={year} onChange={(e) => setYear(Number(e.target.value))}>{[2026, 2027, 2028].map((y) => <option key={y}>{y}</option>)}</select>
          <input ref={file} type="file" accept=".csv,.xlsx" className="sr-only" data-testid="cal-import-file" aria-label={t('cal.import')}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) imp.mutate(f, { onSuccess: () => toast(t('cal.imported')), onError: (er) => toast(errText(er, t), 'err') }); e.target.value = ''; }} />
          <button className="btn" data-testid="cal-import" onClick={() => file.current?.click()}><Upload size={14} />{t('cal.import')}</button>
          <button className="btn btn-accent" data-testid="cal-add" onClick={() => setDlg({ kind: 'edit', h: null })}><Plus size={14} />{t('cal.add')}</button>
        </div>
        <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead className="text-mute"><tr><th className="p-2 text-start">{t('cal.date')}</th><th className="p-2 text-start">{t('cal.name')}</th><th className="p-2 text-start">{t('cal.kind')}</th><th className="p-2 text-start">{t('users.status')}</th><th className="p-2" /></tr></thead>
          <tbody data-testid="cal-list">
            {(list.data?.items ?? []).map((h) => (
              <tr key={h.id} className="border-t border-line" data-testid={`holiday-${h.date}`}>
                <td className="mono p-2">{h.date}</td><td className="p-2">{(ar && h.name_ar) || h.name_en}</td><td className="p-2">{t(`cal.kind_${h.kind}`)}</td>
                <td className="p-2">{h.tentative ? <span className="chip bg-waitBg text-waitInk" data-testid={`holiday-tentative-${h.date}`}>{t('cal.tentative')}</span> : <span className="chip bg-doneBg text-doneInk">{t('cal.confirmed')}</span>}</td>
                <td className="p-2 text-end"><span className="inline-flex gap-1">
                  {h.tentative && <button className="btn" data-testid={`holiday-confirm-${h.date}`} onClick={() => { setConfirmDate(''); setDlg({ kind: 'confirm', h }); }}><CalendarCheck size={14} />{t('cal.confirm')}</button>}
                  <button className="btn" aria-label={t('common.edit')} data-testid={`holiday-edit-${h.date}`} onClick={() => setDlg({ kind: 'edit', h })}><Pencil size={14} /></button>
                  <button className="btn" aria-label={t('common.remove')} data-testid={`holiday-delete-${h.date}`} onClick={() => setDlg({ kind: 'delete', h })}><Trash2 size={14} /></button></span></td>
              </tr>
            ))}
            {list.isSuccess && !list.data.items.length && <tr><td colSpan={5} className="p-6 text-center text-mute" data-testid="cal-empty">{t('cal.empty')}</td></tr>}
          </tbody>
        </table></div>
      </section>
      {dlg?.kind === 'edit' && <HolidayDialog h={dlg.h} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'delete' && (
        <FormDialog open onClose={() => setDlg(null)} testid="holiday-delete-dialog" title={t('cal.delete_title', { date: dlg.h.date })} busy={del.isPending} error={del.isError ? errText(del.error, t) : null}
          onSubmit={(reason) => del.mutate({ h: dlg.h, reason }, { onSuccess: () => { toast(t('settings.audited')); setDlg(null); } })}><p className="text-sm text-mute">{t('cal.recalc_note')}</p></FormDialog>
      )}
      {dlg?.kind === 'confirm' && (
        <FormDialog open onClose={() => setDlg(null)} testid="holiday-confirm-dialog" title={t('cal.confirm_title', { date: dlg.h.date })} busy={change.isPending} error={change.isError ? errText(change.error, t) : null}
          onSubmit={(reason) => change.mutate({ h: dlg.h, patch: { reason, confirm: true, ...(confirmDate ? { date: confirmDate } : {}) } }, { onSuccess: () => { toast(t('settings.audited')); setDlg(null); } })}>
          <label className="block text-sm font-semibold">{t('cal.announced_date')}<input type="date" className="input mt-1 font-normal" data-testid="holiday-confirm-date" value={confirmDate} onChange={(e) => setConfirmDate(e.target.value)} /><span className="text-xs font-normal text-mute">{t('cal.announced_hint')}</span></label>
        </FormDialog>
      )}
      {dlg?.kind === 'weekend' && (
        <FormDialog open onClose={() => setDlg(null)} testid="weekend-dialog" title={t('cal.weekend')} busy={weekend.isPending} error={weekend.isError ? errText(weekend.error, t) : null}
          onSubmit={(reason) => weekend.mutate({ weekend_days: wk, reason }, { onSuccess: (r) => { toast(`${t('settings.audited')} ${t('cal.recalculated', { count: r.affected_open_tasks })}`); setDays(null); setDlg(null); } })}><p className="text-sm text-mute">{t('cal.recalc_note')}</p></FormDialog>
      )}
    </div>
  );
}
