import { Lock } from 'lucide-react';
import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCatalogue, usePolicy, useSetPolicy } from '@/api/settings';
import type { NotificationPolicy, NotificationPolicyRow, NotificationThresholds } from '@/api/types';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { fieldErrors } from '@/lib/fields';
import { isLocked, LIMITS, thresholdErrors } from '@/lib/policy';
import { FieldErr } from './Calendar';

type Draft = { enabled: boolean; timezone: string; digest_hour: number | ''; follow: boolean; work_days: number[]; thresholds: Record<keyof NotificationThresholds, number | ''>; matrix: NotificationPolicyRow[] };
const fromPolicy = (p: NotificationPolicy): Draft => ({ enabled: p.enabled, timezone: p.timezone, digest_hour: p.digest_hour, follow: p.work_days_follow_calendar, work_days: p.work_days, thresholds: { ...p.thresholds }, matrix: p.matrix.map((r) => ({ ...r, channels: { ...r.channels }, cells: r.cells.map((c) => ({ ...c })) })) });

export function Notifications() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const pol = usePolicy(), cat = useCatalogue(), save = useSetPolicy();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [open, setOpen] = useState(false);
  const p = pol.data;
  if (!p || !cat.data) return <p>{t('common.loading')}</p>;
  const d = draft ?? fromPolicy(p);
  const ar = i18n.language === 'ar';
  const set = (patch: Partial<Draft>) => setDraft({ ...d, ...patch });
  const local: Record<string, string> = { ...thresholdErrors(d.thresholds), ...(d.digest_hour === '' || d.digest_hour < 0 || d.digest_hour > 23 ? { '/digest_hour': 'out_of_range' } : {}) };
  const server = fieldErrors(save.error);
  const errs = { ...server, ...local };
  const groups = [...new Set(cat.data.map((c) => c.category))];
  const rowOf = (code: string) => d.matrix.find((r) => r.type_code === code);
  const patchRow = (code: string, fn: (r: NotificationPolicyRow) => NotificationPolicyRow) => set({ matrix: d.matrix.map((r) => (r.type_code === code ? fn(r) : r)) });
  const setCell = (code: string, c: { kind: 'role' | 'group'; id: string }, on: boolean) =>
    patchRow(code, (r) => ({ ...r, cells: r.cells.some((x) => x.id === c.id) ? r.cells.map((x) => (x.id === c.id ? { ...x, on } : x)) : [...r.cells, { kind: c.kind, id: c.id, on }] }));
  const body = (reason: string) => ({
    reason, enabled: d.enabled, timezone: d.timezone.trim(), digest_hour: Number(d.digest_hour), work_days_follow_calendar: d.follow, ...(d.follow ? {} : { work_days: d.work_days }),
    thresholds: Object.fromEntries(Object.entries(d.thresholds).map(([k, v]) => [k, Number(v)])) as unknown as NotificationThresholds,
    matrix: d.matrix.map(({ type_code, channels, cells }) => ({ type_code, channels, cells })),
  });
  const matrixErrs = Object.entries(server).filter(([k]) => k.startsWith('/matrix'));
  return (
    <div className="space-y-4" data-testid="page-notifications">
      <section className="card space-y-3 p-4">
        <label className="flex items-center gap-2 font-semibold"><input type="checkbox" data-testid="np-enabled" checked={d.enabled} onChange={(e) => set({ enabled: e.target.checked })} />{t('np.enabled')}</label>
        <p className="text-xs text-mute">{t('np.enabled_note')}</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-sm font-semibold">{t('np.timezone')}<input className="input mt-1 font-normal" dir="ltr" data-testid="np-timezone" value={d.timezone} onChange={(e) => set({ timezone: e.target.value })} /><FieldErr errs={errs} path="/timezone" /></label>
          <label className="text-sm font-semibold">{t('np.digest_hour')}<input type="number" min={0} max={23} className="input mt-1 font-normal" data-testid="np-digest" value={d.digest_hour} onChange={(e) => set({ digest_hour: e.target.value === '' ? '' : Number(e.target.value) })} /><span className="text-xs font-normal text-mute">{t('rules.range', { min: 0, max: 23 })}</span><FieldErr errs={errs} path="/digest_hour" /></label>
        </div>
        <fieldset><legend className="text-sm font-semibold">{t('np.work_days')}</legend>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="np-follow" checked={d.follow} onChange={(e) => set({ follow: e.target.checked })} />{t('np.follow_calendar')}</label>
          <div className="mt-1 flex flex-wrap gap-3 text-sm">{[0, 1, 2, 3, 4, 5, 6].map((x) => <label key={x} className="flex items-center gap-1"><input type="checkbox" data-testid={`np-day-${x}`} disabled={d.follow} checked={(d.follow ? p.work_days : d.work_days).includes(x)} onChange={(e) => set({ work_days: e.target.checked ? [...d.work_days, x] : d.work_days.filter((y) => y !== x) })} />{t(`weekday.${x}`)}</label>)}</div>
          <FieldErr errs={errs} path="/work_days" />
        </fieldset>
      </section>
      <section className="card p-4" data-testid="np-thresholds">
        <h2 className="mb-2 font-bold">{t('np.thresholds')}</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {(Object.keys(LIMITS) as (keyof NotificationThresholds)[]).map((k) => (
            <label key={k} className="text-sm font-semibold">{t(`np.th_${k}`)}
              <input type="number" className="input mt-1 font-normal" aria-invalid={!!errs[`/thresholds/${k}`]} data-testid={`np-th-${k}`} value={d.thresholds[k]} onChange={(e) => set({ thresholds: { ...d.thresholds, [k]: e.target.value === '' ? '' : Number(e.target.value) } })} />
              <span className="text-xs font-normal text-mute" data-testid={`np-range-${k}`}>{t('rules.range', { min: LIMITS[k][0], max: LIMITS[k][1] })}</span>
              <FieldErr errs={errs} path={`/thresholds/${k}`} />
            </label>))}
        </div>
      </section>
      <section className="card overflow-x-auto p-4">
        <h2 className="mb-2 font-bold">{t('np.matrix')}</h2>
        {matrixErrs.length > 0 && <ul role="alert" className="mb-2 text-xs text-lateInk" data-testid="np-matrix-errors">{matrixErrs.map(([k, c]) => <li key={k}>{k}: {t(`fieldError.${c}`, { defaultValue: c })}</li>)}</ul>}
        <table className="w-full text-sm">
          <thead className="text-mute"><tr><th className="p-2 text-start">{t('np.type')}</th><th className="p-2">{t('np.ch_in_app')}</th><th className="p-2">{t('np.ch_email')}</th>{p.columns.map((c) => <th key={c.id} className="p-2 text-start">{c.name}</th>)}</tr></thead>
          <tbody>
            {groups.map((g) => (
              <Fragment key={g}>
                <tr className="bg-card2"><td colSpan={3 + p.columns.length} className="p-2 text-xs font-bold text-mute">{t(`np.cat_${g}`)}</td></tr>
                {cat.data.filter((c) => c.category === g).map((c) => {
                  const r = rowOf(c.code); if (!r) return null;
                  const lock = isLocked(c);
                  return (
                    <tr key={c.code} className="border-t border-line" data-testid={`np-row-${c.code}`} data-locked={lock}>
                      <td className="p-2">{lock && <Lock size={12} className="me-1 inline" aria-label={t('np.locked')} data-testid={`np-lock-${c.code}`} />}{ar ? c.label_ar : c.label_en}{c.system_admins_only && <span className="ms-2 text-xs text-mute">{t('np.admins_only')}</span>}</td>
                      {(['in_app', 'email'] as const).map((ch) => (
                        <td key={ch} className="p-2 text-center"><input type="checkbox" aria-label={`${c.label_en} ${ch}`} data-testid={`np-ch-${c.code}-${ch}`} disabled={lock && c.default_channels[ch]} checked={r.channels[ch]} onChange={(e) => patchRow(c.code, (x) => ({ ...x, channels: { ...x.channels, [ch]: e.target.checked } }))} /></td>))}
                      {p.columns.map((col) => (
                        <td key={col.id} className="p-2">
                          {c.system_admins_only && col.kind !== 'group' ? <span className="text-mute">—</span>
                            : <input type="checkbox" aria-label={`${c.label_en} ${col.name}`} data-testid={`np-cell-${c.code}-${col.id}`} disabled={lock} checked={r.cells.find((x) => x.id === col.id)?.on ?? false} onChange={(e) => setCell(c.code, col, e.target.checked)} />}
                        </td>))}
                    </tr>);
                })}
              </Fragment>))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-mute">{t('np.sensitive_note')}</p>
      </section>
      <div className="flex gap-2">
        <button className="btn btn-accent" data-testid="np-save" disabled={Object.keys(local).length > 0} onClick={() => setOpen(true)}>{t('common.save')}</button>
        {draft && <button className="btn" onClick={() => setDraft(null)}>{t('common.cancel')}</button>}
      </div>
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="np-dialog" title={t('np.title')} busy={save.isPending} error={save.isError ? errText(save.error, t) : null}
          onSubmit={(reason) => save.mutate({ version: p.version, body: body(reason) }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setDraft(null); }, onError: (e) => { if (e.status === 422) setOpen(false); } })} />
      )}
    </div>
  );
}
