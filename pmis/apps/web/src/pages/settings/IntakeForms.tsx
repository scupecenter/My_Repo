import { Copy, KeyRound, ListChecks, Pencil, Plus, Power, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useIntakeForms, useIntakeSubmissions, useCreateIntakeForm, useDeleteIntakeForm, useReplaceIntakeLink, useUpdateIntakeForm, type IntakeForm, type IntakeFormCreate } from '@/api/intake';
import { useRegisterColumns } from '@/api/registerColumns';
import { useRegisterDefs } from '@/api/registers';
import { useSites } from '@/api/sites';
import { errText, FormDialog } from '@/components/FormDialog';
import { Tip } from '@/components/Tip';
import { useToast } from '@/components/Toast';

const ASKABLE = new Set(['text', 'number', 'date', 'list', 'yes_no']);
type Dlg = { k: 'edit'; f: IntakeForm | null } | { k: 'link'; f: IntakeForm } | { k: 'switch'; f: IntakeForm } | { k: 'delete'; f: IntakeForm } | { k: 'subs'; f: IntakeForm };
const linkOf = (token: string) => `${window.location.origin}/intake/${token}`;
const fmt = (s?: string | null, lang = 'en') => (s ? new Date(s).toLocaleString(lang) : '-');

/**
 * Settings, public intake forms (contract 0.15.600): a manager makes a shareable form for one site of a register that has a triage queue; outsiders fill it without an
 * account. The records are created as the form owner and wait in the register's triage queue. The link is shown once (only its hash is stored); replacing it ends the old one.
 */
export function IntakeForms() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useIntakeForms();
  const create = useCreateIntakeForm();
  const update = useUpdateIntakeForm();
  const replace = useReplaceIntakeLink();
  const del = useDeleteIntakeForm();
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [shown, setShown] = useState<{ name: string; token: string } | null>(null);
  const items = q.data?.items ?? [];
  const locked = q.data?.sharing_locked === true;
  const close = () => { setDlg(null); setErr(null); };
  const run = async (fn: () => Promise<unknown>, ok: string) => { setErr(null); try { await fn(); toast(ok); close(); } catch (e) { setErr(errText(e, t)); } };
  const lang = i18n.language;
  const regName = (f: IntakeForm) => (lang.startsWith('ar') && f.register_name_ar ? f.register_name_ar : f.register_name_en ?? f.register_key);
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); toast(t('intake.copied')); } catch { toast(t('intake.copy_failed')); } };

  return (
    <section className="card space-y-4 p-4" data-testid="page-intake-forms">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-bold">{t('intake.title')}</h2>
          <p className="text-sm text-mute">{t('intake.note')}</p>
        </div>
        <Tip text={locked ? t('intake.locked_hint') : t('intake.new_hint')}>
          <button type="button" className="btn btn-accent" data-testid="intake-new" disabled={locked} aria-label={t('intake.new')} onClick={() => { setErr(null); setDlg({ k: 'edit', f: null }); }}>
            <Plus size={14} aria-hidden /> {t('intake.new')}
          </button>
        </Tip>
      </div>
      {locked && <p className="rounded border border-line p-2 text-sm" role="status" data-testid="intake-locked">{t('intake.locked')}</p>}
      {q.isLoading ? <p className="text-sm text-mute">{t('common.loading')}</p> : items.length === 0 ? (
        <p className="text-sm text-mute" data-testid="intake-empty">{t('intake.empty')}</p>
      ) : (
        <div className="overflow-x-auto"><table className="w-full text-sm" data-testid="intake-table">
          <thead><tr className="text-start text-mute">
            {['col_name', 'col_register', 'col_site', 'col_owner', 'col_status', 'col_received', 'col_actions'].map((k) => <th key={k} className="p-1 text-start">{t(`intake.${k}`)}</th>)}
          </tr></thead>
          <tbody>
            {items.map((f) => {
              const expired = !!f.expires_at && new Date(f.expires_at) < new Date();
              const st = !f.is_active ? 's_off' : expired ? 's_expired' : locked ? 's_locked' : 's_on';
              return (
                <tr key={f.id} className="border-t border-line" data-testid={`intake-row-${f.id}`}>
                  <td className="p-1 font-semibold"><bdi>{f.name}</bdi><div className="font-mono text-xs font-normal text-mute" dir="ltr">…{f.token_hint}</div></td>
                  <td className="p-1">{regName(f)}</td>
                  <td className="p-1"><bdi className="font-mono text-xs">{f.site_code}</bdi></td>
                  <td className="p-1"><bdi>{f.owner_name}</bdi></td>
                  <td className="p-1"><span className="chip" data-testid={`intake-status-${f.id}`}>{t(`intake.${st}`)}</span>{f.expires_at && <div className="text-xs text-mute">{t('intake.expires', { d: fmt(f.expires_at, lang) })}</div>}</td>
                  <td className="p-1">{t('intake.received', { n: f.submissions_total, d: f.submissions_24h })}<div className="text-xs text-mute">{fmt(f.last_submission_at, lang)}</div></td>
                  <td className="flex flex-wrap gap-1 p-1">
                    <Tip text={t('intake.submissions_hint')}><button type="button" className="btn px-2 py-1 text-xs" aria-label={t('intake.submissions')} data-testid={`intake-subs-${f.id}`} onClick={() => setDlg({ k: 'subs', f })}><ListChecks size={12} aria-hidden /> {t('intake.submissions')}</button></Tip>
                    <Tip text={t('intake.edit_hint')}><button type="button" className="btn px-2 py-1 text-xs" aria-label={t('intake.edit')} data-testid={`intake-edit-${f.id}`} onClick={() => { setErr(null); setDlg({ k: 'edit', f }); }}><Pencil size={12} aria-hidden /> {t('intake.edit')}</button></Tip>
                    <Tip text={t('intake.link_hint')}><button type="button" className="btn px-2 py-1 text-xs" aria-label={t('intake.link')} data-testid={`intake-link-${f.id}`} disabled={locked} onClick={() => { setErr(null); setDlg({ k: 'link', f }); }}><KeyRound size={12} aria-hidden /> {t('intake.link')}</button></Tip>
                    <Tip text={f.is_active ? t('intake.off_hint') : t('intake.on_hint')}><button type="button" className="btn px-2 py-1 text-xs" aria-label={f.is_active ? t('intake.off') : t('intake.on')} data-testid={`intake-switch-${f.id}`} disabled={!f.is_active && locked} onClick={() => { setErr(null); setDlg({ k: 'switch', f }); }}><Power size={12} aria-hidden /> {f.is_active ? t('intake.off') : t('intake.on')}</button></Tip>
                    {!f.is_active && <Tip text={t('intake.delete_hint')}><button type="button" className="btn px-2 py-1 text-xs" aria-label={t('intake.delete')} data-testid={`intake-delete-${f.id}`} onClick={() => { setErr(null); setDlg({ k: 'delete', f }); }}><Trash2 size={12} aria-hidden /> {t('intake.delete')}</button></Tip>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      )}

      {dlg?.k === 'edit' && <EditDialog key={dlg.f?.id ?? 'new'} form={dlg.f} err={err} busy={create.isPending || update.isPending} onClose={close}
        onSave={(body, patch) => void run(async () => {
          if (dlg.f) await update.mutateAsync({ id: dlg.f.id, version: dlg.f.version, patch });
          else { const r = await create.mutateAsync(body); setShown({ name: r.name, token: r.token ?? '' }); }
        }, dlg.f ? t('intake.saved') : t('intake.created'))} />}

      <FormDialog open={dlg?.k === 'link'} onClose={close} title={t('intake.link')} testid="intake-dialog-link" busy={replace.isPending} error={err} withReason={false}
        onSubmit={() => dlg?.k === 'link' && void run(async () => { const r = await replace.mutateAsync({ id: dlg.f.id, version: dlg.f.version }); setShown({ name: r.name, token: r.token ?? '' }); }, t('intake.link_replaced'))}>
        <p className="text-sm">{t('intake.link_note')}</p>
      </FormDialog>
      <FormDialog open={dlg?.k === 'switch'} onClose={close} title={dlg?.k === 'switch' && !dlg.f.is_active ? t('intake.on') : t('intake.off')} testid="intake-dialog-switch" busy={update.isPending} error={err} withReason={false}
        onSubmit={() => dlg?.k === 'switch' && void run(() => update.mutateAsync({ id: dlg.f.id, version: dlg.f.version, patch: { is_active: !dlg.f.is_active } }), t('intake.saved'))}>
        <p className="text-sm">{dlg?.k === 'switch' && !dlg.f.is_active ? t('intake.on_note') : t('intake.off_note')}</p>
      </FormDialog>
      <FormDialog open={dlg?.k === 'delete'} onClose={close} title={t('intake.delete')} testid="intake-dialog-delete" busy={del.isPending} error={err} withReason={false}
        onSubmit={() => dlg?.k === 'delete' && void run(() => del.mutateAsync(dlg.f.id), t('intake.deleted'))}>
        <p className="text-sm">{t('intake.delete_note')}</p>
      </FormDialog>
      {dlg?.k === 'subs' && <Submissions form={dlg.f} onClose={close} />}

      <FormDialog open={!!shown} onClose={() => setShown(null)} title={t('intake.shown_title')} testid="intake-dialog-shown" withReason={false} submitLabel={t('intake.done')} onSubmit={() => setShown(null)}>
        {shown && <div className="space-y-2">
          <p className="text-sm">{t('intake.shown_note', { name: shown.name })}</p>
          <div className="flex items-center gap-2">
            <input className="input w-full font-mono text-xs" dir="ltr" readOnly data-testid="intake-url" value={linkOf(shown.token)} onFocus={(e) => e.currentTarget.select()} />
            <Tip text={t('intake.copy')}><button type="button" className="btn px-2 py-1" aria-label={t('intake.copy')} data-testid="intake-copy" onClick={() => void copy(linkOf(shown.token))}><Copy size={14} aria-hidden /></button></Tip>
          </div>
          <p className="text-xs text-mute">{t('intake.shown_once')}</p>
        </div>}
      </FormDialog>
    </section>
  );
}

function Submissions({ form, onClose }: { form: IntakeForm; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const q = useIntakeSubmissions(form.id);
  return (
    <FormDialog open onClose={onClose} title={t('intake.submissions_of', { name: form.name })} testid="intake-dialog-subs" withReason={false} wide submitLabel={t('intake.done')} onSubmit={onClose}>
      {q.isLoading ? <p className="text-sm text-mute">{t('common.loading')}</p> : (q.data ?? []).length === 0 ? <p className="text-sm text-mute" data-testid="intake-subs-empty">{t('intake.subs_empty')}</p> : (
        <table className="w-full text-sm" data-testid="intake-subs-table">
          <thead><tr className="text-mute">{['sub_when', 'sub_who', 'sub_contact', 'sub_triage'].map((k) => <th key={k} className="p-1 text-start">{t(`intake.${k}`)}</th>)}</tr></thead>
          <tbody>{(q.data ?? []).map((s) => (
            <tr key={s.id} className="border-t border-line">
              <td className="p-1">{fmt(s.created_at, i18n.language)}</td><td className="p-1"><bdi>{s.reporter_name ?? '-'}</bdi></td><td className="p-1"><bdi>{s.reporter_contact ?? '-'}</bdi></td>
              <td className="p-1">{s.triage_state ? <span className="chip">{t(`intake.triage_${s.triage_state}`)}</span> : s.record_id ? t('intake.no_record_state') : t('intake.record_gone')}</td>
            </tr>))}</tbody>
        </table>
      )}
    </FormDialog>
  );
}

function EditDialog({ form, err, busy, onClose, onSave }: { form: IntakeForm | null; err: string | null; busy: boolean; onClose: () => void; onSave: (create: IntakeFormCreate, patch: Record<string, unknown>) => void }) {
  const { t, i18n } = useTranslation();
  const ar = i18n.language.startsWith('ar');
  const defs = useRegisterDefs();
  const [reg, setReg] = useState(form?.register_key ?? '');
  const [siteQ, setSiteQ] = useState('');
  const [siteId, setSiteId] = useState(form?.site_id ?? '');
  const [name, setName] = useState(form?.name ?? '');
  const [codes, setCodes] = useState<string[]>(form?.field_codes ?? []);
  const [fixed, setFixed] = useState<Record<string, string>>(Object.fromEntries(Object.entries(form?.fixed ?? {}).map(([k, v]) => [k, String(v)])));
  const [introEn, setIntroEn] = useState(form?.intro_en ?? '');
  const [introAr, setIntroAr] = useState(form?.intro_ar ?? '');
  const [thanksEn, setThanksEn] = useState(form?.thanks_en ?? '');
  const [thanksAr, setThanksAr] = useState(form?.thanks_ar ?? '');
  const [expires, setExpires] = useState(form?.expires_at ? form.expires_at.slice(0, 10) : '');
  const [perHour, setPerHour] = useState(String(form?.max_per_hour ?? 20));
  const [askContact, setAskContact] = useState(form?.ask_contact ?? true);
  const regs = useMemo(() => (defs.data ?? []).filter((d) => (d as { triage_enabled?: boolean }).triage_enabled), [defs.data]);
  const cols = useRegisterColumns(reg, !!reg);
  const sites = useSites({ q: siteQ, region_id: '', scenario: '', overall_status: '', stage_code: '' }, !form);
  const askable = (cols.data?.fields ?? []).filter((f) => f.is_active && !f.derived && ASKABLE.has(String(f.type)));
  const siteRows = (sites.data?.pages ?? []).flatMap((p) => p.items).slice(0, 50);
  const toggle = (c: string) => { setCodes((p) => (p.includes(c) ? p.filter((x) => x !== c) : p.length < 20 ? [...p, c] : p)); setFixed((p) => { const n = { ...p }; delete n[c]; return n; }); };
  const fixedBody = Object.fromEntries(Object.entries(fixed).filter(([k, v]) => v.trim() !== '' && !codes.includes(k)).map(([k, v]) => [k, v.trim()]));
  const n = Number(perHour);
  const valid = name.trim().length > 0 && codes.length > 0 && Number.isInteger(n) && n >= 1 && n <= 500 && (!!form || (!!reg && !!siteId));
  const label = (f: { label_en: string; label_ar?: string | null }) => (ar && f.label_ar ? f.label_ar : f.label_en);
  const patch = { name: name.trim(), field_codes: codes, fixed: fixedBody, intro_en: introEn.trim() || null, intro_ar: introAr.trim() || null, thanks_en: thanksEn.trim() || null, thanks_ar: thanksAr.trim() || null,
    expires_at: expires ? new Date(`${expires}T23:59:59`).toISOString() : null, max_per_hour: n, ask_contact: askContact };
  return (
    <FormDialog open onClose={onClose} title={form ? t('intake.edit') : t('intake.new')} testid="intake-dialog-edit" wide busy={busy} error={err} withReason={false} disabled={!valid}
      onSubmit={() => onSave({ ...patch, register_key: reg, site_id: siteId } as IntakeFormCreate, patch)}>
      <label className="block text-sm">{t('intake.f_name')}<input className="input mt-1 w-full" data-testid="intake-f-name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></label>
      {!form && <>
        <label className="block text-sm">{t('intake.f_register')}
          <select className="input mt-1 w-full" data-testid="intake-f-register" value={reg} onChange={(e) => { setReg(e.target.value); setCodes([]); setFixed({}); }}>
            <option value="">{t('intake.choose')}</option>{regs.map((d) => <option key={d.register_key} value={d.register_key}>{ar && d.name_ar ? d.name_ar : d.name_en}</option>)}
          </select>
          <span className="text-xs text-mute">{t('intake.f_register_note')}</span>
        </label>
        <div className="text-sm">{t('intake.f_site')}
          <input className="input mt-1 w-full" data-testid="intake-f-site-q" placeholder={t('intake.f_site_search')} value={siteQ} onChange={(e) => setSiteQ(e.target.value)} />
          <select className="input mt-1 w-full" data-testid="intake-f-site" size={4} value={siteId} onChange={(e) => setSiteId(e.target.value)} aria-label={t('intake.f_site')}>
            {siteRows.map((s) => <option key={s.id} value={s.id}>{s.site_code} {s.name}</option>)}
          </select>
        </div>
      </>}
      {(reg || form) && <fieldset className="space-y-1 text-sm">
        <legend className="font-semibold">{t('intake.f_fields')}</legend>
        <p className="text-xs text-mute">{t('intake.f_fields_note')}</p>
        {cols.isLoading ? <p className="text-mute">{t('common.loading')}</p> : askable.map((f) => (
          <div key={f.code} className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2"><input type="checkbox" data-testid={`intake-ask-${f.code}`} checked={codes.includes(f.code)} onChange={() => toggle(f.code)} /> <bdi>{label(f)}</bdi>{f.required && <span className="chip text-xs">{t('intake.required')}</span>}</label>
            {!codes.includes(f.code) && <input className="input w-44 text-xs" data-testid={`intake-fix-${f.code}`} placeholder={f.type === 'date' ? t('intake.preset_date') : t('intake.preset')} aria-label={t('intake.preset_for', { f: label(f) })} value={fixed[f.code] ?? ''} onChange={(e) => setFixed((p) => ({ ...p, [f.code]: e.target.value }))} />}
          </div>
        ))}
        <p className="text-xs text-mute">{t('intake.f_preset_note')}</p>
      </fieldset>}
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-sm">{t('intake.f_intro_en')}<textarea className="input mt-1 w-full" rows={2} maxLength={600} value={introEn} onChange={(e) => setIntroEn(e.target.value)} /></label>
        <label className="block text-sm">{t('intake.f_intro_ar')}<textarea className="input mt-1 w-full" dir="rtl" rows={2} maxLength={600} value={introAr} onChange={(e) => setIntroAr(e.target.value)} /></label>
        <label className="block text-sm">{t('intake.f_thanks_en')}<input className="input mt-1 w-full" maxLength={300} value={thanksEn} onChange={(e) => setThanksEn(e.target.value)} /></label>
        <label className="block text-sm">{t('intake.f_thanks_ar')}<input className="input mt-1 w-full" dir="rtl" maxLength={300} value={thanksAr} onChange={(e) => setThanksAr(e.target.value)} /></label>
        <label className="block text-sm">{t('intake.f_expires')}<input className="input mt-1 w-full" type="date" data-testid="intake-f-expires" value={expires} onChange={(e) => setExpires(e.target.value)} /></label>
        <label className="block text-sm">{t('intake.f_per_hour')}<input className="input mt-1 w-full" type="number" min={1} max={500} data-testid="intake-f-per-hour" value={perHour} onChange={(e) => setPerHour(e.target.value)} /></label>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="intake-f-contact" checked={askContact} onChange={(e) => setAskContact(e.target.checked)} /> {t('intake.f_ask_contact')}</label>
      {!form && <p className="text-xs text-mute">{t('intake.f_owner_note')}</p>}
    </FormDialog>
  );
}
