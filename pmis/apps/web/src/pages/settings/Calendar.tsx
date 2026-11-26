import { AlertTriangle, CalendarCheck, CheckCircle2, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { Fragment, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCalendar, useCalendarConfirmation, useCreateHoliday, useDeleteHoliday, useHolidayChange, useHolidays, useImportHolidays, useSetCalendarConfirmation, useSetWeekend } from '@/api/settings';
import type { Holiday } from '@/api/types';
import { errText, FormDialog } from '@/components/FormDialog';
import { InlineCell } from '@/components/InlineCell';
import { InlinePanel } from '@/components/InlinePanel';
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
    <InlinePanel onClose={onClose} testid="holiday-dialog" title={t(h ? 'cal.edit' : 'cal.add')} busy={m.isPending} error={m.isError && !Object.keys(errs).length ? errText(m.error, t) : null}
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
    </InlinePanel>
  );
}

/**
 * Settings, Work calendar: the official calendar of the year (Q440, contract 0.14.2). A System Admin, or a delegate of settings edit for all regions, confirms it (or
 * withdraws the confirmation) with a reason; everybody sees who confirmed it and when. The banner "not confirmed" shows until it is.
 */
function Confirmation() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useCalendarConfirmation(), set = useSetCalendarConfirmation();
  const [open, setOpen] = useState(false);
  const c = q.data;
  if (!c) return null;
  const when = c.confirmed_at ? new Date(c.confirmed_at).toLocaleString(i18n.language === 'ar' ? 'ar' : 'en-GB', { timeZone: 'Africa/Tripoli', dateStyle: 'medium', timeStyle: 'short' }) : null;
  const next = !c.confirmed;
  return (
    <section className="card space-y-2 p-4" data-testid="cal-confirmation">
      <h2 className="font-bold">{t('cal.official_title')}</h2>
      {c.confirmed ? (
        <p className="flex items-center gap-2 text-sm" data-testid="cal-confirmed-info"><CheckCircle2 size={16} className="text-doneInk" />
          {c.confirmed_by ? t('cal.official_confirmed_by', { name: c.confirmed_by.display_name, id: c.confirmed_by.employee_id ?? '', when }) : t('cal.official_confirmed_db', { when })}</p>
      ) : <p className="text-sm text-mute" data-testid="cal-not-confirmed">{t('cal.official_not_confirmed')}</p>}
      {next && c.blockers.length > 0 && (
        <ul className="list-disc ps-5 text-sm text-waitInk" data-testid="cal-blockers">
          {c.blockers.map((b) => <li key={`${b.code}-${b.year}`} data-testid={`cal-blocker-${b.code}-${b.year}`}>{t(`cal.blocker_${b.code}`, { year: b.year, count: b.count })}</li>)}
        </ul>
      )}
      {c.can_edit && (
        <button className={`btn ${next ? 'btn-accent' : ''}`} data-testid={next ? 'cal-confirm-official' : 'cal-unconfirm-official'} disabled={next && c.blockers.length > 0} onClick={() => setOpen(true)}>
          <CalendarCheck size={14} />{t(next ? 'cal.official_confirm' : 'cal.official_unconfirm')}
        </button>
      )}
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="cal-official-dialog" title={t(next ? 'cal.official_confirm_title' : 'cal.official_unconfirm_title')} busy={set.isPending} error={set.isError ? errText(set.error, t) : null}
          onSubmit={(reason) => set.mutate({ version: c.version, confirmed: next, reason }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); } })}>
          <p className="text-sm text-mute">{t(next ? 'cal.official_confirm_note' : 'cal.official_unconfirm_note')}</p>
        </FormDialog>
      )}
    </section>
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
  const [inlineReason, setInlineReason] = useState('');
  // Edit in place: a cell of a holiday row saves that holiday (audited, with the reason typed above the table); the date, name and kind are sent together like the form does.
  const saveHoliday = async (h: Holiday, p: Partial<{ date: string; name_en: string; name_ar: string; kind: string }>) => {
    if (inlineReason.trim().length < 3) throw new Error(t('cal.inline_need_reason'));
    const m = { date: h.date, name_en: h.name_en, name_ar: h.name_ar ?? '', kind: h.kind, ...p };
    try {
      await change.mutateAsync({ h, patch: { date: m.date, name_en: m.name_en, ...(m.name_ar ? { name_ar: m.name_ar } : {}), kind: m.kind as Holiday['kind'], reason: inlineReason.trim() } });
      toast(t('settings.audited'));
    } catch (e) { throw new Error(errText(e, t)); }
  };
  const [importFile, setImportFile] = useState<File | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const ar = i18n.language === 'ar';
  const sum = list.data?.summary;
  const wk = days ?? cal.data?.weekend_days ?? [5, 6];
  const bad = !wk.length || wk.length > 6;
  // Settings, edit in place: the form of a holiday (add, edit, confirm, delete) opens in the table, at its row (the add form above the table)
  const dlgPanel = (
    <>
      {dlg?.kind === 'edit' && <HolidayDialog h={dlg.h} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'delete' && (
        <InlinePanel onClose={() => setDlg(null)} testid="holiday-delete-dialog" title={t('cal.delete_title', { date: dlg.h.date })} busy={del.isPending} error={del.isError ? errText(del.error, t) : null}
          onSubmit={(reason) => del.mutate({ h: dlg.h, reason }, { onSuccess: () => { toast(t('settings.audited')); setDlg(null); } })}><p className="text-sm text-mute">{t('cal.recalc_note')}</p></InlinePanel>
      )}
      {dlg?.kind === 'confirm' && (
        <InlinePanel onClose={() => setDlg(null)} testid="holiday-confirm-dialog" title={t('cal.confirm_title', { date: dlg.h.date })} busy={change.isPending} error={change.isError ? errText(change.error, t) : null}
          onSubmit={(reason) => change.mutate({ h: dlg.h, patch: { reason, confirm: true, ...(confirmDate ? { date: confirmDate } : {}) } }, { onSuccess: () => { toast(t('settings.audited')); setDlg(null); } })}>
          <label className="block text-sm font-semibold">{t('cal.announced_date')}<input type="date" className="input mt-1 font-normal" data-testid="holiday-confirm-date" value={confirmDate} onChange={(e) => setConfirmDate(e.target.value)} /><span className="text-xs font-normal text-mute">{t('cal.announced_hint')}</span></label>
        </InlinePanel>
      )}
    </>
  );
  return (
    <div data-testid="page-calendar" className="space-y-4">
      {sum?.tentative_reminder_due && <div role="status" className="flex gap-2 rounded-md bg-waitBg p-3 text-sm text-waitInk" data-testid="cal-banner-tentative"><AlertTriangle size={16} />{t('cal.banner_tentative', { date: sum.next_tentative_date })}</div>}
      {sum?.next_year_table_empty && <div role="status" className="flex gap-2 rounded-md bg-lateBg p-3 text-sm text-lateInk" data-testid="cal-banner-empty"><AlertTriangle size={16} />{t('cal.banner_empty', { year: sum.next_year })}</div>}
      {/* 0.12.0 (Q4, D4b): the official calendar is pending owner data; tentative dates count now and mark the due dates */}
      {sum?.official_calendar_pending && <div role="status" className="flex gap-2 rounded-md bg-waitBg p-3 text-sm text-waitInk" data-testid="cal-banner-official"><AlertTriangle size={16} />{t('cal.banner_official')}</div>}
      <Confirmation />
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
          <input ref={file} type="file" accept=".xlsx" className="sr-only" data-testid="cal-import-file" aria-label={t('cal.import')}
            onChange={(e) => { setImportFile(e.target.files?.[0] ?? null); imp.reset(); e.target.value = ''; }} />
          <button className="btn" data-testid="cal-import" onClick={() => file.current?.click()}><Upload size={14} />{t('cal.import')}</button>
          <button className="btn btn-accent" data-testid="cal-add" onClick={() => setDlg({ kind: 'edit', h: null })}><Plus size={14} />{t('cal.add')}</button>
        </div>
        {dlg?.kind === 'edit' && !dlg.h && <div className="mb-3">{dlgPanel}</div>}
        <label className="mb-2 block text-sm">{t('cal.inline_reason')}<input className="input mt-1 w-full font-normal" data-testid="cal-inline-reason" value={inlineReason} onChange={(e) => setInlineReason(e.target.value)} /></label>
        <p className="mb-2 text-xs text-mute">{t('cal.inline_hint')}</p>
        <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead className="text-mute"><tr><th className="p-2 text-start">{t('cal.date')}</th><th className="p-2 text-start">{t('cal.name')}</th><th className="p-2 text-start">{t('cal.kind')}</th><th className="p-2 text-start">{t('users.status')}</th><th className="p-2" /></tr></thead>
          <tbody data-testid="cal-list">
            {(list.data?.items ?? []).map((h) => (
              <Fragment key={h.id}>
              <tr className="border-t border-line" data-testid={`holiday-${h.date}`}>
                <td className="mono p-2"><InlineCell kind="date" value={h.date} label={t('cal.date')} testid={`holiday-cell-date-${h.date}`} onCommit={(v) => saveHoliday(h, { date: v })} /></td>
                <td className="p-2">{ar && h.name_ar
                  ? <InlineCell value={h.name_ar} dir="rtl" label={t('cal.name_ar')} testid={`holiday-cell-name-${h.date}`} onCommit={(v) => saveHoliday(h, { name_ar: v })} />
                  : <InlineCell value={h.name_en} label={t('cal.name_en')} testid={`holiday-cell-name-${h.date}`} onCommit={(v) => v.trim() ? saveHoliday(h, { name_en: v }) : Promise.reject(new Error(t('cal.inline_need_name')))} />}</td>
                <td className="p-2"><InlineCell kind="select" value={h.kind} display={t(`cal.kind_${h.kind}`)} options={['national', 'religious'].map((k) => ({ value: k, label: t(`cal.kind_${k}`) }))} label={t('cal.kind')} testid={`holiday-cell-kind-${h.date}`} onCommit={(v) => saveHoliday(h, { kind: v })} /></td>
                <td className="p-2">{h.tentative ? <span className="chip bg-waitBg text-waitInk" data-testid={`holiday-tentative-${h.date}`}>{t('cal.tentative')}</span> : <span className="chip bg-doneBg text-doneInk">{t('cal.confirmed')}</span>}</td>
                <td className="p-2 text-end"><span className="inline-flex gap-1">
                  {h.tentative && <button className="btn" data-testid={`holiday-confirm-${h.date}`} onClick={() => { setConfirmDate(''); setDlg({ kind: 'confirm', h }); }}><CalendarCheck size={14} />{t('cal.confirm')}</button>}
                  <button className="btn" aria-label={t('common.edit')} data-testid={`holiday-edit-${h.date}`} onClick={() => setDlg({ kind: 'edit', h })}><Pencil size={14} /></button>
                  <button className="btn" aria-label={t('common.remove')} data-testid={`holiday-delete-${h.date}`} onClick={() => setDlg({ kind: 'delete', h })}><Trash2 size={14} /></button></span></td>
              </tr>
              {dlg && dlg.kind !== 'weekend' && dlg.h?.id === h.id && <tr data-testid={`holiday-inline-${h.date}`}><td colSpan={5} className="p-2">{dlgPanel}</td></tr>}
              </Fragment>
            ))}
            {list.isSuccess && !list.data.items.length && <tr><td colSpan={5} className="p-6 text-center text-mute" data-testid="cal-empty">{t('cal.empty')}</td></tr>}
          </tbody>
        </table></div>
      </section>
      {importFile && (
        <FormDialog open onClose={() => setImportFile(null)} testid="holiday-import-dialog" title={t('cal.import')} busy={imp.isPending} error={imp.isError ? errText(imp.error, t) : null}
          onSubmit={(reason) => imp.mutate({ file: importFile, reason }, { onSuccess: () => { toast(`${t('cal.imported')} ${t('settings.audited')}`); setImportFile(null); } })}>
          <p className="mono text-sm" dir="ltr" data-testid="holiday-import-name">{importFile.name}</p>
          <p className="text-xs text-mute">{t('cal.recalc_note')}</p>
        </FormDialog>
      )}
      {dlg?.kind === 'weekend' && (
        <FormDialog open onClose={() => setDlg(null)} testid="weekend-dialog" title={t('cal.weekend')} busy={weekend.isPending} error={weekend.isError ? errText(weekend.error, t) : null}
          onSubmit={(reason) => weekend.mutate({ weekend_days: wk, reason }, { onSuccess: (r) => { toast(`${t('settings.audited')} ${t('cal.recalculated', { count: r.affected_open_tasks })}`); setDays(null); setDlg(null); } })}><p className="text-sm text-mute">{t('cal.recalc_note')}</p></FormDialog>
      )}
    </div>
  );
}
