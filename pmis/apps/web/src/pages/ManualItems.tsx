import { ArrowLeft, History, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useAddManualValue, useManualItems, type ManualItem } from '@/api/dashboard';
import { errText } from '@/components/FormDialog';
import { ErrorState, LoadingSkeleton } from '@/components/States';
import { useToast } from '@/components/Toast';
import { tripoliToday } from '@/lib/today';

/** The form of one new value (Q118): a percentage, an effective date (today or earlier) and a reason. */
function AddValue({ item, onDone }: { item: ManualItem; onDone: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const add = useAddManualValue();
  const today = tripoliToday();
  const [value, setValue] = useState('');
  const [date, setDate] = useState(today);
  const [reason, setReason] = useState('');
  const n = Number(value);
  const ok = value !== '' && Number.isFinite(n) && n >= 0 && n <= 100 && !!date && date <= today && reason.trim().length >= 3;
  const save = () => add.mutate({ code: item.item_code, value_pct: n, effective_date: date, reason: reason.trim() }, {
    onSuccess: () => { toast(t('manual.saved')); onDone(); },
  });
  return (
    <form className="mt-2 grid gap-2 rounded-md border border-line bg-card2 p-3 sm:grid-cols-[8rem_10rem_1fr_auto]" data-testid={`manual-form-${item.item_code}`}
      onSubmit={(e) => { e.preventDefault(); if (ok) save(); }}>
      <label className="text-sm">{t('manual.value')}
        <input type="number" min={0} max={100} step="0.001" inputMode="decimal" className="input mono" data-testid="manual-value" value={value} onChange={(e) => setValue(e.target.value)} required />
      </label>
      <label className="text-sm">{t('manual.effective_date')}
        <input type="date" className="input mono" max={today} data-testid="manual-date" value={date} onChange={(e) => setDate(e.target.value)} required />
      </label>
      <label className="text-sm">{t('manual.reason')}
        <input className="input" data-testid="manual-reason" value={reason} minLength={3} maxLength={1000} onChange={(e) => setReason(e.target.value)} required />
      </label>
      <div className="flex items-end gap-2">
        <button type="submit" className="btn btn-primary" data-testid="manual-save" disabled={!ok || add.isPending}>{t('manual.save')}</button>
        <button type="button" className="btn" onClick={onDone}>{t('manual.cancel')}</button>
      </div>
      {add.isError && <p role="alert" className="text-sm text-lateInk sm:col-span-4" data-testid="manual-error">{errText(add.error, t)}</p>}
    </form>
  );
}

/** Manual percentage of the central Project Status items (owner answer Q118): the value in force, the history, and a form for the Project Manager. */
export function ManualItems() {
  const { t, i18n } = useTranslation();
  const ar = i18n.language === 'ar';
  const q = useManualItems();
  const [open, setOpen] = useState<string | null>(null);
  const [hist, setHist] = useState<string | null>(null);
  const nm = (x: { name_en: string; name_ar?: string | null }) => (ar && x.name_ar ? x.name_ar : x.name_en);

  return (
    <div className="space-y-4" data-testid="page-manual-items">
      <header>
        <Link to="/dashboard" className="text-sm text-link hover:underline" data-testid="manual-back"><ArrowLeft size={14} className="inline rtl:rotate-180" /> {t('manual.back')}</Link>
        <h1 className="mt-1 text-2xl font-bold">{t('manual.title')}</h1>
        <p className="text-mute">{t('manual.subtitle')}</p>
      </header>
      {q.isLoading && <LoadingSkeleton rows={6} testid="manual-loading" />}
      {q.isError && <ErrorState onRetry={() => void q.refetch()} message={errText(q.error, t)} testid="manual-error-state" />}
      {q.data && (
        <>
          <div className="flex flex-wrap gap-2 text-sm">
            {q.data.without_value > 0 && <span className="chip bg-waitBg text-waitInk" data-testid="manual-without">{t('manual.without_value', { n: q.data.without_value })}</span>}
            {!q.data.can_edit && <span className="chip bg-lockBg text-lockInk" data-testid="manual-readonly">{t('manual.readonly')}</span>}
          </div>
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm" data-testid="manual-table">
              <thead>
                <tr className="text-mute">
                  <th className="p-2 text-start">{t('manual.item')}</th><th className="p-2 text-start">{t('manual.activity')}</th>
                  <th className="p-2 text-end">{t('manual.weight')}</th><th className="p-2 text-start">{t('manual.current')}</th><th className="p-2" />
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((i) => (
                  <tr key={i.item_code} className="border-t border-line align-top" data-testid={`manual-row-${i.item_code}`}>
                    <td className="p-2"><span className="mono">{i.item_code}</span> {nm(i)}</td>
                    <td className="p-2">{ar && i.activity_name_ar ? i.activity_name_ar : i.activity_name_en}</td>
                    <td className="p-2 text-end tnum">{i.weight > 0 ? `${Number(i.weight.toFixed(2))}%` : <span className="text-mute">{t('manual.not_weighted')}</span>}</td>
                    <td className="p-2" data-testid={`manual-current-${i.item_code}`}>
                      {i.current ? <><b className="tnum">{Number(i.current.value_pct.toFixed(3))}%</b> <span className="text-mute">{t('manual.effective', { date: i.current.effective_date })} · {t('manual.version', { n: i.current.version })}</span></> : <span className="text-mute">{t('manual.none')}</span>}
                      {open === i.item_code && <AddValue item={i} onDone={() => setOpen(null)} />}
                      {hist === i.item_code && (
                        <ol className="mt-2 space-y-1 border-s-2 border-line ps-3" data-testid={`manual-history-${i.item_code}`}>
                          {i.history.map((h) => (
                            <li key={h.id}>
                              <span className="mono">{t('manual.version', { n: h.version })}</span> · <b className="tnum">{h.value_pct}%</b> · {t('manual.effective', { date: h.effective_date })}
                              {h.in_force && <span className="chip ms-1 bg-doneBg text-doneInk">{t('manual.in_force')}</span>}
                              <div className="text-mute">{h.reason} · {t('manual.by', { name: h.entered_by.display_name })}</div>
                            </li>
                          ))}
                        </ol>
                      )}
                    </td>
                    <td className="whitespace-nowrap p-2 text-end">
                      {i.history.length > 0 && (
                        <button className="btn px-2" data-testid={`manual-history-btn-${i.item_code}`} aria-expanded={hist === i.item_code} onClick={() => setHist(hist === i.item_code ? null : i.item_code)}>
                          <History size={14} />{t('manual.history')}
                        </button>
                      )}
                      {q.data.can_edit && i.weight > 0 && (
                        <button className="btn ms-1 px-2" data-testid={`manual-add-${i.item_code}`} onClick={() => setOpen(open === i.item_code ? null : i.item_code)}><Plus size={14} />{t('manual.add')}</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
