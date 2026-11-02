import { History, Pencil, Plus, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import {
  downloadDocument, useBlankForm, useCreateDoc, useLibrary, useLibraryItem, useLibraryVersions, usePublishDoc, useSaveDoc, type DocumentType, type DocumentTypeInput,
} from '@/api/documents';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { fieldErrors } from '@/lib/fields';
import { tripoliToday } from '@/lib/today';

const KINDS = ['scanned_document', 'photo', 'email', 'report', 'excel_template', 'generated_form'] as const;
const FORM_KINDS = ['dn', 'rn', 'pac', 'fac', 'snag_list'] as const;
const PHOTO_FORMATS = ['JPG', 'PNG', 'HEIC'] as const;

interface Draft {
  code: string; kind: (typeof KINDS)[number]; form_kind: string; name_en: string; name_ar: string; placements: { target: 'task' | 'qc' | 'register'; ref: string }[];
  mandatory: boolean; rule: string; formats: string; max_size_mb: string; min_files: string; max_files: string; expiry: boolean; active: boolean;
  photo_min: string; photo_formats: string[]; camera_only: boolean;
}

const blank = (): Draft => ({ code: '', kind: 'scanned_document', form_kind: '', name_en: '', name_ar: '', placements: [{ target: 'task', ref: '' }], mandatory: true, rule: '', formats: 'pdf, jpg, jpeg, png', max_size_mb: '20', min_files: '1', max_files: '', expiry: false, active: true, photo_min: '', photo_formats: [], camera_only: false });
const fromDoc = (d: DocumentType): Draft => ({
  code: d.code, kind: (d.kind ?? 'scanned_document') as Draft['kind'], form_kind: d.form_kind ?? '', name_en: d.name_en ?? '', name_ar: d.name_ar ?? '', placements: (d.placements ?? []).map((p) => ({ target: p.target, ref: p.ref })),
  mandatory: d.mandatory ?? true, rule: d.condition_rule ? JSON.stringify(d.condition_rule) : '', formats: (d.formats ?? []).join(', '), max_size_mb: String(d.max_size_mb ?? 20), min_files: String(d.min_files ?? 1),
  max_files: d.max_files == null ? '' : String(d.max_files), expiry: !!d.expiry_tracked, active: d.is_active ?? true,
  photo_min: d.photo_rules?.min_count == null ? '' : String(d.photo_rules.min_count), photo_formats: d.photo_rules?.formats ?? [], camera_only: !!(d.photo_rules as { camera_only?: boolean } | null)?.camera_only,
});

/** The body the contract wants, or the field that is wrong. */
function toBody(d: Draft): { ok: true; body: Omit<DocumentTypeInput, 'reason' | 'code'> } | { ok: false; path: string } {
  let rule: Record<string, unknown> | null = null;
  if (d.rule.trim()) { try { const r = JSON.parse(d.rule) as unknown; if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, path: '/condition_rule' }; rule = r as Record<string, unknown>; } catch { return { ok: false, path: '/condition_rule' }; } }
  const formats = d.formats.split(/[\s,;]+/).map((x) => x.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
  const max = Number(d.max_size_mb), min = Number(d.min_files), maxF = d.max_files.trim() === '' ? null : Number(d.max_files);
  if (!Number.isInteger(max) || max < 1 || max > 200) return { ok: false, path: '/max_size_mb' };
  if (!Number.isInteger(min) || min < 0) return { ok: false, path: '/min_files' };
  if (maxF !== null && (!Number.isInteger(maxF) || maxF < Math.max(1, min))) return { ok: false, path: '/max_files' };
  const placements = d.placements.filter((p) => p.ref.trim()).map((p) => ({ target: p.target, ref: p.ref.trim() }));
  if (placements.length === 0) return { ok: false, path: '/placements' };
  const photo = d.kind === 'photo' ? { ...(d.photo_min.trim() ? { min_count: Number(d.photo_min) } : {}), ...(d.photo_formats.length ? { formats: d.photo_formats as ('JPG' | 'PNG' | 'HEIC')[] } : {}), ...(d.camera_only ? { camera_only: true } : {}) } : null;
  return {
    ok: true,
    body: {
      kind: d.kind, name_en: d.name_en.trim(), name_ar: d.name_ar.trim() || null, placements, mandatory: d.mandatory, condition_rule: rule as never, formats, max_size_mb: max, min_files: min, max_files: maxF,
      photo_rules: photo && Object.keys(photo).length ? (photo as never) : null, expiry_tracked: d.expiry, is_active: d.active, form_kind: d.kind === 'generated_form' ? (d.form_kind as never) : null,
    },
  };
}

function DocForm({ d, setD, create, errs }: { d: Draft; setD: (x: Draft) => void; create: boolean; errs: Record<string, string> }) {
  const { t } = useTranslation();
  const err = (p: string) => (errs[p] ? <span role="alert" className="block text-xs text-lateInk" data-testid={`doc-err${p.replace(/\//g, '-')}`}>{t(`docs.lib.err.${errs[p]}`, { defaultValue: errs[p] })}</span> : null);
  const up = <K extends keyof Draft>(k: K, v: Draft[K]) => setD({ ...d, [k]: v });
  return (
    <div className="grid gap-3 sm:grid-cols-2" data-testid="doc-form">
      <label className="text-sm font-semibold">{t('docs.lib.code')}<input className="input mt-1 font-normal" data-testid="doc-code" disabled={!create} value={d.code} onChange={(e) => up('code', e.target.value.toUpperCase())} />{err('/code')}</label>
      <label className="text-sm font-semibold">{t('docs.lib.kind')}
        <select className="input mt-1 font-normal" data-testid="doc-kind" value={d.kind} onChange={(e) => up('kind', e.target.value as Draft['kind'])}>{KINDS.map((k) => <option key={k} value={k}>{t(`docs.kind.${k}`)}</option>)}</select>{err('/kind')}</label>
      {d.kind === 'generated_form' && (
        <label className="text-sm font-semibold">{t('docs.lib.form_kind')}
          <select className="input mt-1 font-normal" data-testid="doc-form-kind" value={d.form_kind} onChange={(e) => up('form_kind', e.target.value)}><option value="">—</option>{FORM_KINDS.map((k) => <option key={k} value={k}>{k.toUpperCase()}</option>)}</select>{err('/form_kind')}</label>
      )}
      <label className="text-sm font-semibold">{t('docs.lib.name_en')}<input className="input mt-1 font-normal" data-testid="doc-name-en" value={d.name_en} onChange={(e) => up('name_en', e.target.value)} />{err('/name_en')}</label>
      <label className="text-sm font-semibold">{t('docs.lib.name_ar')}<input className="input mt-1 font-normal" dir="rtl" data-testid="doc-name-ar" value={d.name_ar} onChange={(e) => up('name_ar', e.target.value)} /></label>
      <fieldset className="sm:col-span-2">
        <legend className="text-sm font-semibold">{t('docs.lib.placements')}</legend>
        {d.placements.map((p, i) => (
          <div key={i} className="mt-1 flex gap-2">
            <select className="input w-32" aria-label={t('docs.lib.target')} data-testid={`doc-placement-target-${i}`} value={p.target} onChange={(e) => up('placements', d.placements.map((x, j) => (j === i ? { ...x, target: e.target.value as 'task' | 'qc' | 'register' } : x)))}>
              {(['task', 'qc', 'register'] as const).map((k) => <option key={k} value={k}>{t(`docs.lib.target_${k}`)}</option>)}</select>
            <input className="input flex-1" aria-label={t('docs.lib.ref')} placeholder={t('docs.lib.ref_hint')} data-testid={`doc-placement-ref-${i}`} value={p.ref} onChange={(e) => up('placements', d.placements.map((x, j) => (j === i ? { ...x, ref: e.target.value } : x)))} />
            <button type="button" className="btn px-2" aria-label={t('common.remove')} disabled={d.placements.length === 1} onClick={() => up('placements', d.placements.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}
        <button type="button" className="btn mt-1 text-sm" data-testid="doc-placement-add" onClick={() => up('placements', [...d.placements, { target: 'task', ref: '' }])}><Plus size={12} />{t('docs.lib.add_placement')}</button>
        {err('/placements')}{Object.keys(errs).filter((k) => k.startsWith('/placements/')).map((k) => <span key={k}>{err(k)}</span>)}
      </fieldset>
      <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" data-testid="doc-mandatory" checked={d.mandatory} onChange={(e) => up('mandatory', e.target.checked)} />{t('docs.lib.mandatory')}</label>
      <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" data-testid="doc-active" checked={d.active} onChange={(e) => up('active', e.target.checked)} />{t('docs.lib.active')}</label>
      <label className="text-sm font-semibold sm:col-span-2">{t('docs.lib.rule')}<textarea className="input mono mt-1 min-h-14 font-normal" dir="ltr" data-testid="doc-rule" value={d.rule} placeholder='{"is_yes": "site.custom.near_airport"}' onChange={(e) => up('rule', e.target.value)} />
        <span className="text-xs font-normal text-mute">{t('docs.lib.rule_help')}</span>{err('/condition_rule')}</label>
      <label className="text-sm font-semibold">{t('docs.lib.formats')}<input className="input mt-1 font-normal" dir="ltr" data-testid="doc-formats" value={d.formats} onChange={(e) => up('formats', e.target.value)} />{err('/formats')}</label>
      <label className="text-sm font-semibold">{t('docs.lib.max_size')}<input type="number" className="input mt-1 font-normal" data-testid="doc-max-size" value={d.max_size_mb} onChange={(e) => up('max_size_mb', e.target.value)} />{err('/max_size_mb')}</label>
      <label className="text-sm font-semibold">{t('docs.lib.min_files')}<input type="number" className="input mt-1 font-normal" data-testid="doc-min-files" value={d.min_files} onChange={(e) => up('min_files', e.target.value)} />{err('/min_files')}</label>
      <label className="text-sm font-semibold">{t('docs.lib.max_files')}<input type="number" className="input mt-1 font-normal" data-testid="doc-max-files" value={d.max_files} placeholder={t('docs.lib.unlimited')} onChange={(e) => up('max_files', e.target.value)} />{err('/max_files')}</label>
      <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" data-testid="doc-expiry" checked={d.expiry} onChange={(e) => up('expiry', e.target.checked)} />{t('docs.lib.expiry')}</label>
      {d.kind === 'photo' && (
        <fieldset className="sm:col-span-2 rounded-md border border-line p-2" data-testid="doc-photo-rules">
          <legend className="px-1 text-sm font-semibold">{t('docs.lib.photo_rules')}</legend>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <label>{t('docs.lib.photo_min')}<input type="number" className="input ms-2 w-20" data-testid="doc-photo-min" value={d.photo_min} onChange={(e) => up('photo_min', e.target.value)} /></label>
            {PHOTO_FORMATS.map((f) => <label key={f} className="flex items-center gap-1"><input type="checkbox" data-testid={`doc-photo-fmt-${f}`} checked={d.photo_formats.includes(f)} onChange={(e) => up('photo_formats', e.target.checked ? [...d.photo_formats, f] : d.photo_formats.filter((x) => x !== f))} />{f}</label>)}
            <label className="flex items-center gap-1"><input type="checkbox" data-testid="doc-camera-only" checked={d.camera_only} onChange={(e) => up('camera_only', e.target.checked)} />{t('docs.lib.camera_only')}</label>
          </div>
        </fieldset>
      )}
    </div>
  );
}

function Edit({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const item = useLibraryItem(id);
  const create = useCreateDoc(), save = useSaveDoc(), blankForm = useBlankForm();
  const [d, setD] = useState<Draft | null>(id ? null : blank());
  const [local, setLocal] = useState<Record<string, string>>({});
  const file = useRef<HTMLInputElement>(null);
  if (id && !item.data) return null;
  const cur = d ?? (item.data ? fromDoc(item.data.doc) : blank());
  const err = save.error ?? create.error ?? blankForm.error;
  const errs = { ...local, ...fieldErrors(err) };
  const submit = (reason: string) => {
    const r = toBody(cur);
    if (!r.ok) { setLocal({ [r.path]: 'invalid' }); return; }
    setLocal({});
    if (!id) create.mutate({ code: cur.code, ...r.body, reason } as DocumentTypeInput, { onSuccess: () => { toast(t('settings.audited')); onClose(); } });
    else save.mutate({ id, version: item.data!.etag, patch: { ...r.body, reason } as never }, { onSuccess: () => { toast(t('settings.audited')); onClose(); } });
  };
  return (
    <FormDialog open onClose={onClose} testid="doc-dialog" title={id ? t('docs.lib.edit', { code: cur.code }) : t('docs.lib.new')} wide busy={save.isPending || create.isPending}
      error={err ? errText(err, t) : null} disabled={!cur.name_en.trim() || (!id && !cur.code)} onSubmit={submit}>
      <p className="text-sm text-mute">{t('docs.lib.draft_note')}</p>
      <DocForm d={cur} setD={setD} create={!id} errs={errs} />
      {id && (
        <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="doc-blank">
          <b>{t('docs.lib.blank_form')}</b>
          {item.data?.doc.blank_form_file_id ? <button type="button" className="text-link hover:underline" data-testid="doc-blank-download" onClick={() => void downloadDocument(item.data!.doc.blank_form_file_id as string)}>{t('docs.lib.blank_download')}</button> : <span className="text-mute">{t('docs.lib.blank_none')}</span>}
          <button type="button" className="btn ms-auto text-sm" data-testid="doc-blank-upload" disabled={blankForm.isPending} onClick={() => file.current?.click()}><Upload size={12} />{t('docs.lib.blank_upload')}</button>
          <input ref={file} type="file" className="sr-only" data-testid="doc-blank-input" accept=".pdf,.png,.jpg,.jpeg,.docx,.xlsx"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) blankForm.mutate({ id, version: item.data!.etag, file: f, reason: t('docs.lib.blank_reason') }, { onSuccess: () => toast(t('settings.audited')), onError: () => toast(t('docs.lib.blank_failed'), 'err') }); }} />
        </div>
      )}
    </FormDialog>
  );
}

function Publish({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const item = useLibraryItem(id), pub = usePublishDoc();
  const [apply, setApply] = useState<'new_only' | 'open_too'>('new_only');
  const [from, setFrom] = useState(tripoliToday());
  if (!item.data) return null;
  const d = item.data.doc;
  return (
    <FormDialog open onClose={onClose} testid="doc-publish-dialog" title={t('docs.lib.publish_title', { code: d.code })} busy={pub.isPending} error={pub.isError ? errText(pub.error, t) : null}
      submitLabel={t('docs.lib.publish')} onSubmit={(reason) => pub.mutate({ id, version: item.data!.etag, reason, effective_from: from, apply_to: apply }, { onSuccess: (r) => { toast(t('docs.lib.published', { version: r.published_version, count: r.affected_open_tasks })); onClose(); } })}>
      <p className="text-sm text-mute">{t('docs.lib.publish_help')}</p>
      <fieldset className="space-y-1 text-sm">
        <label className="flex items-start gap-2"><input type="radio" name="apply" data-testid="doc-apply-new" checked={apply === 'new_only'} onChange={() => setApply('new_only')} /><span><b>{t('docs.lib.apply_new')}</b><br /><span className="text-mute">{t('docs.lib.apply_new_help')}</span></span></label>
        <label className="flex items-start gap-2"><input type="radio" name="apply" data-testid="doc-apply-open" checked={apply === 'open_too'} onChange={() => setApply('open_too')} /><span><b>{t('docs.lib.apply_open')}</b><br /><span className="text-mute" data-testid="doc-open-count">{t('docs.lib.apply_open_help', { count: d.open_task_count ?? 0 })}</span></span></label>
      </fieldset>
      <label className="text-sm font-semibold">{t('docs.lib.effective')}<input type="date" className="input mt-1 font-normal" data-testid="doc-effective" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
    </FormDialog>
  );
}

function Versions({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const v = useLibraryVersions(id);
  return (
    <FormDialog open onClose={onClose} testid="doc-versions-dialog" title={t('docs.lib.versions')} withReason={false} submitLabel={t('common.close')} onSubmit={onClose}>
      <ol className="space-y-2 text-sm" data-testid="doc-versions">
        {v.data?.map((x) => (
          <li key={x.version_no} className="rounded-md border border-line p-2">
            <b>v{x.version_no}</b> · {x.published_at.slice(0, 10)} · {x.published_by?.display_name} · <span className="chip bg-card2">{t(x.apply_to === 'open_too' ? 'docs.lib.apply_open' : 'docs.lib.apply_new')}</span>
            {x.apply_to === 'open_too' && <span className="ms-2 text-mute">{t('docs.lib.reached', { count: x.affected_open_tasks ?? 0 })}</span>}
            <p className="text-mute">{x.reason}</p>
          </li>
        ))}
        {v.isSuccess && !v.data.length && <li className="text-mute">{t('docs.lib.no_versions')}</li>}
      </ol>
    </FormDialog>
  );
}

/** Settings → Document Library (CLAUDE.md "Document Library (admin)"): every document defined as data, saved as a draft, published with its scope. */
export function DocumentLibrary() {
  const { t, i18n } = useTranslation();
  const [f, setF] = useState({ kind: '', placement_ref: '', include_inactive: false });
  const q = useLibrary({ ...(f.kind ? { kind: f.kind } : {}), ...(f.placement_ref.trim() ? { placement_ref: f.placement_ref.trim() } : {}), include_inactive: f.include_inactive });
  const [dlg, setDlg] = useState<{ kind: 'edit' | 'new' | 'publish' | 'versions'; id: string | null } | null>(null);
  const rows = q.data ?? [];
  return (
    <section className="card space-y-3 p-4" data-testid="page-document-library">
      <div className="flex flex-wrap items-end gap-2">
        <h2 className="me-auto font-bold">{t('docs.lib.title')}</h2>
        <label className="text-sm">{t('docs.f_kind')}<select className="input mt-1" data-testid="lib-filter-kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="">{t('common.all')}</option>{KINDS.map((k) => <option key={k} value={k}>{t(`docs.kind.${k}`)}</option>)}</select></label>
        <label className="text-sm">{t('docs.lib.placement_filter')}<input className="input mt-1 w-32" data-testid="lib-filter-ref" value={f.placement_ref} onChange={(e) => setF({ ...f, placement_ref: e.target.value })} placeholder="B7" /></label>
        <label className="flex items-center gap-1 text-sm"><input type="checkbox" data-testid="lib-filter-inactive" checked={f.include_inactive} onChange={(e) => setF({ ...f, include_inactive: e.target.checked })} />{t('docs.lib.show_inactive')}</label>
        <button className="btn btn-accent" data-testid="lib-new" onClick={() => setDlg({ kind: 'new', id: null })}><Plus size={14} />{t('docs.lib.new')}</button>
      </div>
      {q.isError && <p role="alert" className="text-lateInk" data-testid="lib-error">{q.error instanceof ApiError && q.error.status === 403 ? t('errors.forbidden') : t('errors.generic')}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="lib-table">
          <thead><tr className="text-mute"><th className="p-2 text-start" scope="col">{t('docs.lib.code')}</th><th className="p-2 text-start" scope="col">{t('docs.lib.name')}</th><th className="p-2 text-start" scope="col">{t('docs.lib.kind')}</th>
            <th className="p-2 text-start" scope="col">{t('docs.lib.placements')}</th><th className="p-2 text-start" scope="col">{t('docs.lib.rules')}</th><th className="p-2 text-start" scope="col">{t('docs.lib.state')}</th><th className="p-2" scope="col"><span className="sr-only">{t('docs.lib.actions')}</span></th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-line align-top" data-testid={`lib-row-${r.code}`} data-active={r.is_active}>
                <td className="mono p-2">{r.code}</td>
                <td className="p-2">{(i18n.language === 'ar' && r.name_ar) || r.name_en}</td>
                <td className="p-2">{t(`docs.kind.${r.kind ?? 'scanned_document'}`)}{r.form_kind ? ` (${r.form_kind.toUpperCase()})` : ''}</td>
                <td className="mono p-2 text-xs">{(r.placements ?? []).map((p) => p.ref).join(', ')}</td>
                <td className="p-2 text-xs">{r.mandatory ? (r.condition_rule ? t('docs.conditional') : t('drawer.mandatory')) : t('docs.lib.optional')} · {(r.formats ?? []).join('/')} · {r.max_size_mb} MB · {r.min_files}–{r.max_files ?? '∞'}</td>
                <td className="space-x-1 p-2 rtl:space-x-reverse">
                  <span className="chip bg-card2" data-testid={`lib-version-${r.code}`}>{r.published_version ? `v${r.published_version}` : t('docs.lib.unpublished')}</span>
                  {r.has_unpublished_changes && <span className="chip bg-waitBg text-waitInk" data-testid={`lib-draft-${r.code}`}>{t('docs.lib.draft')}</span>}
                  {r.needs_review && <span className="chip bg-openBg text-openInk" data-testid={`lib-review-${r.code}`}>{t('docs.lib.to_review')}</span>}
                  {!r.is_active && <span className="chip bg-lockBg text-lockInk">{t('docs.lib.inactive')}</span>}
                </td>
                <td className="whitespace-nowrap p-2 text-end">
                  <button className="btn px-2 py-1 text-xs" data-testid={`lib-edit-${r.code}`} onClick={() => setDlg({ kind: 'edit', id: r.id })}><Pencil size={12} />{t('common.edit')}</button>{' '}
                  <button className="btn px-2 py-1 text-xs" data-testid={`lib-publish-${r.code}`} disabled={!r.has_unpublished_changes} onClick={() => setDlg({ kind: 'publish', id: r.id })}>{t('docs.lib.publish')}</button>{' '}
                  <button className="btn px-2 py-1 text-xs" aria-label={t('docs.lib.versions')} data-testid={`lib-versions-${r.code}`} onClick={() => setDlg({ kind: 'versions', id: r.id })}><History size={12} /></button>
                </td>
              </tr>
            ))}
            {q.isSuccess && !rows.length && <tr><td colSpan={7} className="p-4 text-mute">{t('docs.lib.empty')}</td></tr>}
          </tbody>
        </table>
      </div>
      {dlg && (dlg.kind === 'edit' || dlg.kind === 'new') && <Edit key={dlg.id ?? 'new'} id={dlg.id} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'publish' && dlg.id && <Publish id={dlg.id} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'versions' && dlg.id && <Versions id={dlg.id} onClose={() => setDlg(null)} />}
    </section>
  );
}
