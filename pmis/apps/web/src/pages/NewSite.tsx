import { Check, FilePlus2, Pencil, Send, Trash2, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ApiError } from '@/api/client';
import { useCreateSiteDraft, useDecideSiteDraft, useDiscardSiteDraft, useRegions, useSiteDrafts, useSubmitSiteDraft, useUpdateSiteDraft } from '@/api/sites';
import type { SiteDraft, SiteDraftInput } from '@/api/types';
import { PageHeader } from '@/components/PageHeader';
import { RejectDialog } from '@/components/RejectDialog';
import { useToast } from '@/components/Toast';

const SCENARIOS = ['new_build', 'expansion', 'hot_swap', 'cold_swap', 'relocation'];
const SITE_SCENARIOS = ['Indoor', 'Outdoor'];
const FLAGS = ['scope_tower_erection', 'scope_site_adaption', 'scope_gecol_power', 'scope_hlc_fiber', 'scope_te_full', 'scope_te_ip_router_only'] as const;
const TEXT = ['site_code', 'name', 'name_ar', 'owner_site_id', 'cluster_code', 'site_type', 'project_phase', 'delivery_batch', 'cw_delivery_model', 'sub_region', 'latitude', 'longitude', 'address', 'rf_survey_date'] as const;
type Form = Record<string, string>;
const EMPTY: Form = { region_id: '', delivery_scenario: 'new_build', site_scenario: '', overall_status: '', workflow_locks: '', ...Object.fromEntries(TEXT.map((k) => [k, ''])), ...Object.fromEntries(FLAGS.map((k) => [k, ''])) };
const TONE: Record<string, string> = { entry: 'bg-waitBg text-waitInk', in_approval: 'bg-openBg text-openInk', approved: 'bg-doneBg text-doneInk', rejected: 'bg-lateBg text-lateInk', discarded: 'bg-lockBg text-lockInk' };

/** What the form sends: blank fields are left out (a blank scope flag is "not set"). */
const toInput = (f: Form): SiteDraftInput => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) {
    const x = v.trim();
    if (!x) continue;
    out[k] = k === 'region_id' ? Number(x) : x;
  }
  return out as unknown as SiteDraftInput;
};
/** The stored draft back into the form (flags are stored yes / na). */
const toForm = (d: SiteDraft): Form => {
  const f: Form = { ...EMPTY };
  for (const [k, v] of Object.entries(d.data ?? {})) {
    if (v === null || v === undefined) continue;
    f[k] = (FLAGS as readonly string[]).includes(k) ? (v === 'yes' ? 'Yes' : 'No') : k === 'workflow_locks' ? (/^open$/i.test(String(v)) ? 'Open' : '') : String(v);
  }
  return f;
};

/** The "New site" screen (contract 0.14.0, Q460): the manual entry way. L1 enters a draft and sends it; L2 approves it (a site is created only then) or returns it with a note. */
export function NewSite() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const regions = useRegions();
  const drafts = useSiteDrafts({});
  const create = useCreateSiteDraft(), update = useUpdateSiteDraft(), submit = useSubmitSiteDraft(), discard = useDiscardSiteDraft(), decide = useDecideSiteDraft();
  const [f, setF] = useState<Form>(EMPTY);
  const [editing, setEditing] = useState<SiteDraft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [returning, setReturning] = useState<SiteDraft | null>(null);
  const set = (k: string) => (v: string) => setF((p) => ({ ...p, [k]: v }));
  const rname = (id: number) => { const r = regions.data?.find((x) => x.id === id); return (i18n.language === 'ar' && r?.name_ar) || r?.name_en || String(id); };

  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.status === 422 && e.problem.errors?.length) {
      const m: Record<string, string> = {};
      for (const x of e.problem.errors as { path?: string; code?: string; message?: string }[]) m[(x.path ?? '').replace(/^\//, '')] = t(`newSite.err.${x.code}`, { defaultValue: x.message ?? x.code ?? '' });
      setErrors(m);
      setFormError(null);
      return;
    }
    const code = e instanceof ApiError ? e.code : '';
    if (code === 'step_up_required') return;
    const text = t(`newSite.err.${code}`, { defaultValue: e instanceof ApiError ? (e.problem.detail ?? t('newSite.err.generic')) : t('newSite.err.generic') });
    setErrors({});
    setFormError(text);
    toast(text, 'err');
  };
  const reset = () => { setF(EMPTY); setEditing(null); setErrors({}); setFormError(null); };
  const save = () => {
    setErrors({}); setFormError(null);
    if (editing) update.mutate({ draft: editing, body: toInput(f) }, { onSuccess: () => { toast(t('newSite.saved')); reset(); }, onError: fail });
    else create.mutate(toInput(f), { onSuccess: (d) => { toast(t('newSite.created', { code: d.site_code })); reset(); }, onError: fail });
  };
  const act = (m: { mutate: (v: never, o: { onSuccess: () => void; onError: (e: unknown) => void }) => void }, v: unknown, done: string) => m.mutate(v as never, { onSuccess: () => toast(done), onError: fail });
  const field = (k: string, label: string, o: { dir?: 'rtl' | 'ltr'; type?: string; required?: boolean } = {}) => (
    <div>
      <label htmlFor={`ns-${k}`} className="text-sm font-semibold">{label}{o.required && <span aria-hidden> *</span>}</label>
      <input id={`ns-${k}`} data-testid={`ns-${k}`} className="input mt-1" type={o.type ?? 'text'} dir={o.dir} value={f[k] ?? ''} onChange={(e) => set(k)(e.target.value)} aria-invalid={!!errors[k]} />
      {errors[k] && <p role="alert" className="mt-1 text-sm text-lateInk" data-testid={`ns-error-${k}`}>{errors[k]}</p>}
    </div>
  );
  const select = (k: string, label: string, options: [string, string][], o: { blank?: string; required?: boolean } = {}) => (
    <div>
      <label htmlFor={`ns-${k}`} className="text-sm font-semibold">{label}{o.required && <span aria-hidden> *</span>}</label>
      <select id={`ns-${k}`} data-testid={`ns-${k}`} className="input mt-1" value={f[k] ?? ''} onChange={(e) => set(k)(e.target.value)} aria-invalid={!!errors[k]}>
        {o.blank !== undefined && <option value="">{o.blank}</option>}
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      {errors[k] && <p role="alert" className="mt-1 text-sm text-lateInk" data-testid={`ns-error-${k}`}>{errors[k]}</p>}
    </div>
  );
  const busy = create.isPending || update.isPending;
  const items = drafts.data?.items ?? [];

  return (
    <div data-testid="page-new-site">
      <PageHeader title={t('newSite.title')} subtitle={t('newSite.subtitle')} context={<Link className="btn ms-auto px-2 py-1 text-xs" to="/sites" data-testid="ns-back">{t('newSite.back')}</Link>} />
      <form className="card mb-6 space-y-4 p-4" data-testid="new-site-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <h2 className="text-lg font-bold">{editing ? t('newSite.edit_title', { code: editing.site_code }) : t('newSite.form_title')}</h2>
        {formError && <p role="alert" className="rounded-md bg-lateBg p-3 text-sm text-lateInk" data-testid="ns-form-error">{formError}</p>}
        <fieldset className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <legend className="mb-1 font-semibold">{t('newSite.identity')}</legend>
          {field('site_code', t('newSite.site_code'), { required: true })}
          {select('region_id', t('newSite.region'), (regions.data ?? []).map((r) => [String(r.id), (i18n.language === 'ar' && r.name_ar) || r.name_en]), { blank: t('newSite.choose'), required: true })}
          {errors.region && <p role="alert" className="text-sm text-lateInk sm:col-span-2" data-testid="ns-error-region">{errors.region}</p>}
          {field('name', t('newSite.name_en'), { required: true })}
          {field('name_ar', t('newSite.name_ar'), { dir: 'rtl' })}
          {field('owner_site_id', t('newSite.owner_site_id'))}
          {field('cluster_code', t('newSite.cluster'))}
          {select('site_scenario', t('newSite.site_scenario'), SITE_SCENARIOS.map((s) => [s, s]), { blank: '—' })}
          {field('site_type', t('newSite.site_type'))}
          {field('sub_region', t('newSite.sub_region'))}
          {field('latitude', t('newSite.latitude'))}
          {field('longitude', t('newSite.longitude'))}
          {field('address', t('newSite.address'))}
          {field('rf_survey_date', t('newSite.rf_survey_date'), { type: 'date' })}
        </fieldset>
        <fieldset className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <legend className="mb-1 font-semibold">{t('newSite.scope')}</legend>
          {select('delivery_scenario', t('newSite.delivery_scenario'), SCENARIOS.map((s) => [s, t(`scenario.${s}`)]), { required: true })}
          {field('project_phase', t('newSite.project_phase'))}
          {field('delivery_batch', t('newSite.delivery_batch'))}
          {field('cw_delivery_model', t('newSite.cw_delivery_model'))}
          {FLAGS.map((k) => select(k, t(`newSite.${k}`), [['Yes', t('newSite.yes')], ['No', t('newSite.no')]], { blank: '—' }))}
          {select('overall_status', t('newSite.overall_status'), [['Not Started', t('status.not_started')], ['Cancelled', t('status.cancelled')]], { blank: t('status.not_started') })}
          {/* 0.15.4 (migration 0085): Locked by default; Open needs the right to unlock when L2 approves */}
          {select('workflow_locks', t('locks.field'), [['Open', t('locks.field_open_opt')]], { blank: t('locks.field_locked') })}
          {f.workflow_locks === 'Open' && <p className="text-xs text-mute sm:col-span-2" data-testid="ns-workflow-locks-hint">{t('locks.field_hint')}</p>}
        </fieldset>
        <p className="text-sm text-mute" data-testid="ns-privacy-note">{t('newSite.privacy')}</p>
        <div className="flex flex-wrap gap-2">
          <button type="submit" className="btn btn-primary" data-testid="ns-save" disabled={busy}><FilePlus2 size={16} />{editing ? t('newSite.save') : t('newSite.create')}</button>
          {editing && <button type="button" className="btn" data-testid="ns-cancel-edit" onClick={reset}>{t('common.cancel')}</button>}
        </div>
      </form>

      <section aria-labelledby="ns-drafts-title">
        <h2 id="ns-drafts-title" className="mb-2 text-lg font-bold">{t('newSite.drafts')}</h2>
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm" data-testid="ns-drafts">
            <thead className="bg-card2 text-mute"><tr>{['code', 'name', 'region', 'status', 'note', ''].map((c) => <th key={c} className="p-2 text-start">{c ? t(`newSite.col_${c}`) : ''}</th>)}</tr></thead>
            <tbody>
              {items.map((d) => {
                const data = d.data as Record<string, unknown>;
                const may = (a: string) => (d.allowed_actions ?? []).includes(a as never);
                return (
                  <tr key={d.id} className="border-t border-line align-top" data-testid={`ns-draft-${d.site_code}`} data-status={d.status}>
                    <td className="mono p-2 font-semibold">{d.site_code}</td>
                    <td className="p-2"><div>{String(data.name ?? '')}</div>{!!data.name_ar && <div dir="rtl" lang="ar" className="text-mute" data-testid={`ns-draft-name-ar-${d.site_code}`}>{String(data.name_ar)}</div>}</td>
                    <td className="p-2">{rname(d.region_id)}</td>
                    <td className="p-2"><span className={`chip ${TONE[d.status]}`} data-testid={`ns-draft-status-${d.site_code}`}>{t(`newSite.status_${d.status}`)}</span>{d.self_approval && <span className="chip ms-1 bg-card2 text-mute">{t('newSite.self_approval')}</span>}</td>
                    <td className="p-2 text-mute">{d.last_return_note && d.status === 'entry' ? <span data-testid={`ns-draft-note-${d.site_code}`}>{d.last_return_note}</span> : '—'}</td>
                    <td className="p-2">
                      <span className="flex flex-wrap gap-1">
                        {may('edit') && <button className="btn px-2 py-0.5 text-xs" data-testid={`ns-edit-${d.site_code}`} onClick={() => { setEditing(d); setF(toForm(d)); setErrors({}); }}><Pencil size={12} />{t('newSite.edit')}</button>}
                        {may('submit') && <button className="btn btn-primary px-2 py-0.5 text-xs" data-testid={`ns-submit-${d.site_code}`} disabled={submit.isPending} onClick={() => act(submit, d, t('newSite.sent'))}><Send size={12} />{t('newSite.send')}</button>}
                        {may('discard') && <button className="btn px-2 py-0.5 text-xs" data-testid={`ns-discard-${d.site_code}`} disabled={discard.isPending} onClick={() => act(discard, d, t('newSite.discarded'))}><Trash2 size={12} />{t('newSite.discard')}</button>}
                        {may('approve') && <button className="btn btn-primary px-2 py-0.5 text-xs" data-testid={`ns-approve-${d.site_code}`} disabled={decide.isPending} onClick={() => act(decide, { draft: d, action: 'approve' }, t('newSite.approved_toast', { code: d.site_code }))}><Check size={12} />{t('newSite.approve')}</button>}
                        {may('reject') && <button className="btn btn-danger px-2 py-0.5 text-xs" data-testid={`ns-return-${d.site_code}`} onClick={() => setReturning(d)}><Undo2 size={12} />{t('newSite.return')}</button>}
                        {d.site_id && <Link className="btn px-2 py-0.5 text-xs" data-testid={`ns-open-${d.site_code}`} to={`/sites/${d.site_id}`}>{t('newSite.open_site')}</Link>}
                        {d.batch_id && <Link className="btn px-2 py-0.5 text-xs" data-testid={`ns-batch-${d.site_code}`} to={`/templates/batches/${d.batch_id}`}>{t('newSite.open_batch')}</Link>}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {drafts.isSuccess && !items.length && <p className="p-4 text-center text-mute" data-testid="ns-empty">{t('newSite.empty')}</p>}
        </div>
      </section>
      <RejectDialog open={!!returning} title={t('newSite.return_title')} onClose={() => setReturning(null)}
        onSend={(note) => { const d = returning; setReturning(null); if (d) act(decide, { draft: d, action: 'reject', note }, t('newSite.returned')); }} />
    </div>
  );
}
