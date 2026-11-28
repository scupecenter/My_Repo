import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useExportParts } from '@/api/admin';
import { useDeleteExportSchedule, useExportSchedules, useExportUnattended, useSaveExportSchedule, useSetExportUnattended, type ExportScheduleInput } from '@/api/exportSchedules';
import { errText } from '@/components/FormDialog';
import { QueryFallback } from '@/components/States';
import { useToast } from '@/components/Toast';

const EMPTY: ExportScheduleInput = { name: '', cadence: 'weekly', weekday: 1, day_of_month: 1, spec: {}, enabled: true, mail: false, unattended: false };

/**
 * Settings > Data > Scheduled export (contract 0.15.99, 0.15.584). The caller's own recurring exports. A due schedule starts when the owner next opens Exports,
 * in the owner's own session. A schedule marked "unattended" also starts by itself every hour while a System Admin has switched unattended runs on (default off):
 * it runs as the owner with the owner's rights checked live. A schedule marked "mail" mails its owner when the export is done or failed (no file in the mail).
 */
export function ExportSchedulesScreen() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useExportSchedules();
  const parts = useExportParts(true);
  const save = useSaveExportSchedule();
  const del = useDeleteExportSchedule();
  const sw = useExportUnattended();
  const setSw = useSetExportUnattended();
  const [f, setF] = useState<ExportScheduleInput | null>(null);
  const [reason, setReason] = useState('');
  const ar = i18n.language.startsWith('ar');
  if (!q.data) return <section className="card p-4" data-testid="page-export-schedules"><QueryFallback queries={[q]} testid="es-loading" /></section>;
  const wd = (n: number) => t(`exportSchedules.weekday_${n}`);
  const when = (s: { cadence: string; weekday?: number; day_of_month?: number }) =>
    s.cadence === 'daily' ? t('exportSchedules.daily') : s.cadence === 'weekly' ? t('exportSchedules.weekly_on', { day: wd(s.weekday ?? 0) }) : t('exportSchedules.monthly_on', { day: s.day_of_month ?? 1 });
  const partName = (k: string) => { const p = parts.data?.find((x) => x.key === k); return p ? (ar && p.label_ar ? p.label_ar : p.label_en) : k; };
  const submit = () => {
    if (!f) return;
    const body: ExportScheduleInput = { ...(f.id ? { id: f.id } : {}), name: f.name.trim(), cadence: f.cadence, spec: f.spec, enabled: f.enabled, mail: f.mail === true, unattended: f.unattended === true,
      ...(f.cadence === 'weekly' ? { weekday: f.weekday } : {}), ...(f.cadence === 'monthly' ? { day_of_month: f.day_of_month } : {}) };
    save.mutate(body, { onSuccess: () => { toast(t('exportSchedules.saved')); setF(null); } });
  };
  const chosen = new Set(f?.spec?.parts ?? []);
  return (
    <section className="card space-y-3 p-4" data-testid="page-export-schedules">
      <h2 className="font-bold">{t('exportSchedules.title')}</h2>
      <p className="rounded bg-waitBg p-2 text-sm text-waitInk" data-testid="es-note">{t('exportSchedules.note')}</p>
      <div className="space-y-1 rounded border border-line p-3 text-sm" data-testid="es-switch">
        <div className="font-semibold">{t('exportSchedules.switch_title')}: <span data-testid="es-switch-state">{sw.data?.enabled ? t('exportSchedules.switch_on') : t('exportSchedules.switch_off')}</span></div>
        <p className="text-mute">{t('exportSchedules.switch_note')}</p>
        {sw.data?.can_edit && (
          <div className="flex flex-wrap items-center gap-2">
            <input className="input" maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('exportSchedules.switch_reason')} aria-label={t('exportSchedules.switch_reason')} data-testid="es-switch-reason" />
            <button type="button" className="btn" disabled={reason.trim().length < 3 || setSw.isPending} title={sw.data.enabled ? t('exportSchedules.switch_turn_off') : t('exportSchedules.switch_turn_on')}
              onClick={() => setSw.mutate({ version: sw.data.version, enabled: !sw.data.enabled, reason: reason.trim() }, { onSuccess: () => { setReason(''); toast(t('exportSchedules.switch_saved')); } })} data-testid="es-switch-toggle">
              {sw.data.enabled ? t('exportSchedules.switch_turn_off') : t('exportSchedules.switch_turn_on')}
            </button>
            {setSw.error && <span className="text-bad" data-testid="es-switch-error">{errText(setSw.error, t)}</span>}
          </div>
        )}
      </div>
      {q.data.length === 0 ? <p className="text-sm text-mute" data-testid="es-none">{t('exportSchedules.none')}</p> : (
        <table className="w-full text-sm" data-testid="es-table">
          <thead><tr className="text-mute"><th className="text-start">{t('exportSchedules.name')}</th><th className="text-start">{t('exportSchedules.when')}</th><th className="text-start">{t('exportSchedules.content')}</th><th className="text-start">{t('exportSchedules.next')}</th><th className="text-start">{t('exportSchedules.last')}</th><th /></tr></thead>
          <tbody>
            {q.data.map((s) => (
              <tr key={s.id} data-testid={`es-row-${s.id}`}>
                <td>{s.name}{!s.enabled && <span className="ms-1 text-mute">({t('exportSchedules.paused')})</span>}</td>
                <td>{when(s)}</td>
                <td>{s.spec.view ? t('exportSchedules.one_view') : s.spec.parts?.length ? s.spec.parts.map(partName).join(', ') : t('exportSchedules.whole')}{s.unattended && <span className="ms-1 text-mute" data-testid={`es-unattended-${s.id}`}>({t('exportSchedules.unattended_tag')})</span>}{s.mail && <span className="ms-1 text-mute">({t('exportSchedules.mail_tag')})</span>}</td>
                <td>{s.due ? <span className="text-warn" data-testid={`es-due-${s.id}`}>{t('exportSchedules.due')}</span> : new Date(s.next_due_at).toLocaleDateString()}</td>
                <td>{s.last_error ? <span className="text-bad" data-testid={`es-error-${s.id}`}>{s.last_error}</span> : s.last_started_at ? new Date(s.last_started_at).toLocaleDateString() : '-'}</td>
                <td className="text-end">
                  <button type="button" className="btn" onClick={() => setF({ ...EMPTY, ...s, spec: s.spec ?? {} })} data-testid={`es-edit-${s.id}`}>{t('common.edit')}</button>{' '}
                  <button type="button" className="btn" onClick={() => del.mutate(s.id, { onSuccess: () => toast(t('exportSchedules.deleted')) })} data-testid={`es-delete-${s.id}`}>{t('common.remove')}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!f && <button type="button" className="btn" onClick={() => setF({ ...EMPTY })} data-testid="es-new">{t('exportSchedules.add')}</button>}
      {f && (
        <div className="space-y-2 rounded border border-line p-3 text-sm" data-testid="es-form">
          <label className="flex items-center gap-2">{t('exportSchedules.name')}<input className="input" maxLength={80} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} data-testid="es-name" /></label>
          <label className="flex items-center gap-2">{t('exportSchedules.when')}
            <select className="input" value={f.cadence} onChange={(e) => setF({ ...f, cadence: e.target.value as ExportScheduleInput['cadence'] })} data-testid="es-cadence">
              <option value="daily">{t('exportSchedules.cad_daily')}</option><option value="weekly">{t('exportSchedules.cad_weekly')}</option><option value="monthly">{t('exportSchedules.cad_monthly')}</option>
            </select>
            {f.cadence === 'weekly' && <select className="input" value={f.weekday} onChange={(e) => setF({ ...f, weekday: Number(e.target.value) })} data-testid="es-weekday">{[0, 1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{wd(n)}</option>)}</select>}
            {f.cadence === 'monthly' && <input className="input w-20" type="number" min={1} max={28} value={f.day_of_month} onChange={(e) => setF({ ...f, day_of_month: Number(e.target.value) })} data-testid="es-dom" />}
          </label>
          <fieldset>
            <legend className="text-mute">{t('exportSchedules.content')} ({t('exportSchedules.parts_hint')})</legend>
            <div className="flex flex-wrap gap-3">
              {(parts.data ?? []).map((p) => (
                <label key={p.key} className="flex items-center gap-1"><input type="checkbox" checked={chosen.has(p.key)} data-testid={`es-part-${p.key}`}
                  onChange={(e) => { const next = new Set(chosen); if (e.target.checked) next.add(p.key); else next.delete(p.key); setF({ ...f, spec: { ...f.spec, parts: [...next] } }); }} />{ar && p.label_ar ? p.label_ar : p.label_en}</label>
              ))}
            </div>
          </fieldset>
          <label className="flex items-center gap-2"><input type="checkbox" checked={f.enabled !== false} onChange={(e) => setF({ ...f, enabled: e.target.checked })} data-testid="es-enabled" />{t('exportSchedules.enabled')}</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={f.mail === true} onChange={(e) => setF({ ...f, mail: e.target.checked })} data-testid="es-mail" />{t('exportSchedules.mail')}</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={f.unattended === true} onChange={(e) => setF({ ...f, unattended: e.target.checked })} data-testid="es-unattended" />{t('exportSchedules.unattended')}</label>
          {f.unattended && !sw.data?.enabled && <p className="text-warn" data-testid="es-unattended-off">{t('exportSchedules.unattended_off')}</p>}
          {save.error && <p className="text-bad" data-testid="es-save-error">{errText(save.error, t)}</p>}
          <div className="flex gap-2">
            <button type="button" className="btn btn-primary" disabled={f.name.trim().length < 1 || save.isPending} onClick={submit} data-testid="es-save">{t('common.save')}</button>
            <button type="button" className="btn" onClick={() => setF(null)}>{t('common.cancel')}</button>
          </div>
        </div>
      )}
    </section>
  );
}
