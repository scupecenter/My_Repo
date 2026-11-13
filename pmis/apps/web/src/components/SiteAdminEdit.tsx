import { ShieldAlert, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminEditSite, useRevertOverride, type SiteAdminEditBody } from '@/api/adminEdit';
import { ApiError } from '@/api/client';
import type { SiteCustomField } from '@/api/qc';
import { useRegions } from '@/api/sites';
import type { SiteDetail } from '@/api/types';
import { taskErrorMessage } from '@/lib/taskErrors';
import { useToast } from './Toast';

/**
 * Owner decision 2026-11-12 (2), contract 0.15.6: "Edit (admin)". A System Admin edits identity, scenario and custom fields of a site at once (reason + step-up),
 * the Site ID stays immutable, every edit is an "Admin override" that can be reverted. Everybody else keeps the proposal form (SiteIdentity). Shown when `can_admin_edit`.
 */
const SCENARIOS: [string, string][] = [['new_build', 'New Build'], ['expansion', 'Expansion'], ['hot_swap', 'Hot Swap'], ['cold_swap', 'Cold Swap'], ['relocation', 'Relocation']];
const num = (v: string): number | null | undefined => (v.trim() === '' ? null : Number.isNaN(Number(v)) ? undefined : Number(v));

export function SiteAdminEdit({ site }: { site: SiteDetail }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const regions = useRegions();
  const edit = useAdminEditSite(site.id);
  const revert = useRevertOverride(site.id);
  const fields = (site.custom_fields ?? []) as SiteCustomField[];
  const values = (site.custom ?? {}) as Record<string, unknown>;
  const initial = () => ({
    name: site.name ?? '', name_ar: site.name_ar ?? '', latitude: site.latitude == null ? '' : String(site.latitude), longitude: site.longitude == null ? '' : String(site.longitude),
    region_id: String(site.region_id), cluster_code: site.cluster_code ?? '', scenario: site.delivery_scenario ?? '', reason: '',
    custom: Object.fromEntries(fields.map((f) => [f.code, values[f.code] == null ? '' : String(values[f.code])])) as Record<string, string>,
  });
  const [form, setForm] = useState<ReturnType<typeof initial> | null>(null);
  const [errors, setErrors] = useState<{ path: string; code: string }[]>([]);
  const [rev, setRev] = useState<{ id: string; reason: string } | null>(null);
  if (!site.can_admin_edit && !(site.admin_edits?.items.length)) return null;
  const cur = initial();
  const set = (k: Exclude<keyof ReturnType<typeof initial>, 'custom'>, v: string) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const body = (): SiteAdminEditBody | null => {
    if (!form) return null;
    const identity: NonNullable<SiteAdminEditBody['identity']> = {};
    if (form.name.trim() !== cur.name) identity.name = form.name.trim();
    if (form.name_ar.trim() !== cur.name_ar) identity.name_ar = form.name_ar.trim() === '' ? null : form.name_ar.trim();
    if (form.latitude.trim() !== cur.latitude || form.longitude.trim() !== cur.longitude) {
      identity.latitude = num(form.latitude) as number | null; identity.longitude = num(form.longitude) as number | null;
    }
    if (form.region_id !== cur.region_id) identity.region_id = Number(form.region_id);
    if (form.cluster_code.trim() !== cur.cluster_code) identity.cluster_code = form.cluster_code.trim() === '' ? null : form.cluster_code.trim();
    const custom: Record<string, unknown> = {};
    for (const f of fields) if (form.custom[f.code] !== cur.custom[f.code]) custom[f.code] = form.custom[f.code] === '' ? null : f.type === 'bool' ? form.custom[f.code] === 'true' : form.custom[f.code];
    const out: SiteAdminEditBody = { reason: form.reason.trim() };
    if (Object.keys(identity).length) out.identity = identity;
    if (form.scenario !== cur.scenario) out.scenario = SCENARIOS.find(([k]) => k === form.scenario)?.[1] ?? form.scenario;
    if (Object.keys(custom).length) out.custom = custom as SiteAdminEditBody['custom'];
    return out;
  };
  const b = body();
  const touched = !!b && (b.identity !== undefined || b.scenario !== undefined || b.custom !== undefined);
  const send = () => {
    if (!b || !touched) return;
    setErrors([]);
    edit.mutate(b, {
      onSuccess: () => { setForm(null); toast(t('siteAdminEdit.applied')); },
      onError: (err) => {
        const list = err instanceof ApiError && Array.isArray(err.problem.errors) ? (err.problem.errors as { path: string; code: string }[]) : [];
        setErrors(list);
        if (list.length === 0) { const m = taskErrorMessage(t as never, err); if (m) toast(m, 'err'); }
      },
    });
  };
  const undo = () => rev && revert.mutate({ id: rev.id, reason: rev.reason.trim() }, {
    onSuccess: () => { toast(t('siteAdminEdit.reverted')); setRev(null); },
    onError: (e) => { const m = taskErrorMessage(t as never, e); if (m) toast(m, 'err'); },
  });
  const errAt = (p: string) => errors.find((e) => e.path === p);
  const regionName = (id: number) => { const r = regions.data?.find((x) => x.id === id); return (i18n.language === 'ar' && r?.name_ar) || r?.name_en || String(id); };
  const txt = (k: 'name' | 'name_ar' | 'latitude' | 'longitude' | 'cluster_code', label: string, dir?: 'rtl') => (
    <label className="flex flex-col gap-1" key={k}><span className="text-mute">{label}</span>
      <input className="input" data-testid={`site-admin-${k}`} dir={dir} value={form![k]} onChange={(e) => set(k, e.target.value)} aria-invalid={!!errAt(`/identity/${k}`)} />
      {errAt(`/identity/${k}`) && <span className="text-xs text-lateInk" role="alert">{t(`siteIdentity.err.${errAt(`/identity/${k}`)!.code}`, { defaultValue: t('siteIdentity.err.invalid') })}</span>}
    </label>
  );
  const items = site.admin_edits?.items ?? [];
  return (
    <section className="mt-3 rounded-md border border-line p-3 text-sm" aria-label={t('siteAdminEdit.title')} data-testid="site-admin-edit">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-semibold">{t('siteAdminEdit.title')}</span>
        {site.admin_override_active && <span className="chip bg-waitBg text-waitInk" data-testid="site-admin-badge" title={t('siteAdminEdit.badge_title')}><ShieldAlert size={12} className="me-1" aria-hidden />{t('override.badge')}</span>}
        {site.can_admin_edit && !form && <button className="btn ms-auto" data-testid="site-admin-open" onClick={() => { setErrors([]); setForm(initial()); }}>{t('siteAdminEdit.open')}</button>}
      </div>
      {form && (
        <div className="mt-3 flex flex-col gap-3" data-testid="site-admin-form">
          <p className="text-mute">{t('siteAdminEdit.note')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {txt('name', t('siteIdentity.name'))}
            {txt('name_ar', t('siteIdentity.name_ar'), 'rtl')}
            {txt('latitude', t('siteIdentity.latitude'))}
            {txt('longitude', t('siteIdentity.longitude'))}
            <label className="flex flex-col gap-1"><span className="text-mute">{t('siteIdentity.region')}</span>
              <select className="input" data-testid="site-admin-region_id" value={form.region_id} onChange={(e) => set('region_id', e.target.value)}>
                {(regions.data ?? []).map((r) => <option key={r.id} value={r.id}>{regionName(r.id)}</option>)}
              </select></label>
            {txt('cluster_code', t('siteIdentity.cluster'))}
            <label className="flex flex-col gap-1"><span className="text-mute">{t('siteAdminEdit.scenario')}</span>
              <select className="input" data-testid="site-admin-scenario" value={form.scenario} onChange={(e) => set('scenario', e.target.value)}>
                {SCENARIOS.map(([k]) => <option key={k} value={k}>{t(`scenario.${k}`)}</option>)}
              </select>
              {errAt('/scenario') && <span className="text-xs text-lateInk" role="alert">{t('siteIdentity.err.invalid')}</span>}</label>
            {fields.map((f) => (
              <label className="flex flex-col gap-1" key={f.code}><span className="text-mute">{(i18n.language === 'ar' && f.label_ar) || f.label_en}</span>
                {f.type === 'bool'
                  ? <select className="input" data-testid={`site-admin-custom-${f.code}`} value={form.custom[f.code]} onChange={(e) => setForm({ ...form, custom: { ...form.custom, [f.code]: e.target.value } })}>
                    <option value="">{t('adminOverride.none')}</option><option value="true">{t('common.yes')}</option><option value="false">{t('common.no')}</option></select>
                  : <input className="input" data-testid={`site-admin-custom-${f.code}`} value={form.custom[f.code]} onChange={(e) => setForm({ ...form, custom: { ...form.custom, [f.code]: e.target.value } })} />}
                {errAt(`/custom/${f.code}`) && <span className="text-xs text-lateInk" role="alert">{t(`siteIdentity.err.${errAt(`/custom/${f.code}`)!.code}`, { defaultValue: t('siteIdentity.err.invalid') })}</span>}
              </label>
            ))}
          </div>
          {errors.filter((e) => !/^\/(identity|custom)\/|^\/scenario$/.test(e.path)).length > 0 && (
            <ul className="text-xs text-lateInk" role="alert" data-testid="site-admin-errors">{errors.filter((e) => !/^\/(identity|custom)\/|^\/scenario$/.test(e.path)).map((e, i) => <li key={i}>{e.path}: {t(`siteIdentity.err.${e.code}`, { defaultValue: t('siteIdentity.err.invalid') })}</li>)}</ul>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <input className="input min-w-[16rem] flex-1" aria-label={t('siteIdentity.reason')} placeholder={t('siteIdentity.reason')} data-testid="site-admin-reason" value={form.reason} onChange={(e) => set('reason', e.target.value)} />
            <button className="btn btn-primary" data-testid="site-admin-apply" disabled={form.reason.trim().length < 3 || !touched || edit.isPending} onClick={send}>{t('siteAdminEdit.apply')}</button>
            <button className="btn" data-testid="site-admin-cancel" onClick={() => { setForm(null); setErrors([]); }}>{t('common.cancel')}</button>
          </div>
        </div>
      )}
      {items.length > 0 && (
        <ul className="mt-3 space-y-1" data-testid="site-admin-history">
          {items.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center gap-2" data-testid={`site-admin-edit-${o.id}`} data-reverted={o.reverted_at ? 'true' : 'false'}>
              <span className="text-mute">{o.created_at.slice(0, 10)} · {o.acted_by?.display_name}</span>
              <span>{Object.keys(o.after ?? {}).join(', ')}</span>
              <span className="text-mute">{o.reason}</span>
              {o.reverted_at && <span className="chip bg-lockBg text-lockInk">{t('adminOverride.was_reverted')}</span>}
              {o.revertible && site.can_admin_edit && <button className="btn px-2 py-0.5 text-xs" data-testid={`site-admin-revert-${o.id}`} onClick={() => setRev({ id: o.id, reason: '' })}><Undo2 size={12} />{t('adminOverride.revert')}</button>}
            </li>
          ))}
        </ul>
      )}
      {rev && (
        <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="site-admin-revert-form">
          <input className="input min-w-[16rem] flex-1" aria-label={t('siteIdentity.reason')} placeholder={t('siteIdentity.reason')} data-testid="site-admin-revert-reason" value={rev.reason} onChange={(e) => setRev({ ...rev, reason: e.target.value })} />
          <button className="btn btn-primary" data-testid="site-admin-revert-send" disabled={rev.reason.trim().length < 3 || revert.isPending} onClick={undo}>{t('adminOverride.revert')}</button>
          <button className="btn" onClick={() => setRev(null)}>{t('common.cancel')}</button>
        </div>
      )}
    </section>
  );
}
