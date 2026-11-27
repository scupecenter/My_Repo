import { Fingerprint } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePasskeySetting, useSetPasskeys } from '@/api/settings';
import { errText, FormDialog } from '@/components/FormDialog';
import { QueryFallback } from '@/components/States';
import { useToast } from '@/components/Toast';
import { fmtDateTime } from '@/lib/time';

/**
 * Settings, Security, Passkeys (migration 0294, contract 0.15.194). Off by default. When on, an account that already has two-step verification may add a passkey and
 * use it instead of the code at the second step of the password sign-in. Nothing is forced: the code and the recovery codes keep working, no account is left with a
 * passkey only, and turning this off keeps the registered passkeys (they work again when it is turned back on). Only a System Admin sees the data (403 for others).
 */
export function Passkeys() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const ar = i18n.language === 'ar';
  const q = usePasskeySetting();
  const set = useSetPasskeys();
  const [draft, setDraft] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  if (q.isError && (q.error as { status?: number }).status === 403) return <section className="card p-4" data-testid="passkeys-readonly"><p className="text-sm text-mute">{t('passkeys.readonly')}</p></section>;
  if (!q.data) return <QueryFallback queries={[q]} testid="passkeys-loading" />;
  const cur = q.data;
  const v = draft ?? cur.enabled;
  const dirty = v !== cur.enabled;
  const valid = !v || cur.ready || cur.enabled;
  return (
    <section className="card space-y-4 p-4" data-testid="page-passkeys">
      <div>
        <h2 className="flex items-center gap-2 font-bold"><Fingerprint size={16} aria-hidden />{t('passkeys.title')}</h2>
        <p className="text-sm text-mute">{t('passkeys.note')}</p>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" data-testid="passkeys-enabled" checked={v} disabled={!cur.can_edit} onChange={(e) => setDraft(e.target.checked)} />
        <span><span className="font-semibold">{t('passkeys.enable')}</span><span className="block text-xs text-mute">{t('passkeys.enable_note')}</span></span>
      </label>
      {!cur.ready && <p className="text-sm text-lateInk" data-testid="passkeys-not-ready">{t('passkeys.not_ready')}</p>}
      <p className="text-xs text-mute">{t('passkeys.recovery_note')}</p>
      <button className="btn btn-accent" data-testid="passkeys-save" disabled={!dirty || !valid || !cur.can_edit} onClick={() => setOpen(true)}>{t('passkeys.save')}</button>
      {cur.updated_at && <p className="text-xs text-mute" data-testid="passkeys-updated">{t('passkeys.updated', { name: (cur.updated_by as { display_name?: string } | null)?.display_name ?? '', when: fmtDateTime(cur.updated_at, ar ? 'ar' : 'en') })}</p>}
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="passkeys-dialog" title={t('passkeys.title')} busy={set.isPending} error={set.isError ? errText(set.error as never, t) : null}
          onSubmit={(reason) => set.mutate({ version: cur.version, enabled: v, reason }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setDraft(null); } })}>
          <p className="text-sm text-mute">{t('passkeys.confirm_set', { state: t(v ? 'passkeys.on' : 'passkeys.off_word') })}</p>
        </FormDialog>
      )}
    </section>
  );
}
