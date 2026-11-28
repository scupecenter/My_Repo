import { useQuery } from '@tanstack/react-query';
import { useDownloadGate } from '@/lib/downloadGate';
import * as Dialog from '@radix-ui/react-dialog';
import { Download, Eye, FilePlus2, Printer, Upload, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { api, downloadFile, type ApiError } from '@/api/client';
import { downloadGenerated, generatedHtml, printHtml, useArchiveRows, useGenerateDocument, useLibraryForms, usePreviewForm, type LibraryForm, type LibraryGeneratedDocument } from '@/api/library';
import { PageHeader } from '@/components/PageHeader';
import { SavedViews } from '@/components/SavedViews';
import { EmptyState, QueryFallback } from '@/components/States';
import { SearchBox, TableCount } from '@/components/TableStandard';
import { useToast } from '@/components/Toast';
import { LibraryTabs } from './LibraryTabs';

type SiteHit = { id: string; site_code: string; name: string | null };
const errText = (e: ApiError | null | undefined) => (e ? (e.problem?.errors?.map((x) => x.message).join(' ') || e.problem?.detail || e.message) : '');

/** A site of the caller's regions, picked by its Site ID (the list search of GET /sites). */
export function SitePicker({ value, onChange }: { value: SiteHit | null; onChange: (s: SiteHit | null) => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState(value?.site_code ?? '');
  const hits = useQuery({
    queryKey: ['library-site-pick', q], enabled: q.trim().length >= 2 && q !== value?.site_code,
    queryFn: () => api.get<{ items: SiteHit[] }>('/sites', { query: { q: q.trim(), limit: 8 } }).then((r) => r.items),
  });
  return (
    <div className="relative">
      <label className="block text-sm font-semibold">{t('lib.pick_site')}
        <input className="input mt-1 w-full" data-testid="lib-site-input" placeholder={t('lib.pick_site_ph')} value={q} onChange={(e) => { setQ(e.target.value); onChange(null); }} />
      </label>
      {!!hits.data?.length && !value && (
        <ul className="card absolute z-10 mt-1 max-h-56 w-full overflow-auto p-1 text-sm" role="listbox" data-testid="lib-site-hits">
          {hits.data.map((s) => (
            <li key={s.id}><button type="button" role="option" aria-selected={false} className="w-full rounded px-2 py-1 text-start hover:bg-hover" data-testid={`lib-site-hit-${s.site_code}`}
              onClick={() => { onChange(s); setQ(s.site_code); }}><b className="mono">{s.site_code}</b> {s.name}</button></li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Generate a filled document: pick the site, see the filled form (a sandboxed frame: no script runs), generate, then print, download and upload the signed copy. */
export function GenerateDialog({ form, initialSite, recordId, onClose }: { form: LibraryForm; initialSite?: SiteHit | null; recordId?: string; onClose: () => void }) {
  const gate = useDownloadGate();
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [site, setSite] = useState<SiteHit | null>(initialSite ?? null);
  const [remarks, setRemarks] = useState('');
  const [done, setDone] = useState<LibraryGeneratedDocument | null>(null);
  const preview = usePreviewForm();
  const gen = useGenerateDocument();
  const rows = useArchiveRows({ doc_code: form.doc_code, site_id: site?.id }, !!done && !!site);
  const row = rows.data?.pages[0]?.items.find((r) => r.status !== 'superseded' && r.task_code === form.trigger_task_code) ?? rows.data?.pages[0]?.items[0];
  const [uploading, setUploading] = useState(false);
  const name = (i18n.language === 'ar' && form.name_ar) || form.name_en;
  const ready = !!recordId || !!site;
  const runPreview = (s: SiteHit | null) => { if (recordId) preview.mutate({ templateId: form.id, recordId }); else if (s) preview.mutate({ templateId: form.id, siteId: s.id }); };
  // a document of a record: the site is the record's, so there is no site to pick and the filled form shows at once
  useEffect(() => { if (recordId) preview.mutate({ templateId: form.id, recordId }); }, [recordId, form.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const upload = async (file: File) => {
    if (!row?.task_id) { toast(t('lib.upload_no_slot'), 'err'); return; }
    setUploading(true);
    try {
      const f = new FormData();
      f.append('file', file);
      await api.post(`/tasks/${row.task_id}/slots/${row.slot_id}/files`, { body: f });
      toast(t('lib.uploaded'));
      void rows.refetch();
    } catch (e) { toast(errText(e as ApiError) || t('lib.upload_no_slot'), 'err'); } finally { setUploading(false); }
  };
  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-scrim/60" />
        <Dialog.Content data-testid="lib-generate-dialog" className="card fixed inset-x-0 top-[4vh] z-[70] mx-auto max-h-[92vh] w-[min(980px,96vw)] space-y-3 overflow-y-auto p-5">
          <div className="flex items-center gap-2">
            <Dialog.Title className="flex-1 text-lg font-bold">{name} <span className="mono text-sm text-mute">{form.code} v{form.version}</span></Dialog.Title>
            <Dialog.Close className="btn px-2 py-1" aria-label={t('common.close')}><X size={16} /></Dialog.Close>
          </div>
          <Dialog.Description className="text-sm text-mute">{form.doc_code} · {form.trigger_task_code}</Dialog.Description>
          <div className="grid gap-3 sm:grid-cols-2">
            {recordId ? <p className="text-sm text-mute" data-testid="lib-record-note">{t('lib.from_record')}</p>
              : <SitePicker value={site} onChange={(s) => { setSite(s); setDone(null); preview.reset(); if (s) runPreview(s); }} />}
            <label className="block text-sm font-semibold">{t('lib.remarks')}
              <input className="input mt-1 w-full" data-testid="lib-remarks" maxLength={1000} value={remarks} onChange={(e) => setRemarks(e.target.value)} disabled={!!done} />
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn" data-testid="lib-preview" disabled={!ready || preview.isPending} onClick={() => runPreview(site)}><Eye size={14} />{t('lib.preview')}</button>
            {!done && <button type="button" className="btn btn-primary" data-testid="lib-generate" disabled={!ready || gen.isPending}
              onClick={() => ready && gen.mutate({ templateId: form.id, ...(recordId ? { recordId } : { siteId: site?.id }), remarks }, { onSuccess: (d) => { setDone(d); toast(t('lib.generated', { number: d.number })); }, onError: (e) => toast(errText(e), 'err') })}>
              <FilePlus2 size={14} />{t('lib.generate')}</button>}
            {done && (<>
              <span className="chip bg-doneBg text-doneInk" data-testid="lib-generated-number">{t('lib.number')}: <b className="mono">{done.number}</b></span>
              <button type="button" className="btn" data-testid="lib-print" disabled={gate.generatedLocked} title={gate.note(gate.generatedLocked)} onClick={() => void generatedHtml(done.id, 'print').then(printHtml, (e) => toast(errText(e as ApiError), 'err'))}><Printer size={14} />{t('lib.print')}</button>
              <button type="button" className="btn" data-testid="lib-download" disabled={gate.generatedLocked} title={gate.note(gate.generatedLocked)} onClick={() => void downloadGenerated(done.id).catch((e) => toast(errText(e as ApiError), 'err'))}><Download size={14} />{t('lib.download')}</button>
              {/* the upload needs the task's document slot: it stays disabled until the archive row of the generated copy is read, so a file chosen at once is never dropped */}
              <label className={`btn ${row?.task_id && !uploading ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`} data-testid="lib-upload-signed" aria-disabled={!row?.task_id || uploading}><Upload size={14} />{t('lib.upload_signed')}
                <input type="file" className="sr-only" data-testid="lib-upload-input" accept=".pdf,.png,.jpg,.jpeg" disabled={uploading || !row?.task_id}
                  onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f); }} /></label>
              {row && <span className="chip bg-card2 text-mute" data-testid="lib-generated-status">{t(`lib.status.${row.status}`)}</span>}
            </>)}
          </div>
          {preview.isError && <p className="text-sm text-lateInk" role="alert" data-testid="lib-preview-error">{errText(preview.error)}</p>}
          {gen.isError && <p className="text-sm text-lateInk" role="alert" data-testid="lib-generate-error">{errText(gen.error)}</p>}
          {!!preview.data?.warnings.length && <p className="text-xs text-mute" data-testid="lib-warnings">{t('lib.warnings', { list: preview.data.warnings.join(', ') })}</p>}
          {preview.data && (
            // a sandbox without allow-scripts and without allow-same-origin: the filled form is shown as a document only
            <iframe title={t('lib.preview_title', { name, site: site?.site_code ?? '' })} sandbox="" srcDoc={preview.data.html} data-testid="lib-preview-frame"
              className="h-[60vh] w-full rounded border border-line bg-white" />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Library > Forms (W5): every approved form, with the document type it produces, its triggering task, numbering and version. */
export function LibraryForms() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const forms = useLibraryForms();
  const q = sp.get('q') ?? '';
  const ar = i18n.language === 'ar';
  const all = forms.data?.items ?? [];
  const needle = q.trim().toLowerCase();
  const items = all.filter((f) => !needle || [f.code, f.name_en, f.name_ar ?? '', f.doc_code, f.doc_name_en, f.trigger_task_code ?? ''].some((x) => x.toLowerCase().includes(needle)));
  const openId = sp.get('form');
  const open = all.find((f) => f.id === openId && f.kind === 'html') ?? null;
  const siteParam = sp.get('site');
  const siteCode = sp.get('site_code');
  const setParam = (kv: Record<string, string>) => setSp((p) => { const n = new URLSearchParams(p); for (const [k, v] of Object.entries(kv)) { if (v) n.set(k, v); else n.delete(k); } return n; }, { replace: true });
  return (
    <div data-testid="page-library-forms">
      <PageHeader title={t('lib.forms_title')} subtitle={t('lib.forms_sub')} settings="library_forms" context={forms.data?.can_configure ? (
        <span className="ms-auto flex flex-wrap gap-1" data-testid="lib-settings-links">
          <Link className="btn px-2 py-1 text-xs" to="/library/templates">{t('lib.link_forms')}</Link>
          <Link className="btn px-2 py-1 text-xs" to="/admin/settings/documents/types">{t('lib.link_types')}</Link>
        </span>) : undefined} />
      <LibraryTabs />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SavedViews<Record<string, unknown>> screen="library-forms" value={{ q }} empty={{ q: '' }} onApply={(v) => setParam({ q: String(v.q ?? '') })} />
        <SearchBox testid="lib-forms-search" value={q} onChange={(v) => setParam({ q: v })} placeholder={t('lib.search_forms')} />
        <span className="ms-auto"><TableCount testid="lib-forms-count" noun="items" total={all.length} filtered={items.length} active={!!needle} onClear={() => setParam({ q: '' })} /></span>
      </div>
      {!forms.data ? <QueryFallback queries={[forms]} /> : !all.length ? <EmptyState testid="lib-forms-empty" title={t('lib.no_forms')} hint={forms.data.can_configure ? t('lib.settings_note') : undefined} /> : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[960px] text-sm" data-testid="lib-forms-table">
            <thead className="bg-card2 text-mute"><tr>{['#', 'name', 'code', 'version', 'doc', 'trigger', 'numbering', 'updated', ''].map((c) => <th key={c} className="p-2 text-start">{c === '#' ? '#' : c ? t(`lib.col_${c}`) : ''}</th>)}</tr></thead>
            <tbody>
              {items.map((f, i) => (
                <tr key={`${f.kind}-${f.id}`} className="border-t border-line" data-testid={`lib-form-${f.code}`} data-kind={f.kind}>
                  <td className="mono p-2 text-mute">{i + 1}</td>
                  <td className="p-2 font-semibold">{(ar && f.name_ar) || f.name_en}<span className="chip ms-2 bg-card2 text-mute">{t(f.kind === 'html' ? 'lib.kind_html' : 'lib.kind_blank')}</span></td>
                  <td className="mono p-2">{f.code}</td>
                  <td className="p-2">{f.version ? <span className="chip bg-accentSoft text-accentText">v{f.version}</span> : ''}</td>
                  <td className="p-2"><span className="mono">{f.doc_code}</span> {(ar && f.doc_name_ar) || f.doc_name_en}</td>
                  <td className="p-2">{f.trigger_task_code ? <><span className="mono">{f.trigger_task_code}</span> {(ar && f.trigger_task_name_ar) || f.trigger_task_name_en}</> : ''}</td>
                  <td className="mono p-2 text-xs">{f.numbering_pattern ?? ''}</td>
                  <td className="p-2 text-mute">{f.updated_at ? f.updated_at.slice(0, 10) : ''}{f.owner ? ` · ${f.owner.display_name}` : ''}</td>
                  <td className="p-2">{f.kind === 'html'
                    ? <button type="button" className="btn btn-primary px-2 py-1 text-xs" data-testid={`lib-form-generate-${f.code}`} onClick={() => setParam({ form: f.id, site: '', site_code: '' })}><FilePlus2 size={14} />{t('lib.generate')}</button>
                    : <button type="button" className="btn px-2 py-1 text-xs" data-testid={`lib-form-blank-${f.code}`} onClick={() => void downloadFile(`/document-library/${f.doc_type_id}/blank-form`).catch((e) => toast(errText(e as ApiError), 'err'))}><Download size={14} />{t('lib.blank_download')}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <GenerateDialog key={open.id} form={open} initialSite={siteParam && siteCode ? { id: siteParam, site_code: siteCode, name: null } : null} onClose={() => setParam({ form: '', site: '', site_code: '' })} />}
    </div>
  );
}
