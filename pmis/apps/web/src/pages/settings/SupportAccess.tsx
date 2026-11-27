import { LifeBuoy } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePicker } from '@/api/admin';
import { useGrantSupport, useRevokeAllSupport, useRevokeSupport, useSetSupportAccess, useSupportAccess, useSupportGrants } from '@/api/settings';
import { errText, FormDialog } from '@/components/FormDialog';
import { QueryFallback } from '@/components/States';
import { useToast } from '@/components/Toast';
import { fmtDateTime } from '@/lib/time';

const RIGHTS = [['templates.edit', 'templates'], ['fields.edit', 'fields'], ['documents.edit', 'documents'], ['warehouse.items.edit', 'warehouse']] as const;
type Pending = { kind: 'set' } | { kind: 'grant' } | { kind: 'revoke'; id: string } | { kind: 'revoke_all' };

/**
 * Settings, Security, Support access (migration 0291, contract 0.15.191). A System Admin lets a named person help with configuration for a short time. Off by default.
 * A grant is an ordinary delegation: it ends by itself at its expiry, can be revoked at any time (one or all), and gives edit rights only. Every action asks for a reason and
 * a step-up and is audited. Only a System Admin sees the data (the API answers 403 to anyone else), so others get a short notice.
 */
export function SupportAccess() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const ar = i18n.language === 'ar';
  const q = useSupportAccess();
  const grants = useSupportGrants(q.isSuccess);
  const set = useSetSupportAccess(), grant = useGrantSupport(), revoke = useRevokeSupport(), revokeAll = useRevokeAllSupport();
  const [draft, setDraft] = useState<{ enabled: boolean; max: number; def: number } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [search, setSearch] = useState('');
  const [who, setWho] = useState<{ id: string; name: string } | null>(null);
  const [rights, setRights] = useState<string[]>([]);
  const [hours, setHours] = useState<number | null>(null);
  const picker = usePicker(who ? '' : search);
  if (q.isError && (q.error as { status?: number }).status === 403) return <section className="card p-4" data-testid="support-readonly"><p className="text-sm text-mute">{t('supportaccess.readonly')}</p></section>;
  if (!q.data) return <QueryFallback queries={[q]} testid="support-loading" />;
  const cur = q.data;
  const v = draft ?? { enabled: cur.enabled, max: cur.max_hours, def: cur.default_hours };
  const dirty = v.enabled !== cur.enabled || v.max !== cur.max_hours || v.def !== cur.default_hours;
  const validCfg = v.max >= 1 && v.max <= 168 && v.def >= 1 && v.def <= v.max;
  const h = hours ?? cur.default_hours;
  const canGrant = cur.enabled && !!who && rights.length > 0 && h >= 1 && h <= cur.max_hours;
  const close = () => setPending(null);
  const err = (m: { isError: boolean; error: unknown }) => (m.isError ? errText(m.error as never, t) : null);

  return (
    <section className="card space-y-5 p-4" data-testid="page-support-access">
      <div>
        <h2 className="flex items-center gap-2 font-bold"><LifeBuoy size={16} aria-hidden />{t('supportaccess.title')}</h2>
        <p className="text-sm text-mute">{t('supportaccess.note')}</p>
      </div>

      <div className="space-y-2">
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" data-testid="support-enabled" checked={v.enabled} onChange={(e) => setDraft({ ...v, enabled: e.target.checked })} />
          <span><span className="font-semibold">{t('supportaccess.enable')}</span><span className="block text-xs text-mute">{t('supportaccess.enable_note')}</span></span>
        </label>
        <div className="flex flex-wrap gap-3 text-sm">
          <label>{t('supportaccess.max_hours')}<input type="number" min={1} max={168} className="input ms-2 w-24" data-testid="support-max" value={v.max} onChange={(e) => setDraft({ ...v, max: Number(e.target.value) })} /></label>
          <label>{t('supportaccess.default_hours')}<input type="number" min={1} max={168} className="input ms-2 w-24" data-testid="support-default" value={v.def} onChange={(e) => setDraft({ ...v, def: Number(e.target.value) })} /></label>
        </div>
        <button className="btn btn-accent" data-testid="support-save" disabled={!dirty || !validCfg} onClick={() => setPending({ kind: 'set' })}>{t('supportaccess.save')}</button>
      </div>

      <div className="space-y-2 border-t border-line pt-4">
        <h3 className="font-semibold">{t('supportaccess.grant')}</h3>
        {!cur.enabled && <p className="text-sm text-mute" data-testid="support-off">{t('supportaccess.off')}</p>}
        <div className="space-y-2 text-sm">
          <div>
            <label className="block">{t('supportaccess.who')}</label>
            {who
              ? <span className="chip" data-testid="support-who">{who.name} <button type="button" className="ms-1" aria-label={t('common.cancel')} onClick={() => { setWho(null); setSearch(''); }}>×</button></span>
              : <>
                  <input className="input w-64" data-testid="support-search" placeholder={t('supportaccess.who_ph')} value={search} onChange={(e) => setSearch(e.target.value)} disabled={!cur.enabled} />
                  <ul className="mt-1 max-w-sm">{(picker.data ?? []).map((u) => <li key={u.id}><button type="button" className="btn" data-testid={`support-pick-${u.id}`} onClick={() => setWho({ id: u.id, name: u.display_name })}>{u.display_name}</button></li>)}</ul>
                </>}
          </div>
          <fieldset>
            <legend>{t('supportaccess.rights')}</legend>
            {RIGHTS.filter(([r]) => cur.modules.length > 0 && r).map(([r, k]) => (
              <label key={r} className="me-3 inline-flex items-center gap-1"><input type="checkbox" data-testid={`support-right-${k}`} disabled={!cur.enabled} checked={rights.includes(r)}
                onChange={(e) => setRights(e.target.checked ? [...rights, r] : rights.filter((x) => x !== r))} />{t(`supportaccess.right_${k}`)}</label>
            ))}
          </fieldset>
          <label>{t('supportaccess.hours')}<input type="number" min={1} max={cur.max_hours} className="input ms-2 w-24" data-testid="support-hours" disabled={!cur.enabled} value={h} onChange={(e) => setHours(Number(e.target.value))} /></label>
        </div>
        <button className="btn btn-accent" data-testid="support-grant" disabled={!canGrant} onClick={() => setPending({ kind: 'grant' })}>{t('supportaccess.grant_btn')}</button>
      </div>

      <div className="space-y-2 border-t border-line pt-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">{t('supportaccess.grants')}</h3>
          <button className="btn" data-testid="support-revoke-all" disabled={!(grants.data ?? []).some((g) => g.state === 'active')} title={t('supportaccess.revoke_all_note')} onClick={() => setPending({ kind: 'revoke_all' })}>{t('supportaccess.revoke_all')}</button>
        </div>
        {grants.data && grants.data.length === 0 && <p className="text-sm text-mute" data-testid="support-none">{t('supportaccess.none')}</p>}
        <ul className="space-y-1 text-sm" data-testid="support-list">
          {(grants.data ?? []).map((g) => (
            <li key={g.id} className="flex flex-wrap items-center gap-2" data-testid={`support-grant-${g.id}`}>
              <span className="font-semibold">{g.to_user?.display_name ?? ''}</span>
              <span className={`chip ${g.state === 'active' ? '' : 'bg-state-locked-bg text-state-locked-fg'}`} data-testid={`support-state-${g.id}`}>{t(`supportaccess.state_${g.state === 'active' ? 'active' : g.state === 'revoked' ? 'revoked' : 'expired'}`)}</span>
              <span className="text-mute">{g.valid_to ? t('supportaccess.until', { when: fmtDateTime(g.valid_to, ar ? 'ar' : 'en') }) : ''}</span>
              <span className="text-mute">{t('supportaccess.by', { name: g.from_user.display_name })}</span>
              {g.state === 'active' && <button className="btn" data-testid={`support-revoke-${g.id}`} onClick={() => setPending({ kind: 'revoke', id: g.id })}>{t('supportaccess.revoke')}</button>}
            </li>
          ))}
        </ul>
      </div>

      {pending?.kind === 'set' && (
        <FormDialog open onClose={close} testid="support-dialog" title={t('supportaccess.title')} busy={set.isPending} error={err(set)}
          onSubmit={(reason) => set.mutate({ version: cur.version, enabled: v.enabled, max_hours: v.max, default_hours: v.def, reason }, { onSuccess: () => { toast(t('settings.audited')); close(); setDraft(null); } })}>
          <p className="text-sm text-mute">{t('supportaccess.confirm_set', { enabled: t(v.enabled ? 'supportaccess.on' : 'supportaccess.off_word'), max: v.max, def: v.def })}</p>
        </FormDialog>
      )}
      {pending?.kind === 'grant' && who && (
        <FormDialog open onClose={close} testid="support-dialog" title={t('supportaccess.grant')} busy={grant.isPending} error={err(grant)}
          onSubmit={(reason) => grant.mutate({ to_user_id: who.id, rights, hours: h, reason }, { onSuccess: () => { toast(t('settings.audited')); close(); setWho(null); setSearch(''); setRights([]); setHours(null); } })}>
          <p className="text-sm text-mute">{t('supportaccess.confirm_grant', { who: who.name, hours: h })}</p>
        </FormDialog>
      )}
      {pending?.kind === 'revoke' && (
        <FormDialog open onClose={close} testid="support-dialog" title={t('supportaccess.revoke')} busy={revoke.isPending} error={err(revoke)}
          onSubmit={(reason) => revoke.mutate({ id: pending.id, reason }, { onSuccess: () => { toast(t('settings.audited')); close(); } })}>
          <p className="text-sm text-mute">{t('supportaccess.confirm_revoke')}</p>
        </FormDialog>
      )}
      {pending?.kind === 'revoke_all' && (
        <FormDialog open onClose={close} testid="support-dialog" title={t('supportaccess.revoke_all')} busy={revokeAll.isPending} error={err(revokeAll)}
          onSubmit={(reason) => revokeAll.mutate({ reason }, { onSuccess: (r) => { toast(t('supportaccess.revoked_n', { n: r.revoked })); close(); } })}>
          <p className="text-sm text-mute">{t('supportaccess.revoke_all_note')}</p>
        </FormDialog>
      )}
    </section>
  );
}
