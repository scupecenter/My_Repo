import { Lock, LockOpen } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRegisterStates, useSetRegisterState, type RegisterState } from '@/api/registerState';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';

type Change = { r: RegisterState; enabled?: boolean; locked?: boolean };

/**
 * Settings > Registers: every register with an enable switch (off = hidden, nothing deleted, back on restores everything) and a lock switch (locked = readable, but
 * no new record and no change except by a System Admin). Each change asks for a reason and is audited (migration 0381).
 */
export function RegisterStatePanel() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useRegisterStates();
  const set = useSetRegisterState();
  const [chg, setChg] = useState<Change | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const name = (r: RegisterState) => (i18n.language === 'ar' && r.name_ar) || r.name_en;
  const close = () => { setChg(null); setErr(null); };
  const submit = async (reason: string) => {
    if (!chg) return;
    setErr(null);
    try {
      await set.mutateAsync({ key: chg.r.register_key, version: chg.r.version, enabled: chg.enabled, locked: chg.locked, reason });
      toast(t('regstate.saved'));
      close();
    } catch (e) { setErr(errText(e, t)); }
  };
  const title = chg
    ? t(chg.enabled !== undefined ? (chg.enabled ? 'regstate.enable_title' : 'regstate.disable_title') : (chg.locked ? 'regstate.lock_title' : 'regstate.unlock_title'), { name: name(chg.r) })
    : '';
  return (
    <div className="card space-y-3 p-4" data-testid="register-state-panel">
      <h2 className="font-bold">{t('regstate.title')}</h2>
      <p className="text-sm text-mute">{t('regstate.note')}</p>
      {q.isLoading && <p className="text-mute">{t('common.loading')}</p>}
      {q.isError && <p className="text-danger">{t('errors.generic')}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-start text-mute">
            <th className="p-2 text-start">{t('regstate.register')}</th>
            <th className="p-2 text-start">{t('regstate.records')}</th>
            <th className="p-2 text-start">{t('regstate.enabled')}</th>
            <th className="p-2 text-start">{t('regstate.locked')}</th>
            <th className="p-2 text-start">{t('regstate.reason')}</th>
          </tr></thead>
          <tbody>
            {(q.data?.items ?? []).map((r) => (
              <tr key={r.register_key} className="border-t border-line" data-testid={`regstate-row-${r.register_key}`}>
                <td className="p-2">{name(r)}{!r.enabled && <span className="ms-2 rounded bg-surface-2 px-1 text-xs text-mute">{t('regstate.hidden')}</span>}</td>
                <td className="p-2">{r.records}</td>
                <td className="p-2">
                  <input type="checkbox" role="switch" data-testid={`regstate-enabled-${r.register_key}`} aria-label={t('regstate.enabled_aria', { name: name(r) })} checked={r.enabled} onChange={() => setChg({ r, enabled: !r.enabled })} />
                </td>
                <td className="p-2">
                  <button type="button" className="btn btn-ghost p-1" data-testid={`regstate-locked-${r.register_key}`} aria-pressed={r.locked} aria-label={t(r.locked ? 'regstate.unlock_aria' : 'regstate.lock_aria', { name: name(r) })} onClick={() => setChg({ r, locked: !r.locked })}>
                    {r.locked ? <Lock size={14} /> : <LockOpen size={14} />}
                  </button>
                </td>
                <td className="p-2 text-mute">{r.reason ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <FormDialog inline open={!!chg} onClose={close} testid="register-state-dialog" title={title} error={err} busy={set.isPending} onSubmit={(reason) => void submit(reason)}>
        {chg && <p className="text-sm text-mute">{t(chg.enabled === false ? 'regstate.disable_note' : chg.locked ? 'regstate.lock_note' : 'regstate.restore_note')}</p>}
      </FormDialog>
    </div>
  );
}
