import * as Dialog from '@radix-ui/react-dialog';
import { CheckCircle2, Copy, Eye, Upload, X, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ApiError } from '@/api/client';
import { useArchive, useFormTemplates, usePreviewForm, useTemplateOps, type LibraryFormTemplate } from '@/api/library';
import { FormDialog } from '@/components/FormDialog';
import { EmptyState, QueryFallback } from '@/components/States';
import { useToast } from '@/components/Toast';
import { SitePicker } from '@/pages/library/Forms';
import { CONTEXT_GROUPS, RAW_PATHS, unknownPlaceholders } from '@/pages/library/templateContext';

const errText = (e: ApiError | null | undefined) => (e ? (e.problem?.errors?.map((x) => `${x.path}: ${x.message}`).join(' ') || e.problem?.detail || e.message) : '');
const TONE: Record<string, string> = { draft: 'bg-waitBg text-waitInk', approved: 'bg-doneBg text-doneInk', retired: 'bg-lockBg text-lockInk' };

/** "owner = site.tower_owner" lines to an object; null when a line does not read. */
export function parseBindings(text: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const m = /^([a-z][a-z0-9_]{0,40})\s*=\s*([a-z_][a-z0-9_.]{0,120})$/.exec(line);
    if (!m) return null;
    out[m[1] as string] = m[2] as string;
  }
  return out;
}


type SiteHit = { id: string; site_code: string; name: string | null };

/** Every placeholder a form can use, grouped; a click copies it in double braces. */
function ReferencePanel({ onBind }: { onBind: (path: string) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const copy = (text: string) => { void navigator.clipboard?.writeText(text).then(() => toast(t('ft.copied', { text })), () => undefined); };
  return (
    <details className="card p-4" data-testid="ft-reference">
      <summary className="cursor-pointer font-bold">{t('ft.ref_title')}</summary>
      <p className="mt-2 text-sm text-mute">{t('ft.ref_note')}</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {CONTEXT_GROUPS.map((g) => (
          <div key={g.key} data-testid={`ft-ref-${g.key}`}>
            <h3 className="text-sm font-bold">{t(`ft.ref_group.${g.key}`)}</h3>
            <ul className="mt-1 flex flex-wrap gap-1">
              {g.paths.map((p) => (
                <li key={p} className="flex items-center overflow-hidden rounded border border-line text-xs">
                  <button type="button" className="mono flex items-center gap-1 px-1.5 py-0.5 hover:bg-hover" title={t('ft.ref_copy')} onClick={() => copy(`{{${p}}}`)}><Copy size={11} aria-hidden />{p}</button>
                  <button type="button" className="border-s border-line px-1.5 py-0.5 hover:bg-hover" title={t('ft.ref_bind')} aria-label={`${t('ft.ref_bind')} ${p}`} onClick={() => onBind(p)}>+</button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="mt-3 space-y-1 text-sm">
        <p><b>{t('ft.ref_blocks')}</b></p>
        <p className="mono text-xs" dir="ltr">{'{{path}}'} · {'{{#if path}}..{{else}}..{{/if}}'} · {'{{#each list}}..{{this}}..{{/each}}'}</p>
        <p className="text-mute">{t('ft.ref_region')} <span className="mono" dir="ltr">{'{{#if site.region_is.Tripoli}}'}</span></p>
        <p className="text-mute">{t('ft.ref_raw')} <span className="mono" dir="ltr">{RAW_PATHS.map((x) => `{{{${x}}}}`).join(' ')}</span></p>
      </div>
    </details>
  );
}

/** A draft or a version in force, filled with a real site, in a sandboxed frame: what the generated document will look like, before it is approved. */
function PreviewDialog({ tpl, onClose }: { tpl: LibraryFormTemplate; onClose: () => void }) {
  const { t } = useTranslation();
  const [site, setSite] = useState<SiteHit | null>(null);
  const preview = usePreviewForm();
  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-scrim/60" />
        <Dialog.Content data-testid="ft-preview-dialog" className="card fixed inset-x-0 top-[4vh] z-[70] mx-auto max-h-[92vh] w-[min(980px,96vw)] space-y-3 overflow-y-auto p-5">
          <div className="flex items-center gap-2">
            <Dialog.Title className="flex-1 text-lg font-bold">{tpl.code} v{tpl.version}</Dialog.Title>
            <Dialog.Close className="btn px-2 py-1" aria-label={t('common.close')}><X size={16} /></Dialog.Close>
          </div>
          <Dialog.Description className="text-sm text-mute">{t('ft.preview_note')}</Dialog.Description>
          <SitePicker value={site} onChange={(s) => { setSite(s); preview.reset(); if (s) preview.mutate({ templateId: tpl.id, siteId: s.id }); }} />
          {preview.isError && <p className="text-sm text-lateInk" role="alert" data-testid="ft-preview-error">{errText(preview.error)}</p>}
          {!!preview.data?.warnings?.length && <p className="text-sm text-waitInk" data-testid="ft-preview-warn">{t('ft.preview_missing', { list: preview.data.warnings.join(', ') })}</p>}
          {preview.data && <iframe title={t('ft.preview_frame')} sandbox="" srcDoc={preview.data.html} data-testid="ft-preview-frame" className="h-[65vh] w-full rounded border border-line bg-white" />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Library > Templates and Settings > Documents > Form templates (W5, contract 0.15.70): upload a form or a new version (a draft), approve it (it replaces the version in force; a
 * step-up), retire it. System Admin or an all-regions delegate of the Document Library; the server checks the HTML against the allow-list of printable forms.
 */
export function FormTemplates() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useFormTemplates();
  const ops = useTemplateOps();
  const [f, setF] = useState({ code: '', name_en: '', name_ar: '', doc_code: '', trigger_task_code: '', numbering_pattern: '', numbering_reset: 'yearly' as 'yearly' | 'never', bindings: '' });
  const [file, setFile] = useState<File | null>(null);
  const [act, setAct] = useState<{ kind: 'approve' | 'retire'; tpl: LibraryFormTemplate } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [previewing, setPreviewing] = useState<LibraryFormTemplate | null>(null);
  const arch = useArchive();
  const docCodes = [...new Set((arch.data?.groups ?? []).flatMap((g) => g.cards.map((c) => c.doc_code)))].sort();
  const bind = parseBindings(f.bindings);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const ready = f.code && f.name_en && f.doc_code && f.trigger_task_code && f.numbering_pattern && file && bind;
  const startNew = (tpl: LibraryFormTemplate) => {
    setF({ code: tpl.code, name_en: tpl.name_en, name_ar: tpl.name_ar ?? '', doc_code: tpl.doc_code, trigger_task_code: tpl.trigger_task_code, numbering_pattern: tpl.numbering_pattern,
      numbering_reset: tpl.numbering_reset ?? 'yearly', bindings: Object.entries(tpl.bindings ?? {}).map(([k, v]) => `${k} = ${v}`).join('\n') });
    document.getElementById('ft-form')?.scrollIntoView({ behavior: 'smooth' });
  };
  const addBinding = (path: string) => {
    const name = path.split('.').slice(-1)[0]!.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    setF((x) => (x.bindings.split('\n').some((l) => l.trim().startsWith(`${name} =`)) ? x : { ...x, bindings: `${x.bindings.trim() ? `${x.bindings.trim()}\n` : ''}${name} = ${path}` }));
  };
  if (!q.data) return <QueryFallback queries={[q]} />;
  const field = (k: keyof typeof f, label: string, extra: Record<string, unknown> = {}) => (
    <label className="block text-sm font-semibold">{label}<input className="input mt-1 w-full" data-testid={`ft-${k}`} value={f[k]} onChange={(e) => set(k, e.target.value)} {...extra} /></label>
  );
  return (
    <div className="space-y-4" data-testid="settings-form-templates">
      <div><h2 className="font-bold">{t('ft.title')}</h2><p className="text-sm text-mute">{t('ft.note')}</p></div>
      {!q.data.length ? <EmptyState testid="ft-empty" title={t('ft.none')} /> : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[880px] text-sm" data-testid="ft-table">
            <thead className="bg-card2 text-mute"><tr>{['col_code', 'col_name', 'col_version', 'col_doc', 'col_trigger', 'col_numbering', 'col_updated'].map((c) => <th key={c} className="p-2 text-start">{t(`lib.${c}`)}</th>)}<th className="p-2" /></tr></thead>
            <tbody>
              {q.data.map((x) => (
                <tr key={x.id} className="border-t border-line" data-testid={`ft-row-${x.code}-v${x.version}`} data-status={x.status}>
                  <td className="mono p-2">{x.code}</td>
                  <td className="p-2">{(i18n.language === 'ar' && x.name_ar) || x.name_en}<span className="ms-1 text-xs text-mute">{t('ft.placeholders', { count: x.placeholders?.length ?? 0 })}</span>
                    {unknownPlaceholders(x.placeholders, x.bindings).length > 0 && <span className="chip ms-1 bg-waitBg text-waitInk" data-testid={`ft-unknown-${x.code}-v${x.version}`} title={unknownPlaceholders(x.placeholders, x.bindings).join(', ')}>{t('ft.unknown', { list: unknownPlaceholders(x.placeholders, x.bindings).slice(0, 3).join(', ') })}</span>}</td>
                  <td className="p-2">v{x.version} <span className={`chip ${TONE[x.status] ?? ''}`}>{t(`ft.status.${x.status}`)}</span></td>
                  <td className="mono p-2">{x.doc_code}</td>
                  <td className="mono p-2">{x.trigger_task_code}</td>
                  <td className="mono p-2 text-xs">{x.numbering_pattern}</td>
                  <td className="p-2 text-mute">{String(x.updated_at).slice(0, 10)}</td>
                  <td className="p-2"><span className="flex flex-wrap gap-1">
                    {x.status !== 'retired' && <button type="button" className="btn px-2 py-1 text-xs" data-testid={`ft-preview-${x.code}-v${x.version}`} onClick={() => setPreviewing(x)}><Eye size={14} />{t('ft.preview')}</button>}
                    {x.status === 'draft' && <button type="button" className="btn btn-primary px-2 py-1 text-xs" data-testid={`ft-approve-${x.code}-v${x.version}`} onClick={() => setAct({ kind: 'approve', tpl: x })}><CheckCircle2 size={14} />{t('ft.approve')}</button>}
                    {x.status !== 'retired' && <button type="button" className="btn px-2 py-1 text-xs" data-testid={`ft-retire-${x.code}-v${x.version}`} onClick={() => setAct({ kind: 'retire', tpl: x })}><XCircle size={14} />{t('ft.retire')}</button>}
                    <button type="button" className="btn px-2 py-1 text-xs" data-testid={`ft-newversion-${x.code}-v${x.version}`} onClick={() => startNew(x)}>{t('ft.new_version', { code: x.code })}</button>
                  </span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ReferencePanel onBind={addBinding} />
      <form id="ft-form" className="card grid gap-3 p-4 sm:grid-cols-2" data-testid="ft-form" onSubmit={(e) => e.preventDefault()}>
        {field('code', t('ft.code'), { maxLength: 41, placeholder: 'SSR' })}
        {field('doc_code', t('ft.doc_code'), { maxLength: 40, list: 'ft-doc-codes' })}
        <datalist id="ft-doc-codes">{docCodes.map((c) => <option key={c} value={c} />)}</datalist>
        {field('name_en', t('ft.name_en'), { maxLength: 200 })}
        {field('name_ar', t('ft.name_ar'), { maxLength: 200, dir: 'rtl' })}
        {field('trigger_task_code', t('ft.trigger'), { maxLength: 40 })}
        <label className="block text-sm font-semibold">{t('ft.pattern')}<input className="input mono mt-1 w-full" data-testid="ft-numbering_pattern" value={f.numbering_pattern} placeholder="SSR-{YYYY}-{SEQ:4}" onChange={(e) => set('numbering_pattern', e.target.value)} />
          <span className="text-xs font-normal text-mute">{t('ft.pattern_hint')}</span></label>
        <label className="block text-sm font-semibold">{t('ft.reset')}
          <select className="input mt-1 w-full" data-testid="ft-reset" value={f.numbering_reset} onChange={(e) => set('numbering_reset', e.target.value)}>
            <option value="yearly">{t('ft.reset_yearly')}</option><option value="never">{t('ft.reset_never')}</option>
          </select></label>
        <label className="block text-sm font-semibold">{t('ft.file')}<input type="file" className="mt-1 block text-sm" accept=".html,.htm,text/html" data-testid="ft-file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
        <label className="block text-sm font-semibold sm:col-span-2">{t('ft.bindings')}
          <textarea className="input mono mt-1 w-full" rows={3} data-testid="ft-bindings" value={f.bindings} onChange={(e) => set('bindings', e.target.value)} />
          <span className="text-xs font-normal text-mute">{bind ? t('ft.bindings_hint') : t('ft.bindings_invalid')}</span></label>
        <div className="sm:col-span-2"><button type="button" className="btn btn-primary" data-testid="ft-upload" disabled={!ready || uploading} onClick={() => setUploading(true)}><Upload size={14} />{t('ft.upload')}</button></div>
      </form>
      {previewing && <PreviewDialog tpl={previewing} onClose={() => setPreviewing(null)} />}
      <FormDialog open={uploading} onClose={() => setUploading(false)} title={t('ft.upload')} testid="ft-upload-dialog" busy={ops.upload.isPending} error={ops.upload.isError ? errText(ops.upload.error) : null}
        onSubmit={(reason) => file && bind && ops.upload.mutate({ ...f, bindings: bind, reason, file }, { onSuccess: () => { setUploading(false); setFile(null); toast(t('ft.uploaded')); } })} />
      <FormDialog open={!!act} onClose={() => setAct(null)} title={act ? `${t(`ft.${act.kind}`)} ${act.tpl.code} v${act.tpl.version}` : ''} testid="ft-action-dialog"
        busy={ops.approve.isPending || ops.retire.isPending} error={(act?.kind === 'approve' ? ops.approve : ops.retire).isError ? errText((act?.kind === 'approve' ? ops.approve : ops.retire).error) : null}
        onSubmit={(reason) => act && (act.kind === 'approve' ? ops.approve : ops.retire).mutate({ id: act.tpl.id, reason }, { onSuccess: () => { toast(t(act.kind === 'approve' ? 'ft.approved' : 'ft.retired')); setAct(null); } })} />
    </div>
  );
}
