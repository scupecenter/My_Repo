import { MailCheck } from 'lucide-react';
import { UnsavedGuard } from '@/lib/unsavedGuard';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePicker } from '@/api/admin';
import { useBypassNewDevice, useNewDeviceCode, useSetNewDeviceCode } from '@/api/settings';
import { errText, FormDialog } from '@/components/FormDialog';
import { QueryFallback } from '@/components/States';
import { useToast } from '@/components/Toast';
import { fmtDateTime } from '@/lib/time';

type Pending = { kind: 'set' } | { kind: 'bypass' };

/**
 * Settings, Security, New-device code (migration 0292, contract 0.15.192). Off by default. When on, a password-only sign-in from a browser the account has not used
 * needs a 6-digit code mailed to it. Not for two-factor accounts, not for System Admins (unless included), and the sign-in goes through if the mail cannot be queued, so
 * nobody is locked out. The recovery path: let one account in once, or turn it off. Only a System Admin sees the data (403 for others), so others get a short notice.
 */
export function NewDeviceCode() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const ar = i18n.language === 'ar';
  const q = useNewDeviceCode();
  const set = useSetNewDeviceCode(), bypass = useBypassNewDevice();
  const [draft, setDraft] = useState<{ enabled: boolean; minutes: number; admins: boolean } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [search, setSearch] = useState('');
  const [who, setWho] = useState<{ id: string; name: string } | null>(null);
  const [minutes, setMinutes] = useState(30);
  const [until, setUntil] = useState<string | null>(null);
  const picker = usePicker(who ? '' : search);
  if (q.isError && (q.error as { status?: number }).status === 403) return <section className="card p-4" data-testid="newdevice-readonly"><p className="text-sm text-mute">{t('newdevice.readonly')}</p></section>;
  if (!q.data) return <QueryFallback queries={[q]} testid="newdevice-loading" />;
  const cur = q.data;
  const v = draft ?? { enabled: cur.enabled, minutes: cur.code_minutes, admins: cur.include_admins };
  const dirty = v.enabled !== cur.enabled || v.minutes !== cur.code_minutes || v.admins !== cur.include_admins;
  const validCfg = v.minutes >= 5 && v.minutes <= 30 && (!v.enabled || cur.mail_ready || cur.enabled);
  const close = () => setPending(null);
  const err = (m: { isError: boolean; error: unknown }) => (m.isError ? errText(m.error as never, t) : null);

  return (
    <section className="card space-y-5 p-4" data-testid="page-new-device">
      <div>
        <h2 className="flex items-center gap-2 font-bold"><MailCheck size={16} aria-hidden />{t('newdevice.title')}</h2>
        <p className="text-sm text-mute">{t('newdevice.note')}</p>
      </div>

      <div className="space-y-2">
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" data-testid="newdevice-enabled" checked={v.enabled} onChange={(e) => setDraft({ ...v, enabled: e.target.checked })} />
          <span><span className="font-semibold">{t('newdevice.enable')}</span><span className="block text-xs text-mute">{t('newdevice.enable_note')}</span></span>
        </label>
        {!cur.mail_ready && <p className="text-sm text-lateInk" data-testid="newdevice-no-mail">{t('newdevice.no_mail')}</p>}
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label>{t('newdevice.minutes')}<input type="number" min={5} max={30} className="input ms-2 w-24" data-testid="newdevice-minutes" value={v.minutes} onChange={(e) => setDraft({ ...v, minutes: Number(e.target.value) })} /></label>
          <label className="flex items-center gap-2"><input type="checkbox" data-testid="newdevice-admins" checked={v.admins} onChange={(e) => setDraft({ ...v, admins: e.target.checked })} />{t('newdevice.include_admins')}</label>
        </div>
        <p className="text-xs text-mute">{t('newdevice.admins_note')}</p>
        <button className="btn btn-accent" data-testid="newdevice-save" disabled={!dirty || !validCfg} onClick={() => setPending({ kind: 'set' })}>{t('newdevice.save')}</button>
        {cur.updated_at && <p className="text-xs text-mute" data-testid="newdevice-updated">{t('newdevice.updated', { name: cur.updated_by?.display_name ?? '', when: fmtDateTime(cur.updated_at, ar ? 'ar' : 'en') })}</p>}
      </div>

      <div className="space-y-2 border-t border-line pt-4">
        <h3 className="font-semibold">{t('newdevice.bypass')}</h3>
        <p className="text-sm text-mute">{t('newdevice.bypass_note')}</p>
        <div className="space-y-2 text-sm">
          <label className="block">{t('newdevice.who')}</label>
          {who
            ? <span className="chip" data-testid="newdevice-who">{who.name} <button type="button" className="ms-1" aria-label={t('common.cancel')} onClick={() => { setWho(null); setSearch(''); }}>×</button></span>
            : <>
                <input className="input w-64" data-testid="newdevice-search" placeholder={t('newdevice.who_ph')} value={search} onChange={(e) => setSearch(e.target.value)} />
                <ul className="mt-1 max-w-sm">{(picker.data ?? []).map((u) => <li key={u.id}><button type="button" className="btn" data-testid={`newdevice-pick-${u.id}`} onClick={() => setWho({ id: u.id, name: u.display_name })}>{u.display_name}</button></li>)}</ul>
              </>}
          <label className="block">{t('newdevice.bypass_minutes')}<input type="number" min={1} max={60} className="input ms-2 w-24" data-testid="newdevice-bypass-minutes" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} /></label>
        </div>
        <button className="btn" data-testid="newdevice-bypass" disabled={!who || minutes < 1 || minutes > 60} onClick={() => setPending({ kind: 'bypass' })}>{t('newdevice.bypass_btn')}</button>
        {until && <p className="text-sm" role="status" data-testid="newdevice-bypass-until">{t('newdevice.bypass_until', { when: fmtDateTime(until, ar ? 'ar' : 'en') })}</p>}
      </div>

      <UnsavedGuard scope="settings" dirty={dirty} needsReason label={t('ui.guard_settings')} onSave={(reason) => new Promise<boolean>((res) => set.mutate({ version: cur.version, enabled: v.enabled, code_minutes: v.minutes, include_admins: v.admins, reason }, { onSuccess: () => res(true), onError: () => res(false) }))} />
      {pending?.kind === 'set' && (
        <FormDialog open onClose={close} testid="newdevice-dialog" title={t('newdevice.title')} busy={set.isPending} error={err(set)}
          onSubmit={(reason) => set.mutate({ version: cur.version, enabled: v.enabled, code_minutes: v.minutes, include_admins: v.admins, reason }, { onSuccess: () => { toast(t('settings.audited')); close(); setDraft(null); } })}>
          <p className="text-sm text-mute">{t('newdevice.confirm_set', { enabled: t(v.enabled ? 'newdevice.on' : 'newdevice.off_word'), minutes: v.minutes })}</p>
        </FormDialog>
      )}
      {pending?.kind === 'bypass' && who && (
        <FormDialog open onClose={close} testid="newdevice-dialog" title={t('newdevice.bypass')} busy={bypass.isPending} error={err(bypass)}
          onSubmit={(reason) => bypass.mutate({ user_id: who.id, minutes, reason }, { onSuccess: (r) => { toast(t('settings.audited')); setUntil(r.until); close(); setWho(null); setSearch(''); } })}>
          <p className="text-sm text-mute">{t('newdevice.confirm_bypass', { who: who.name, minutes })}</p>
        </FormDialog>
      )}
    </section>
  );
}
