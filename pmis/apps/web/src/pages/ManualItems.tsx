import { ArrowLeft, History, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useAddManualValue, useManualItems, useSetManualPlan, type ManualItem, type ManualPlanPoint } from '@/api/dashboard';
import { errText } from '@/components/FormDialog';
import { ErrorState, LoadingSkeleton } from '@/components/States';
import { useToast } from '@/components/Toast';
import { tripoliToday } from '@/lib/today';

/**
 * The form of one new value (Q118): a percentage, an effective date (today or earlier), a reason and its source (Q176). A date before the current
 * month is a historical correction (Q178): only offered to a holder of the historical-correction right.
 */
function AddValue({ item, onDone, openFrom, canCorrect }: { item: ManualItem; onDone: () => void; openFrom?: string; canCorrect?: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const add = useAddManualValue();
  const today = tripoliToday();
  const [value, setValue] = useState('');
  const [date, setDate] = useState(today);
  const [reason, setReason] = useState('');
  const [source, setSource] = useState('');
  const n = Number(value);
  const minDate = canCorrect ? undefined : openFrom;
  const ok = value !== '' && Number.isFinite(n) && n >= 0 && n <= 100 && !!date && date <= today && (!minDate || date >= minDate) && reason.trim().length >= 3 && source.trim().length >= 2;
  const save = () => add.mutate({ code: item.item_code, value_pct: n, effective_date: date, reason: reason.trim(), source: source.trim() }, {
    onSuccess: () => { toast(t('manual.saved')); onDone(); },
  });
  return (
    <form className="mt-2 grid gap-2 rounded-md border border-line bg-card2 p-3 sm:grid-cols-[8rem_10rem_1fr_1fr_auto]" data-testid={`manual-form-${item.item_code}`}
      onSubmit={(e) => { e.preventDefault(); if (ok) save(); }}>
      <label className="text-sm">{t('manual.value')}
        <input type="number" min={0} max={100} step="0.001" inputMode="decimal" className="input mono" data-testid="manual-value" value={value} onChange={(e) => setValue(e.target.value)} required />
      </label>
      <label className="text-sm">{t('manual.effective_date')}
        <input type="date" className="input mono" max={today} min={minDate} data-testid="manual-date" value={date} onChange={(e) => setDate(e.target.value)} required />
      </label>
      <label className="text-sm">{t('manual.reason')}
        <input className="input" data-testid="manual-reason" value={reason} minLength={3} maxLength={1000} onChange={(e) => setReason(e.target.value)} required />
      </label>
      <label className="text-sm">{t('manual.source')}
        <input className="input" data-testid="manual-source" value={source} minLength={2} maxLength={500} placeholder={t('manual.source_hint')} onChange={(e) => setSource(e.target.value)} required />
      </label>
      <div className="flex items-end gap-2">
        <button type="submit" className="btn btn-primary" data-testid="manual-save" disabled={!ok || add.isPending}>{t('manual.save')}</button>
        <button type="button" className="btn" onClick={onDone}>{t('manual.cancel')}</button>
      </div>
      {openFrom && <p className="text-xs text-mute sm:col-span-5" data-testid="manual-closed-month">{t('manual.closed_month', { date: openFrom })}</p>}
      {add.isError && <p role="alert" className="text-sm text-lateInk sm:col-span-5" data-testid="manual-error">{errText(add.error, t)}</p>}
    </form>
  );
}

/** The plan of an item (Q177): a target date (with an optional start date, a ramp from 0%) or a list of points; a reason and a source. */
function SetPlan({ item, onDone }: { item: ManualItem; onDone: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const save = useSetManualPlan();
  const [mode, setMode] = useState<'target' | 'points'>('target');
  const [start, setStart] = useState('');
  const [target, setTarget] = useState('');
  const [points, setPoints] = useState<{ date: string; pct: string }[]>([{ date: '', pct: '' }]);
  const [reason, setReason] = useState('');
  const [source, setSource] = useState('');
  const pts: ManualPlanPoint[] = points.filter((x) => x.date && x.pct !== '').map((x) => ({ date: x.date, planned_pct: Number(x.pct) }));
  const sorted = [...pts].sort((a, b) => a.date.localeCompare(b.date));
  const cumulative = sorted.every((x, i) => i === 0 || x.planned_pct >= sorted[i - 1]!.planned_pct) && new Set(pts.map((x) => x.date)).size === pts.length;
  const pointsOk = pts.length > 0 && pts.length === points.length && pts.every((x) => x.planned_pct >= 0 && x.planned_pct <= 100) && cumulative;
  const ok = reason.trim().length >= 3 && source.trim().length >= 2 && (mode === 'target' ? !!target && (!start || start < target) : pointsOk);
  const submit = () => save.mutate(
    mode === 'target' ? { code: item.item_code, target_date: target, ...(start ? { start_date: start } : {}), reason: reason.trim(), source: source.trim() }
      : { code: item.item_code, points: pts, reason: reason.trim(), source: source.trim() },
    { onSuccess: () => { toast(t('manual.plan_saved')); onDone(); } });
  return (
    <form className="mt-2 grid gap-2 rounded-md border border-line bg-card2 p-3" data-testid={`plan-form-${item.item_code}`} onSubmit={(e) => { e.preventDefault(); if (ok) submit(); }}>
      <div role="radiogroup" aria-label={t('manual.plan')} className="flex gap-2 text-sm">
        {(['target', 'points'] as const).map((m) => (
          <label key={m} className="flex items-center gap-1"><input type="radio" name={`plan-mode-${item.item_code}`} data-testid={`plan-mode-${m}`} checked={mode === m} onChange={() => setMode(m)} />{t(m === 'target' ? 'manual.plan_mode_target' : 'manual.plan_mode_points')}</label>
        ))}
      </div>
      {mode === 'target' ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-sm">{t('manual.start_date')}<input type="date" className="input mono" data-testid="plan-start" value={start} max={target || undefined} onChange={(e) => setStart(e.target.value)} /></label>
          <label className="text-sm">{t('manual.target_date')}<input type="date" className="input mono" data-testid="plan-target" value={target} min={start || undefined} onChange={(e) => setTarget(e.target.value)} required /></label>
        </div>
      ) : (
        <ol className="space-y-1" data-testid="plan-points">
          {points.map((x, i) => (
            <li key={i} className="flex flex-wrap items-end gap-2">
              <label className="text-sm">{t('manual.point_date')}<input type="date" className="input mono" data-testid={`plan-point-date-${i}`} value={x.date} onChange={(e) => setPoints((ps) => ps.map((y, j) => (j === i ? { ...y, date: e.target.value } : y)))} /></label>
              <label className="text-sm">{t('manual.point_pct')}<input type="number" min={0} max={100} step="0.001" className="input mono w-28" data-testid={`plan-point-pct-${i}`} value={x.pct} onChange={(e) => setPoints((ps) => ps.map((y, j) => (j === i ? { ...y, pct: e.target.value } : y)))} /></label>
              {points.length > 1 && <button type="button" className="btn px-2" aria-label={t('manual.remove_point')} onClick={() => setPoints((ps) => ps.filter((_, j) => j !== i))}>×</button>}
            </li>
          ))}
          <li><button type="button" className="btn px-2 text-xs" data-testid="plan-add-point" disabled={points.length >= 120} onClick={() => setPoints((ps) => [...ps, { date: '', pct: '' }])}><Plus size={14} />{t('manual.add_point')}</button></li>
        </ol>
      )}
      <p className="text-xs text-mute">{t('manual.plan_hint')}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-sm">{t('manual.reason')}<input className="input" data-testid="plan-reason" value={reason} minLength={3} maxLength={1000} onChange={(e) => setReason(e.target.value)} required /></label>
        <label className="text-sm">{t('manual.source')}<input className="input" data-testid="plan-source" value={source} minLength={2} maxLength={500} onChange={(e) => setSource(e.target.value)} required /></label>
      </div>
      <div className="flex gap-2">
        <button type="submit" className="btn btn-primary" data-testid="plan-save" disabled={!ok || save.isPending}>{t('manual.plan_save')}</button>
        <button type="button" className="btn" onClick={onDone}>{t('manual.cancel')}</button>
      </div>
      {save.isError && <p role="alert" className="text-sm text-lateInk" data-testid="plan-error">{errText(save.error, t)}</p>}
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
  const [planOpen, setPlanOpen] = useState<string | null>(null);
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
            {(q.data.without_plan ?? 0) > 0 && <span className="chip bg-lockBg text-lockInk" data-testid="manual-without-plan">{t('manual.without_plan', { n: q.data.without_plan })}</span>}
            {!q.data.can_edit && <span className="chip bg-lockBg text-lockInk" data-testid="manual-readonly">{t('manual.readonly')}</span>}
          </div>
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm" data-testid="manual-table">
              <thead>
                <tr className="text-mute">
                  <th className="p-2 text-start">{t('manual.item')}</th><th className="p-2 text-start">{t('manual.activity')}</th>
                  <th className="p-2 text-end">{t('manual.weight')}</th><th className="p-2 text-start">{t('manual.current')}</th><th className="p-2 text-start">{t('manual.plan')}</th><th className="p-2" />
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
                      {open === i.item_code && <AddValue item={i} onDone={() => setOpen(null)} openFrom={q.data.open_period_from} canCorrect={q.data.can_correct_history} />}
                      {hist === i.item_code && (
                        <ol className="mt-2 space-y-1 border-s-2 border-line ps-3" data-testid={`manual-history-${i.item_code}`}>
                          {i.history.map((h) => (
                            <li key={h.id}>
                              <span className="mono">{t('manual.version', { n: h.version })}</span> · <b className="tnum">{h.value_pct}%</b> · {t('manual.effective', { date: h.effective_date })}
                              {h.in_force && <span className="chip ms-1 bg-doneBg text-doneInk">{t('manual.in_force')}</span>}
                              {h.historical_correction && <span className="chip ms-1 bg-waitBg text-waitInk" data-testid={`manual-correction-${h.id}`}>{t('manual.correction')}</span>}
                              <div className="text-mute">{h.reason}{h.source && <> · {t('manual.source')}: {h.source}</>} · {t('manual.by', { name: h.entered_by.display_name })}</div>
                            </li>
                          ))}
                        </ol>
                      )}
                    </td>
                    <td className="p-2" data-testid={`manual-plan-${i.item_code}`}>
                      {i.plan ? <><span className="mono">{t('manual.version', { n: i.plan.version })}</span> · {t('manual.plan_today', { pct: Number(i.plan.planned_pct_today.toFixed(1)) })}
                        <div className="text-xs text-mute">{i.plan.points.map((x) => `${x.date} ${x.planned_pct}%`).join(' → ')}</div></>
                        : <span className="text-mute">{t('manual.plan_none')}</span>}
                      {planOpen === i.item_code && <SetPlan item={i} onDone={() => setPlanOpen(null)} />}
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
                      {q.data.can_edit && i.weight > 0 && (
                        <button className="btn ms-1 px-2" data-testid={`plan-add-${i.item_code}`} onClick={() => setPlanOpen(planOpen === i.item_code ? null : i.item_code)}><Plus size={14} />{t('manual.plan_add')}</button>
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
