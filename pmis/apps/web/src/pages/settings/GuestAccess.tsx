import { UserRoundCheck } from 'lucide-react';
import { UnsavedGuard } from '@/lib/unsavedGuard';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRegions } from '@/api/sites';
import { useCreateGuest, useEndGuest, useExtendGuest, useGuestAccess, useGuests, useSetGuestAccess } from '@/api/settings';
import { errText, FormDialog } from '@/components/FormDialog';
import { QueryFallback } from '@/components/States';
import { useToast } from '@/components/Toast';
import { fmtDateTime } from '@/lib/time';

type Pending = { kind: 'set' } | { kind: 'create' } | { kind: 'extend'; id: string } | { kind: 'end'; id: string };

/**
 * Settings, Security, Guest access (migration 0731, contract 0.15.730). A System Admin makes a view-only account for a person outside the staff: chosen regions and
 * modules, an end date, no employee rights. Off by default. The account is an ordinary local user; the database and the session guard keep it read-only. Every action
 * asks for a reason and a step-up and is audited. The temporary password is shown once. Only a System Admin sees the data (the API answers 403 to anyone else).
 */
export function GuestAccess() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const ar = i18n.language === 'ar';
  const q = useGuestAccess();
  const guests = useGuests(q.isSuccess);
  const regions = useRegions();
  const set = useSetGuestAccess(), create = useCreateGuest(), extend = useExtendGuest(), end = useEndGuest();
  const [draft, setDraft] = useState<{ enabled: boolean; max: number; def: number } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [regs, setRegs] = useState<number[]>([]);
  const [mods, setMods] = useState<string[]>([]);
  const [days, setDays] = useState<number | null>(null);
  const [extDays, setExtDays] = useState(7);
  const [shown, setShown] = useState<{ email: string; password: string } | null>(null);
  if (q.isError && (q.error as { status?: number }).status === 403) return <section className="card p-4" data-testid="guest-readonly"><p className="text-sm text-mute">{t('guestaccess.readonly')}</p></section>;
  if (!q.data) return <QueryFallback queries={[q]} testid="guest-loading" />;
  const cur = q.data;
  const v = draft ?? { enabled: cur.enabled, max: cur.max_days, def: cur.default_days };
  const dirty = v.enabled !== cur.enabled || v.max !== cur.max_days || v.def !== cur.default_days;
  const validCfg = v.max >= 1 && v.max <= 365 && v.def >= 1 && v.def <= v.max;
  const d = days ?? cur.default_days;
  const canCreate = cur.enabled && /^\S+@\S+\.\S+$/.test(email.trim()) && name.trim().length > 0 && regs.length > 0 && mods.length > 0 && d >= 1 && d <= cur.max_days;
  const close = () => setPending(null);
  const err = (m: { isError: boolean; error: unknown }) => (m.isError ? errText(m.error as never, t) : null);
  const reset = () => { setEmail(''); setName(''); setNote(''); setRegs([]); setMods([]); setDays(null); };
  const toggle = <T,>(list: T[], x: T, on: boolean): T[] => (on ? [...list, x] : list.filter((y) => y !== x));

  return (
    <section className="card space-y-5 p-4" data-testid="page-guest-access">
      <div>
        <h2 className="flex items-center gap-2 font-bold"><UserRoundCheck size={16} aria-hidden />{t('guestaccess.title')}</h2>
        <p className="text-sm text-mute">{t('guestaccess.note')}</p>
      </div>

      <div className="space-y-2">
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" data-testid="guest-enabled" checked={v.enabled} onChange={(e) => setDraft({ ...v, enabled: e.target.checked })} />
          <span><span className="font-semibold">{t('guestaccess.enable')}</span><span className="block text-xs text-mute">{t('guestaccess.enable_note')}</span></span>
        </label>
        <div className="flex flex-wrap gap-3 text-sm">
          <label>{t('guestaccess.max_days')}<input type="number" min={1} max={365} className="input ms-2 w-24" data-testid="guest-max" value={v.max} onChange={(e) => setDraft({ ...v, max: Number(e.target.value) })} /></label>
          <label>{t('guestaccess.default_days')}<input type="number" min={1} max={365} className="input ms-2 w-24" data-testid="guest-default" value={v.def} onChange={(e) => setDraft({ ...v, def: Number(e.target.value) })} /></label>
        </div>
        <button className="btn btn-accent" data-testid="guest-save" disabled={!dirty || !validCfg} onClick={() => setPending({ kind: 'set' })}>{t('guestaccess.save')}</button>
      </div>

      <div className="space-y-2 border-t border-line pt-4">
        <h3 className="font-semibold">{t('guestaccess.create')}</h3>
        {!cur.enabled && <p className="text-sm text-mute" data-testid="guest-off">{t('guestaccess.off')}</p>}
        <p className="text-xs text-mute">{t('guestaccess.view_only')}</p>
        <div className="flex flex-wrap gap-3 text-sm">
          <label>{t('guestaccess.email')}<input type="email" className="input ms-2 w-64" data-testid="guest-email" disabled={!cur.enabled} value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label>{t('guestaccess.name')}<input className="input ms-2 w-56" data-testid="guest-name" disabled={!cur.enabled} value={name} onChange={(e) => setName(e.target.value)} /></label>
        </div>
        <fieldset className="text-sm">
          <legend>{t('guestaccess.regions')}</legend>
          {(regions.data ?? []).map((r) => (
            <label key={r.id} className="me-3 inline-flex items-center gap-1"><input type="checkbox" data-testid={`guest-region-${r.id}`} disabled={!cur.enabled} checked={regs.includes(r.id)}
              onChange={(e) => setRegs(toggle(regs, r.id, e.target.checked))} />{ar && r.name_ar ? r.name_ar : r.name_en}</label>
          ))}
        </fieldset>
        <fieldset className="text-sm">
          <legend>{t('guestaccess.modules')}</legend>
          {cur.modules.map((m) => (
            <label key={m} className="me-3 inline-flex items-center gap-1"><input type="checkbox" data-testid={`guest-module-${m}`} disabled={!cur.enabled} checked={mods.includes(m)}
              onChange={(e) => setMods(toggle(mods, m, e.target.checked))} />{m}</label>
          ))}
        </fieldset>
        <div className="flex flex-wrap gap-3 text-sm">
          <label>{t('guestaccess.days')}<input type="number" min={1} max={cur.max_days} className="input ms-2 w-24" data-testid="guest-days" disabled={!cur.enabled} value={d} onChange={(e) => setDays(Number(e.target.value))} /></label>
          <label>{t('guestaccess.note_field')}<input className="input ms-2 w-64" data-testid="guest-note" disabled={!cur.enabled} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></label>
        </div>
        <button className="btn btn-accent" data-testid="guest-create" disabled={!canCreate} onClick={() => setPending({ kind: 'create' })}>{t('guestaccess.create_btn')}</button>
      </div>

      {shown && (
        <div className="rounded border border-line p-3 text-sm" role="status" data-testid="guest-password-box">
          <p className="font-semibold">{t('guestaccess.password_title', { email: shown.email })}</p>
          <p className="text-mute">{t('guestaccess.password_note')}</p>
          <code className="mt-1 inline-block select-all" dir="ltr" data-testid="guest-password">{shown.password}</code>
          <div><button className="btn mt-2" data-testid="guest-password-done" onClick={() => setShown(null)}>{t('guestaccess.password_done')}</button></div>
        </div>
      )}

      <div className="space-y-2 border-t border-line pt-4">
        <h3 className="font-semibold">{t('guestaccess.guests')}</h3>
        {guests.data && guests.data.length === 0 && <p className="text-sm text-mute" data-testid="guest-none">{t('guestaccess.none')}</p>}
        <ul className="space-y-1 text-sm" data-testid="guest-list">
          {(guests.data ?? []).map((g) => (
            <li key={g.user_id} className="flex flex-wrap items-center gap-2" data-testid={`guest-row-${g.user_id}`}>
              <span className="font-semibold">{g.display_name}</span>
              <span className="text-mute" dir="ltr">{g.email}</span>
              <span className={`chip ${g.state === 'active' ? '' : 'bg-state-locked-bg text-state-locked-fg'}`} data-testid={`guest-state-${g.user_id}`}>{t(`guestaccess.state_${g.state}`)}</span>
              <span className="text-mute">{t('guestaccess.until', { when: fmtDateTime(g.expires_at, ar ? 'ar' : 'en') })}</span>
              {g.state === 'active' && <>
                <button className="btn" data-testid={`guest-extend-${g.user_id}`} onClick={() => setPending({ kind: 'extend', id: g.user_id })}>{t('guestaccess.extend')}</button>
                <button className="btn" data-testid={`guest-end-${g.user_id}`} onClick={() => setPending({ kind: 'end', id: g.user_id })}>{t('guestaccess.end')}</button>
              </>}
            </li>
          ))}
        </ul>
      </div>

      <UnsavedGuard scope="settings" dirty={dirty} needsReason label={t('ui.guard_settings')} onSave={(reason) => new Promise<boolean>((res) => set.mutate({ version: cur.version, enabled: v.enabled, max_days: v.max, default_days: v.def, reason }, { onSuccess: () => res(true), onError: () => res(false) }))} />
      {pending?.kind === 'set' && (
        <FormDialog open onClose={close} testid="guest-dialog" title={t('guestaccess.title')} busy={set.isPending} error={err(set)}
          onSubmit={(reason) => set.mutate({ version: cur.version, enabled: v.enabled, max_days: v.max, default_days: v.def, reason }, { onSuccess: () => { toast(t('settings.audited')); close(); setDraft(null); } })}>
          <p className="text-sm text-mute">{t('guestaccess.confirm_set', { enabled: t(v.enabled ? 'guestaccess.on' : 'guestaccess.off_word'), max: v.max, def: v.def })}</p>
        </FormDialog>
      )}
      {pending?.kind === 'create' && (
        <FormDialog open onClose={close} testid="guest-dialog" title={t('guestaccess.create')} busy={create.isPending} error={err(create)}
          onSubmit={(reason) => create.mutate({ email: email.trim(), display_name: name.trim(), regions: regs, modules: mods, days: d, ...(note.trim() ? { note: note.trim() } : {}), reason },
            { onSuccess: (r) => { toast(t('settings.audited')); setShown({ email: r.guest.email, password: r.temporary_password }); close(); reset(); } })}>
          <p className="text-sm text-mute">{t('guestaccess.confirm_create', { who: name.trim(), days: d })}</p>
        </FormDialog>
      )}
      {pending?.kind === 'extend' && (
        <FormDialog open onClose={close} testid="guest-dialog" title={t('guestaccess.extend')} busy={extend.isPending} error={err(extend)}
          onSubmit={(reason) => extend.mutate({ user_id: pending.id, expires_at: new Date(Date.now() + extDays * 86_400_000).toISOString(), reason }, { onSuccess: () => { toast(t('settings.audited')); close(); } })}>
          <label className="text-sm">{t('guestaccess.extend_days')}<input type="number" min={1} max={cur.max_days} className="input ms-2 w-24" data-testid="guest-extend-days" value={extDays} onChange={(e) => setExtDays(Number(e.target.value))} /></label>
          <p className="text-sm text-mute">{t('guestaccess.confirm_extend', { max: cur.max_days })}</p>
        </FormDialog>
      )}
      {pending?.kind === 'end' && (
        <FormDialog open onClose={close} testid="guest-dialog" title={t('guestaccess.end')} busy={end.isPending} error={err(end)}
          onSubmit={(reason) => end.mutate({ user_id: pending.id, reason }, { onSuccess: () => { toast(t('settings.audited')); close(); } })}>
          <p className="text-sm text-mute">{t('guestaccess.confirm_end')}</p>
        </FormDialog>
      )}
    </section>
  );
}
