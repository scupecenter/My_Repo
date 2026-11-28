import { BellOff } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type NotificationPrefs, useMyNotificationDecisions, useMyNotificationPrefs, useSaveNotificationPrefs, useSnoozeNotifications, useTestNotification,
} from '@/api/notificationPersonal';
import { errText } from '@/components/FormDialog';
import { ErrorState, LoadingSkeleton } from '@/components/States';
import { useToast } from '@/components/Toast';
import { Tip } from '@/components/Tip';
import { fmtDateTime } from '@/lib/time';
import { UnsavedGuard } from '@/lib/unsavedGuard';

const hhmm = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const minutes = (v: string): number => { const [h, m] = v.split(':').map(Number); return (h ?? 0) * 60 + (m ?? 0); };
const dayName = (d: number, lang: string): string => new Intl.DateTimeFormat(lang, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 7 + d)));

type Draft = { types: Record<string, { in_app: boolean; email: boolean }>; dnd: { enabled: boolean; start: string; end: string; days: number[]; timezone: string } };
const fromPrefs = (p: NotificationPrefs): Draft => ({
  types: Object.fromEntries(p.types.map((x) => [x.code, { in_app: x.in_app, email: x.email }])),
  dnd: { enabled: p.dnd.enabled, start: hhmm(p.dnd.start), end: hhmm(p.dnd.end), days: p.dnd.days, timezone: p.dnd.timezone ?? '' },
});

/**
 * Profile > Notifications (item 4 and item 7 of the 2026-11-27 batch, contract 0.15.531): which notification types reach my bell and my e-mail, a scheduled
 * do-not-disturb, a snooze, a test button and the notices my own settings held back. A mandatory type is always on. Quiet time holds e-mail and device alerts,
 * never the bell. The administrator's switches (Settings > Alerts > Policy) can turn the personal layer off.
 */
export function NotificationPrefsSection() {
  const { t } = useTranslation();
  const q = useMyNotificationPrefs();
  if (q.isLoading) return <LoadingSkeleton />;
  if (q.isError || !q.data) return <ErrorState onRetry={() => void q.refetch()} />;
  return <Body key={q.data.version} p={q.data} title={t('npp.title')} />;
}

function Body({ p, title }: { p: NotificationPrefs; title: string }) {
  const { t, i18n } = useTranslation();
  const ar = i18n.language.startsWith('ar');
  const toast = useToast();
  const save = useSaveNotificationPrefs();
  const snooze = useSnoozeNotifications();
  const test = useTestNotification();
  const decisions = useMyNotificationDecisions();
  const saved = useMemo(() => fromPrefs(p), [p]);
  const [draft, setDraft] = useState<Draft>(saved);
  const off = !p.org.allow_personal;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const groups = [...new Set(p.types.map((x) => x.category))];
  const body = () => ({
    types: Object.fromEntries(p.types.filter((x) => !x.mandatory).map((x) => [x.code, draft.types[x.code] ?? { in_app: true, email: true }])),
    dnd: { enabled: draft.dnd.enabled, start: minutes(draft.dnd.start), end: minutes(draft.dnd.end), days: draft.dnd.days, timezone: draft.dnd.timezone === '' ? null : draft.dnd.timezone },
  });
  const doSave = (done?: (ok: boolean) => void) => save.mutate({ version: p.version, body: body() }, { onSuccess: () => { toast(t('profile.saved')); done?.(true); }, onError: () => done?.(false) });
  const setCh = (code: string, ch: 'in_app' | 'email', v: boolean) => setDraft({ ...draft, types: { ...draft.types, [code]: { ...(draft.types[code] ?? { in_app: true, email: true }), [ch]: v } } });
  const setDnd = (patch: Partial<Draft['dnd']>) => setDraft({ ...draft, dnd: { ...draft.dnd, ...patch } });
  const hold = (hours: number | 'tomorrow') => {
    const d = new Date();
    if (hours === 'tomorrow') { d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); } else d.setTime(d.getTime() + hours * 3_600_000);
    snooze.mutate({ until: d.toISOString() }, { onSuccess: () => toast(t('npp.snoozed')) });
  };
  return (
    <section className="card space-y-4 p-4 lg:col-span-2" id="notifications" data-testid="profile-notifications">
      <UnsavedGuard scope="inline" dirty={dirty && !off} label={title} onSave={() => new Promise<boolean>((res) => { if (!dirty || off) { res(false); return; } doSave(res); })} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-bold"><BellOff size={18} aria-hidden />{title}</h2>
        <span className="text-xs text-mute" data-testid="npp-quiet-state">{p.quiet_now ? t('npp.quiet_now') : t('npp.not_quiet')}</span>
      </div>
      <p className="text-sm text-mute">{t('npp.note')}</p>
      {off && <p className="rounded-md bg-card2 p-2 text-sm" data-testid="npp-locked">{t('npp.locked')}</p>}

      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="npp-types">
          <thead className="text-mute"><tr><th className="p-2 text-start">{t('np.type')}</th><th className="p-2">{t('np.ch_in_app')}</th><th className="p-2">{t('np.ch_email')}</th></tr></thead>
          <tbody>
            {groups.map((g) => (
              <PrefGroup key={g} title={t(`np.cat_${g}`)}>
                {p.types.filter((x) => x.category === g).map((x) => (
                  <tr key={x.code} className="border-t border-line" data-testid={`npp-row-${x.code}`}>
                    <td className="p-2">{ar ? x.label_ar : x.label_en}{x.mandatory && <span className="ms-2 text-xs text-mute">{t('np.locked')}</span>}</td>
                    {(['in_app', 'email'] as const).map((ch) => (
                      <td key={ch} className="p-2 text-center">
                        <input type="checkbox" aria-label={`${ar ? x.label_ar : x.label_en} ${t(`np.ch_${ch}`)}`} data-testid={`npp-ch-${x.code}-${ch}`} disabled={off || x.mandatory}
                          checked={x.mandatory ? true : (draft.types[x.code]?.[ch] ?? true)} onChange={(e) => setCh(x.code, ch, e.target.checked)} />
                      </td>))}
                  </tr>))}
              </PrefGroup>))}
          </tbody>
        </table>
      </div>

      <fieldset className="space-y-2 rounded-md border border-line p-3" disabled={off || !p.org.allow_dnd} data-testid="npp-dnd">
        <legend className="px-1 text-sm font-semibold">{t('npp.dnd')}</legend>
        <p className="text-xs text-mute">{p.org.allow_dnd ? t('npp.dnd_note') : t('npp.dnd_locked')}</p>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="npp-dnd-enabled" checked={draft.dnd.enabled} onChange={(e) => setDnd({ enabled: e.target.checked })} />{t('npp.dnd_on')}</label>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">{t('npp.from')}<input type="time" className="input mt-1 block" data-testid="npp-dnd-start" value={draft.dnd.start} onChange={(e) => setDnd({ start: e.target.value })} /></label>
          <label className="text-sm">{t('npp.to')}<input type="time" className="input mt-1 block" data-testid="npp-dnd-end" value={draft.dnd.end} onChange={(e) => setDnd({ end: e.target.value })} /></label>
          <label className="text-sm">{t('npp.tz')}<input className="input mt-1 block" data-testid="npp-dnd-tz" placeholder={p.dnd.effective_timezone} value={draft.dnd.timezone} onChange={(e) => setDnd({ timezone: e.target.value })} /></label>
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('npp.days')}>
          {[0, 1, 2, 3, 4, 5, 6].map((d) => (
            <label key={d} className="flex items-center gap-1 text-sm"><input type="checkbox" data-testid={`npp-day-${d}`} checked={draft.dnd.days.includes(d)}
              onChange={(e) => setDnd({ days: e.target.checked ? [...draft.dnd.days, d].sort() : draft.dnd.days.filter((x) => x !== d) })} />{dayName(d, i18n.language)}</label>))}
        </div>
        <p className="text-xs text-mute">{t('npp.crosses')}</p>
      </fieldset>

      <div className="space-y-2" data-testid="npp-snooze">
        <h3 className="text-sm font-semibold">{t('npp.snooze')}</h3>
        <p className="text-xs text-mute" data-testid="npp-snooze-state">{p.snooze_until && new Date(p.snooze_until) > new Date() ? t('npp.snoozed_until', { when: fmtDateTime(p.snooze_until, i18n.language) }) : t('npp.snooze_none')}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn" data-testid="npp-snooze-1" disabled={off || snooze.isPending} onClick={() => hold(1)}>{t('npp.snooze_1h')}</button>
          <button type="button" className="btn" data-testid="npp-snooze-4" disabled={off || snooze.isPending} onClick={() => hold(4)}>{t('npp.snooze_4h')}</button>
          <button type="button" className="btn" data-testid="npp-snooze-tomorrow" disabled={off || snooze.isPending} onClick={() => hold('tomorrow')}>{t('npp.snooze_tomorrow')}</button>
          <button type="button" className="btn" data-testid="npp-snooze-clear" disabled={off || snooze.isPending || !p.snooze_until} onClick={() => snooze.mutate({ until: null }, { onSuccess: () => toast(t('profile.saved')) })}>{t('npp.snooze_clear')}</button>
        </div>
      </div>

      {(save.isError || snooze.isError || test.isError) && <p role="alert" className="text-sm text-danger" data-testid="npp-error">{errText((save.error ?? snooze.error ?? test.error)!, t)}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn" data-testid="npp-revert" disabled={!dirty || save.isPending} onClick={() => setDraft(saved)}>{t('appearance.revert')}</button>
        <button type="button" className="btn btn-accent" data-testid="npp-save" disabled={!dirty || off || save.isPending} onClick={() => doSave()}>{t('appearance.apply')}</button>
        <Tip text={t('npp.test_tip')}>
          <button type="button" className="btn" data-testid="npp-test" disabled={test.isPending} onClick={() => test.mutate(undefined, { onSuccess: (r) => toast(r.quiet_now ? t('npp.test_sent_quiet') : t('npp.test_sent')) })}>{t('npp.test')}</button>
        </Tip>
      </div>

      <div data-testid="npp-decisions">
        <h3 className="text-sm font-semibold">{t('npp.held')}</h3>
        <p className="text-xs text-mute">{t('npp.held_note', { minutes: p.org.dedupe_minutes })}</p>
        {!decisions.data || decisions.data.length === 0 ? <p className="mt-1 text-sm text-mute" data-testid="npp-held-none">{t('npp.held_none')}</p> : (
          <ul className="mt-1 space-y-1 text-sm">
            {decisions.data.map((d) => (
              <li key={d.id} className="flex flex-wrap gap-x-2" data-testid={`npp-held-${d.id}`}>
                <span className="text-xs text-mute">{fmtDateTime(d.created_at, i18n.language)}</span><span>{d.title ?? d.kind}</span><span className="text-xs text-mute">{t(`npp.reason_${d.reason}`)}</span>
              </li>))}
          </ul>)}
      </div>
    </section>
  );
}

function PrefGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (<><tr className="bg-card2"><td colSpan={3} className="p-2 text-xs font-bold text-mute">{title}</td></tr>{children}</>);
}
