import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMe } from '@/api/hooks';
import { useProposeSiteChange, type SiteIdentityProposal } from '@/api/qc';
import { useRegions } from '@/api/sites';
import type { SiteDetail } from '@/api/types';
import { ApiError } from '@/api/client';
import { hasGrant, isAdmin } from '@/lib/perm';
import { taskErrorMessage } from '@/lib/taskErrors';
import { useToast } from './Toast';

/**
 * Technical decision Q473 (contract 0.14.1): the identity of a site (English and Arabic name, coordinates, region, cluster) is never edited directly. "Propose a change"
 * opens the same proposal as the Q225 switch (POST /sites/{id}/change-proposals): a reason is required, one Change Control draft per field, the site keeps its values until
 * L2 approves. The Site ID is shown and never offered for a change. Region and cluster change who can see the site, so only a System Admin sees them (the API answers 403
 * for anybody else).
 */
const FIELD_PATHS = ['name', 'name_ar', 'latitude', 'longitude', 'region_id', 'cluster_code', 'site_code'];
const num = (v: string): number | undefined => (v.trim() === '' || Number.isNaN(Number(v)) ? undefined : Number(v));

export function SiteIdentity({ site }: { site: SiteDetail }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const me = useMe(true).data;
  const regions = useRegions();
  const propose = useProposeSiteChange(site.id);
  const admin = isAdmin(me);
  const may = !!me && (admin || hasGrant(me, 'create') || hasGrant(me, 'edit'));
  const initial = () => ({
    name: site.name ?? '', name_ar: site.name_ar ?? '', latitude: site.latitude == null ? '' : String(site.latitude), longitude: site.longitude == null ? '' : String(site.longitude),
    region_id: String(site.region_id), cluster_code: site.cluster_code ?? '', reason: '',
  });
  const [form, setForm] = useState<ReturnType<typeof initial> | null>(null);
  const [errors, setErrors] = useState<{ path: string; code: string }[]>([]);
  if (!may) return null;
  const set = (k: keyof ReturnType<typeof initial>, v: string) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const cur = initial();

  const identity = (f: ReturnType<typeof initial>): SiteIdentityProposal => {
    const out: SiteIdentityProposal = {};
    if (f.name.trim() !== cur.name) out.name = f.name.trim();
    if (f.name_ar.trim() !== cur.name_ar) out.name_ar = f.name_ar.trim() === '' ? null : f.name_ar.trim();
    if (f.latitude.trim() !== cur.latitude || f.longitude.trim() !== cur.longitude) {
      out.latitude = (num(f.latitude) ?? (f.latitude.trim() || null)) as number;   // a blank or a text that is not a number goes to the API, which answers pair_required or invalid
      out.longitude = (num(f.longitude) ?? (f.longitude.trim() || null)) as number;
    }
    if (admin && f.region_id !== cur.region_id) out.region_id = Number(f.region_id);
    if (admin && f.cluster_code.trim() !== cur.cluster_code) out.cluster_code = f.cluster_code.trim() === '' ? null : f.cluster_code.trim();
    return out;
  };
  const body = form ? identity(form) : {};
  const send = () => {
    if (!form || Object.keys(body).length === 0) return;
    setErrors([]);
    propose.mutate({ identity: body, reason: form.reason.trim() }, {
      onSuccess: (r) => { setForm(null); toast(t('siteIdentity.proposed', { count: r.items.length, ids: r.items.map((i) => i.change_id).join(', ') })); },
      onError: (err) => {
        const list = err instanceof ApiError && Array.isArray(err.problem.errors) ? (err.problem.errors as { path: string; code: string }[]) : [];
        setErrors(list);
        if (err instanceof ApiError && err.status === 403) toast(t('siteIdentity.forbidden'), 'err');
        else if (list.length === 0) toast(taskErrorMessage(t as never, err) || t('siteIdentity.failed'), 'err');
      },
    });
  };
  const err = (path: string) => errors.find((e) => e.path === `/identity/${path}`);
  const errText = (path: string) => { const e = err(path); return e ? t(`siteIdentity.err.${e.code}`, { defaultValue: t('siteIdentity.err.invalid') }) : null; };
  const regionName = (id: number) => { const r = regions.data?.find((x) => x.id === id); return (i18n.language === 'ar' && r?.name_ar) || r?.name_en || String(id); };
  const other = errors.filter((e) => !FIELD_PATHS.some((p) => e.path === `/identity/${p}`));
  const field = (k: 'name' | 'name_ar' | 'latitude' | 'longitude' | 'cluster_code', label: string, extra: { dir?: 'rtl'; inputMode?: 'decimal'; path?: string } = {}) => (
    <label className="flex flex-col gap-1 text-sm" key={k}>
      <span className="text-mute">{label}</span>
      <input className="input" data-testid={`site-identity-${k}`} value={form![k]} dir={extra.dir} inputMode={extra.inputMode} onChange={(e) => set(k, e.target.value)} aria-invalid={!!err(extra.path ?? k)} />
      {errText(extra.path ?? k) && <span className="text-xs text-lateInk" role="alert" data-testid={`site-identity-error-${extra.path ?? k}`}>{errText(extra.path ?? k)}</span>}
    </label>
  );

  return (
    <section className="mt-3 rounded-md border border-line p-3 text-sm" aria-label={t('siteIdentity.title')} data-testid="site-identity">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-semibold">{t('siteIdentity.title')}</span>
        <span><span className="text-mute">{t('siteIdentity.site_id')}:</span> <b className="mono" data-testid="site-identity-site-code">{site.site_code}</b></span>
        <span className="chip bg-card2 text-xs" title={t('siteIdentity.site_id_hint')} data-testid="site-identity-immutable">{t('siteIdentity.immutable')}</span>
        {!form && <button className="btn ms-auto" data-testid="site-identity-open" onClick={() => { setErrors([]); setForm(initial()); }}>{t('siteIdentity.open')}</button>}
      </div>
      {form && (
        <div className="mt-3 flex flex-col gap-3" data-testid="site-identity-form">
          <p className="text-mute" data-testid="site-identity-note">{admin ? t('siteIdentity.note_admin') : t('siteIdentity.note')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {field('name', t('siteIdentity.name'))}
            {field('name_ar', t('siteIdentity.name_ar'), { dir: 'rtl' })}
            {field('latitude', t('siteIdentity.latitude'), { inputMode: 'decimal' })}
            {field('longitude', t('siteIdentity.longitude'), { inputMode: 'decimal' })}
            {admin && (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-mute">{t('siteIdentity.region')}</span>
                <select className="input" data-testid="site-identity-region_id" value={form.region_id} onChange={(e) => set('region_id', e.target.value)}>
                  {(regions.data ?? []).map((r) => <option key={r.id} value={r.id}>{regionName(r.id)}</option>)}
                </select>
                {errText('region_id') && <span className="text-xs text-lateInk" role="alert" data-testid="site-identity-error-region_id">{errText('region_id')}</span>}
              </label>
            )}
            {admin && field('cluster_code', t('siteIdentity.cluster'))}
          </div>
          {admin && form.region_id !== cur.region_id && (
            <p className="text-mute" data-testid="site-identity-move">{t('siteIdentity.move', { from: regionName(site.region_id), to: regionName(Number(form.region_id)) })}</p>
          )}
          {err('site_code') && <p className="text-lateInk" role="alert">{errText('site_code')}</p>}
          {other.length > 0 && <ul className="text-xs text-lateInk" role="alert" data-testid="site-identity-errors">{other.map((e, i) => <li key={i}>{e.path}: {t(`siteIdentity.err.${e.code}`, { defaultValue: t('siteIdentity.err.invalid') })}</li>)}</ul>}
          <div className="flex flex-wrap items-center gap-2">
            <input className="input min-w-[16rem] flex-1" aria-label={t('siteIdentity.reason')} placeholder={t('siteIdentity.reason')} data-testid="site-identity-reason" value={form.reason}
              onChange={(e) => set('reason', e.target.value)} />
            <button className="btn btn-primary" data-testid="site-identity-send" disabled={!form.reason.trim() || Object.keys(body).length === 0 || propose.isPending} onClick={send}>{t('siteIdentity.propose')}</button>
            <button className="btn" data-testid="site-identity-cancel" onClick={() => { setForm(null); setErrors([]); }}>{t('common.cancel')}</button>
          </div>
        </div>
      )}
    </section>
  );
}
