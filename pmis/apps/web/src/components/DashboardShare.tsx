import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useSearchParams } from 'react-router-dom';
import { Check, Copy, Link2, Share2, Trash2 } from 'lucide-react';
import { useCreateShareLink, useResolveShareLink, useRevokeShareLink, useShareLinks, type DashboardShareLink } from '@/api/dashboardShares';
import { Dashboard } from '@/pages/Dashboard';
import { useToast } from '@/components/Toast';

/** The GET /dashboard parameters a share link may carry (contract 0.15.402). */
const SHARE_KEYS = ['ref_date', 'region_id', 'cluster_code', 'scenario', 'stream', 'view', 'exclude_overrides'] as const;

export const shareParamsOf = (sp: URLSearchParams): Record<string, string> =>
  Object.fromEntries(SHARE_KEYS.map((k) => [k, sp.get(k) ?? '']).filter(([, v]) => v !== ''));

/** Create-a-link dialog on the dashboard toolbar (owner decision 2026-11-26 00:51): the link opens the same view, read-only, after the opener's own sign-in. */
export function ShareDashboardButton({ sp }: { sp: URLSearchParams }) {
  const { t } = useTranslation();
  const toast = useToast();
  const create = useCreateShareLink();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [days, setDays] = useState(30);
  const [reason, setReason] = useState('');
  const [made, setMade] = useState<{ url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const params = shareParamsOf(sp);

  const close = () => { setOpen(false); setMade(null); setLabel(''); setReason(''); setDays(30); };
  const submit = () => {
    create.mutate(
      { label: label.trim() || undefined, params, days, reason: reason.trim() },
      {
        onSuccess: (r) => setMade({ url: `${window.location.origin}${r.path}` }),
        onError: () => toast(t('dashshare.create_failed')),
      },
    );
  };

  return (
    <>
      <button className="btn" data-testid="dash-share-link" onClick={() => setOpen(true)}>
        <Share2 size={16} />
        {t('dashshare.share')}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={t('dashshare.share')} data-testid="dashshare-dialog">
          <div className="card w-full max-w-md space-y-3 p-4">
            <h2 className="text-lg font-semibold">{t('dashshare.title')}</h2>
            <p className="text-sm text-mute">{t('dashshare.hint')}</p>
            {!made ? (
              <>
                <label className="block text-sm font-semibold" htmlFor="dsh-label">{t('dashshare.label')}
                  <input id="dsh-label" data-testid="dashshare-label" className="input mt-1 w-full" maxLength={120} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('dashshare.label_ph')} />
                </label>
                <label className="block text-sm font-semibold" htmlFor="dsh-days">{t('dashshare.days')}
                  <select id="dsh-days" data-testid="dashshare-days" className="input mt-1 w-full" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                    {[7, 30, 90, 365].map((d) => <option key={d} value={d}>{t('dashshare.days_n', { n: d })}</option>)}
                  </select>
                </label>
                <label className="block text-sm font-semibold" htmlFor="dsh-reason">{t('dashshare.reason')}
                  <input id="dsh-reason" data-testid="dashshare-reason" className="input mt-1 w-full" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
                </label>
                <div className="flex justify-end gap-2">
                  <button className="btn" data-testid="dashshare-cancel" onClick={close}>{t('common.cancel')}</button>
                  <button className="btn btn-primary" data-testid="dashshare-create" disabled={reason.trim().length < 3 || create.isPending} onClick={submit}>{t('dashshare.create')}</button>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <input className="input w-full" dir="ltr" readOnly value={made.url} data-testid="dashshare-url" onFocus={(e) => e.target.select()} />
                  <button
                    className="btn" data-testid="dashshare-copy" aria-label={t('dashshare.copy')}
                    onClick={() => void navigator.clipboard?.writeText(made.url).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 2000); })}
                  >
                    {copied ? <Check size={16} /> : <Copy size={16} />}
                  </button>
                </div>
                <p className="text-sm text-mute">{t('dashshare.made_hint')}</p>
                <div className="flex justify-end"><button className="btn" data-testid="dashshare-done" onClick={close}>{t('common.close')}</button></div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** /dashboard/shared/:token — opens the envelope, then renders the normal dashboard with the shared query (the opener's own rights and regions apply). */
export function SharedDashboard() {
  const { t } = useTranslation();
  const { token = '' } = useParams();
  const [sp, setSp] = useSearchParams();
  const q = useResolveShareLink(token);
  const seeded = useRef(false);
  useEffect(() => {
    if (q.data && !seeded.current) {
      seeded.current = true;
      setSp(new URLSearchParams(q.data.params as Record<string, string>), { replace: true });
    }
  }, [q.data, setSp]);

  if (q.isLoading) return <p className="p-4" data-testid="shared-loading">{t('common.loading')}</p>;
  if (q.isError) {
    const status = (q.error as { status?: number })?.status;
    return (
      <section className="card m-4 max-w-lg p-6 text-center" data-testid="shared-unavailable">
        <Link2 size={28} className="mx-auto text-mute" />
        <h1 className="mt-2 text-lg font-semibold">{status === 410 ? t('dashshare.gone_title') : t('dashshare.missing_title')}</h1>
        <p className="mt-1 text-sm text-mute">{status === 410 ? t('dashshare.gone_body') : t('dashshare.missing_body')}</p>
      </section>
    );
  }
  return (
    <div>
      <div className="mx-4 mt-3 rounded-md border border-line bg-hover px-3 py-2 text-sm" role="note" data-testid="shared-banner">
        {t('dashshare.banner', { label: q.data!.label || t('dashshare.untitled'), name: q.data!.created_by ?? '' })}
      </div>
      <Dashboard />
    </div>
  );
}

const fmt = (iso: string | null | undefined, locale: string) => (iso ? new Date(iso).toLocaleString(locale) : '—');

/** Settings > Dashboard > Share links: every link of the caller (all of them for a System Admin), with revoke. */
export function ShareLinksCard() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const links = useShareLinks();
  const revoke = useRevokeShareLink();
  const [ask, setAsk] = useState<DashboardShareLink | null>(null);
  const [reason, setReason] = useState('');
  const locale = i18n.language === 'ar' ? 'ar-LY' : 'en-GB';
  const now = Date.now();
  const stateOf = (l: DashboardShareLink) =>
    l.revoked_at ? t('dashshare.st_revoked') : l.expires_at && Date.parse(l.expires_at) <= now ? t('dashshare.st_expired') : t('dashshare.st_active');

  return (
    <section className="card space-y-3 p-4" data-testid="dsettings-shares">
      <h2 className="font-semibold">{t('dashshare.settings_title')}</h2>
      <p className="text-sm text-mute">{t('dashshare.settings_hint')}</p>
      {links.isLoading && <p data-testid="dsettings-shares-loading">{t('common.loading')}</p>}
      {links.data && links.data.length === 0 && <p className="text-sm text-mute" data-testid="dsettings-shares-empty">{t('dashshare.empty')}</p>}
      {links.data && links.data.length > 0 && (
        <table className="w-full text-sm" data-testid="dsettings-shares-table">
          <thead><tr className="text-start text-mute">
            <th className="p-1 text-start">{t('dashshare.col_label')}</th><th className="p-1 text-start">{t('dashshare.col_by')}</th>
            <th className="p-1 text-start">{t('dashshare.col_created')}</th><th className="p-1 text-start">{t('dashshare.col_expires')}</th>
            <th className="p-1 text-start">{t('dashshare.col_opens')}</th><th className="p-1 text-start">{t('dashshare.col_state')}</th><th className="p-1" />
          </tr></thead>
          <tbody>
            {links.data.map((l) => (
              <tr key={l.id} data-testid={`dsettings-share-${l.id}`}>
                <td className="p-1">{l.label || t('dashshare.untitled')}</td>
                <td className="p-1">{l.created_by_name}</td>
                <td className="p-1" dir="ltr">{fmt(l.created_at, locale)}</td>
                <td className="p-1" dir="ltr">{fmt(l.expires_at, locale)}</td>
                <td className="p-1">{l.open_count}</td>
                <td className="p-1">{stateOf(l)}</td>
                <td className="p-1">
                  {!l.revoked_at && (
                    <button className="btn btn-ghost p-1" aria-label={t('dashshare.revoke')} data-testid={`dsettings-share-revoke-${l.id}`} onClick={() => { setAsk(l); setReason(''); }}>
                      <Trash2 size={14} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {ask && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true" data-testid="dashshare-revoke-dialog">
          <div className="card w-full max-w-sm space-y-3 p-4">
            <h3 className="font-semibold">{t('dashshare.revoke_title', { label: ask.label || t('dashshare.untitled') })}</h3>
            <label className="block text-sm font-semibold" htmlFor="dsh-rev-reason">{t('dashshare.reason')}
              <input id="dsh-rev-reason" data-testid="dashshare-revoke-reason" className="input mt-1 w-full" value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <div className="flex justify-end gap-2">
              <button className="btn" data-testid="dashshare-revoke-cancel" onClick={() => setAsk(null)}>{t('common.cancel')}</button>
              <button
                className="btn btn-primary" data-testid="dashshare-revoke-confirm" disabled={reason.trim().length < 3 || revoke.isPending}
                onClick={() => revoke.mutate({ id: ask.id, reason: reason.trim() }, { onSuccess: () => setAsk(null), onError: () => toast(t('dashshare.revoke_failed')) })}
              >{t('dashshare.revoke')}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
