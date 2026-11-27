import { Fingerprint, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { useAdminRevokePasskeys, useMyPasskeys, usePasskeyRegisterOptions, usePasskeyRegisterVerify, useRemovePasskey } from '@/api/settings';
import { usePasskeySignIn, usePasskeySignInOptions } from '@/api/auth';
import { createPasskey, getPasskeyAssertion, passkeysSupported, wasCancelled } from '@/lib/webauthnClient';
import { fmtDateTime } from '@/lib/time';
import { errText, FormDialog } from './FormDialog';
import { useToast } from './Toast';

/** Profile: the person's own passkeys (0.15.194). Shown only when an admin turned passkeys on. Needs two-step verification; adding one asks for the step-up. */
export function MyPasskeysSection() {
  const { t, i18n } = useTranslation();
  const q = useMyPasskeys();
  const opts = usePasskeyRegisterOptions(), verify = usePasskeyRegisterVerify(), remove = useRemovePasskey();
  const [label, setLabel] = useState('');
  const [err, setErr] = useState('');
  const [gone, setGone] = useState<string | null>(null);
  if (!q.data || !q.data.enabled) return null;
  const d = q.data;
  const add = async () => {
    setErr('');
    try {
      const o = await opts.mutateAsync();
      const response = await createPasskey(o);
      await verify.mutateAsync({ label: label.trim(), response });
      setLabel('');
    } catch (e) {
      if (wasCancelled(e)) return;
      setErr(e instanceof ApiError && e.status === 401 ? t('profile.tf_stepup_needed') : e instanceof ApiError ? errText(e, t) : t('passkeys.failed'));
    }
  };
  const busy = opts.isPending || verify.isPending;
  return (
    <div className="mt-4 space-y-2 border-t border-line pt-3" data-testid="pf-passkeys">
      <h3 className="flex items-center gap-2 font-semibold"><Fingerprint size={16} aria-hidden />{t('passkeys.mine_title')}</h3>
      <p className="text-sm text-mute">{t('passkeys.mine_note')}</p>
      {d.items.length === 0 && <p className="text-sm" data-testid="pf-passkeys-none">{t('passkeys.none')}</p>}
      <ul className="space-y-1">
        {d.items.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line p-2 text-sm" data-testid={`pf-passkey-${p.id}`}>
            <span><span className="font-semibold">{p.label}</span> <span className="text-xs text-mute">{t('passkeys.added', { when: fmtDateTime(p.created_at, i18n.language === 'ar' ? 'ar' : 'en') })}{p.last_used_at ? ` · ${t('passkeys.last_used', { when: fmtDateTime(p.last_used_at, i18n.language === 'ar' ? 'ar' : 'en') })}` : ''}</span></span>
            <button className="btn" data-testid={`pf-passkey-remove-${p.id}`} onClick={() => setGone(p.id)}><Trash2 size={14} />{t('passkeys.remove')}</button>
          </li>
        ))}
      </ul>
      {!d.ready && <p className="text-sm text-lateInk">{t('passkeys.not_ready_user')}</p>}
      {!d.can_add && d.ready && <p className="text-sm text-mute" data-testid="pf-passkeys-needs-tf">{t('passkeys.needs_two_factor')}</p>}
      {d.can_add && d.ready && !passkeysSupported() && <p className="text-sm text-mute" data-testid="pf-passkeys-unsupported">{t('passkeys.unsupported')}</p>}
      {d.can_add && d.ready && passkeysSupported() && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-sm font-semibold">{t('passkeys.label')}
            <input className="input mt-1 block w-56 font-normal" data-testid="pf-passkey-label" maxLength={80} placeholder={t('passkeys.label_ph')} value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <button className="btn btn-accent" data-testid="pf-passkey-add" disabled={!label.trim() || busy} onClick={() => void add()}><Fingerprint size={16} />{t('passkeys.add')}</button>
        </div>
      )}
      {err && <p role="alert" className="text-sm text-lateInk" data-testid="pf-passkeys-error">{err}</p>}
      {gone && (
        <FormDialog open onClose={() => setGone(null)} testid="pf-passkey-dialog" title={t('passkeys.remove')} busy={remove.isPending} error={remove.isError ? errText(remove.error as never, t) : null} withReason={false}
          onSubmit={() => remove.mutate(gone, { onSuccess: () => setGone(null) })}>
          <p className="text-sm text-mute">{t('passkeys.remove_note')}</p>
        </FormDialog>
      )}
    </div>
  );
}

/** Sign-in step 2: "Use a passkey" next to the code. Asked for only when the server says one is available for this pending sign-in. */
export function PasskeyButton({ onDone, onExpired }: { onDone: () => void; onExpired: () => void }) {
  const { t } = useTranslation();
  const opts = usePasskeySignInOptions(), sign = usePasskeySignIn();
  const [err, setErr] = useState('');
  const [avail, setAvail] = useState<boolean | null>(null);
  if (avail === null && !opts.isPending && !opts.isError && passkeysSupported()) opts.mutate(undefined, { onSuccess: (r) => setAvail(r.available), onError: () => setAvail(false) });
  if (!avail || !passkeysSupported()) return null;
  const go = async () => {
    setErr('');
    try {
      const o = await opts.mutateAsync();
      if (!o.available || !o.options) return setAvail(false);
      const response = await getPasskeyAssertion(o.options);
      await sign.mutateAsync({ response });
      onDone();
    } catch (e) {
      if (wasCancelled(e)) return;
      if (e instanceof ApiError && e.status === 401 && e.code === 'unauthenticated') return onExpired();
      setErr(e instanceof ApiError && e.status === 429 ? t('twoFactor.locked') : t('passkeys.signin_failed'));
    }
  };
  return (
    <div className="space-y-1">
      <button type="button" className="btn w-full" data-testid="two-factor-passkey" disabled={sign.isPending} onClick={() => void go()}><Fingerprint size={16} />{t('passkeys.use')}</button>
      {err && <p role="alert" className="text-sm text-lateInk" data-testid="two-factor-passkey-error">{err}</p>}
    </div>
  );
}

/** Admin recovery: remove every passkey of one person (lost device). Reason required; the step-up is asked by the client. Never touches the code or the recovery codes. */
export function RevokePasskeysDialog({ user, onClose }: { user: { id: string; display_name: string }; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const m = useAdminRevokePasskeys(user.id);
  return (
    <FormDialog open onClose={onClose} testid="passkeys-revoke-dialog" title={t('passkeys.revoke_title', { name: user.display_name })} busy={m.isPending} error={m.isError ? errText(m.error as never, t) : null}
      submitLabel={t('passkeys.revoke')} onSubmit={(reason) => m.mutate({ reason }, { onSuccess: (r) => { toast(t('passkeys.revoked', { count: r.revoked })); onClose(); } })}>
      <p className="rounded-md bg-card2 p-2 text-sm text-mute">{t('passkeys.revoke_note')}</p>
    </FormDialog>
  );
}
