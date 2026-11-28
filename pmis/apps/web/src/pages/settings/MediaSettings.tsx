import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useMediaSettings, useSetMediaSettings, type MediaSettings } from '@/api/media';
import { errText, FormDialog } from '@/components/FormDialog';
import { QueryFallback } from '@/components/States';
import { UnsavedGuard } from '@/lib/unsavedGuard';
import { useToast } from '@/components/Toast';

const KINDS = ['photo', 'scanned_document', 'email', 'report', 'excel_template'] as const;
type Draft = Pick<MediaSettings, 'enabled' | 'snag_photos' | 'document_kinds' | 'register_keys' | 'include_site_documents' | 'exclude_doc_codes' | 'image_only' | 'show_withdrawn' | 'page_size' | 'export_max_mb' | 'thumbnails'>;
const list = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

/** Settings > Documents > Media (GAL-1): what the gallery reads and how its thumbnails are made. Audited, with a reason, a step-up and If-Match. */
export function MediaSettingsScreen() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useMediaSettings(), set = useSetMediaSettings();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [regs, setRegs] = useState<string | null>(null);
  const [excl, setExcl] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  if (!q.data) return <QueryFallback queries={[q]} testid="media-settings-loading" />;
  const cur = q.data;
  const base: Draft = { enabled: cur.enabled, snag_photos: cur.snag_photos, document_kinds: cur.document_kinds, register_keys: cur.register_keys, include_site_documents: cur.include_site_documents, exclude_doc_codes: cur.exclude_doc_codes, image_only: cur.image_only, show_withdrawn: cur.show_withdrawn, page_size: cur.page_size, export_max_mb: cur.export_max_mb, thumbnails: cur.thumbnails };
  const v: Draft = { ...(draft ?? base), register_keys: regs !== null ? list(regs) : (draft ?? base).register_keys, exclude_doc_codes: excl !== null ? list(excl) : (draft ?? base).exclude_doc_codes };
  const dirty = JSON.stringify(v) !== JSON.stringify(base);
  const ro = !cur.can_edit;
  const patch = (p: Partial<Draft>) => setDraft({ ...v, ...p });
  const th = (p: Partial<Draft['thumbnails']>) => patch({ thumbnails: { ...v.thumbnails, ...p } });
  const bool = (id: string, label: string, note: string, val: boolean, on: (b: boolean) => void) => (
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" data-testid={id} checked={val} disabled={ro} onChange={(e) => on(e.target.checked)} />
      <span><span className="font-semibold">{label}</span><span className="block text-xs text-mute">{note}</span></span></label>);
  const num = (id: string, label: string, val: number, on: (n: number) => void, min: number, max: number) => (
    <label className="block text-xs font-semibold text-mute">{label}<input type="number" min={min} max={max} className="input mt-1 w-full" data-testid={id} value={val} disabled={ro} onChange={(e) => on(Number(e.target.value))} /></label>);
  return (
    <section className="card space-y-4 p-4" data-testid="page-media-settings">
      <div><h2 className="font-bold">{t('mediaSet.title')}</h2><p className="text-sm text-mute">{t('mediaSet.note')}</p></div>
      {bool('ms-enabled', t('mediaSet.enabled'), t('mediaSet.enabled_note'), v.enabled, (b) => patch({ enabled: b }))}
      {bool('ms-snags', t('mediaSet.snags'), t('mediaSet.snags_note'), v.snag_photos, (b) => patch({ snag_photos: b }))}
      <fieldset><legend className="mb-1 text-sm font-semibold">{t('mediaSet.kinds')}</legend>
        <div className="flex flex-wrap gap-2">{KINDS.map((k) => (
          <label key={k} className="chip cursor-pointer gap-1 border border-line bg-card"><input type="checkbox" data-testid={`ms-kind-${k}`} disabled={ro} checked={v.document_kinds.includes(k)}
            onChange={(e) => patch({ document_kinds: e.target.checked ? [...v.document_kinds, k] : v.document_kinds.filter((x) => x !== k) })} />{t(`mediaSet.kind_${k}`)}</label>))}</div>
        <p className="mt-1 text-xs text-mute">{t('mediaSet.kinds_note')}</p>
        <p className="mt-1 text-xs"><Link className="text-accentText underline" to="/admin/settings/documents/types" data-testid="ms-types-link">{t('mediaSet.types_link')}</Link></p>
      </fieldset>
      {bool('ms-image-only', t('mediaSet.image_only'), t('mediaSet.image_only_note'), v.image_only, (b) => patch({ image_only: b }))}
      {bool('ms-site-docs', t('mediaSet.site_docs'), t('mediaSet.site_docs_note'), v.include_site_documents, (b) => patch({ include_site_documents: b }))}
      {bool('ms-withdrawn', t('mediaSet.withdrawn'), t('mediaSet.withdrawn_note'), v.show_withdrawn, (b) => patch({ show_withdrawn: b }))}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-semibold text-mute">{t('mediaSet.registers')}<input dir="ltr" className="input mt-1 w-full" data-testid="ms-registers" disabled={ro} value={regs ?? v.register_keys.join(', ')} onChange={(e) => setRegs(e.target.value)} /><span className="font-normal">{t('mediaSet.registers_note')}</span></label>
        <label className="block text-xs font-semibold text-mute">{t('mediaSet.exclude')}<input dir="ltr" className="input mt-1 w-full" data-testid="ms-exclude" disabled={ro} value={excl ?? v.exclude_doc_codes.join(', ')} onChange={(e) => setExcl(e.target.value)} /><span className="font-normal">{t('mediaSet.exclude_note')}</span></label>
      </div>
      {num('ms-page-size', t('mediaSet.page_size'), v.page_size, (n) => patch({ page_size: n }), 12, 200)}
      <div>{num('ms-export-max', t('mediaSet.export_max'), v.export_max_mb, (n) => patch({ export_max_mb: n }), 10, 5000)}<p className="mt-1 text-xs text-mute">{t('mediaSet.export_max_note')}</p></div>
      <fieldset className="space-y-3"><legend className="mb-1 text-sm font-semibold">{t('mediaSet.thumbs')}</legend>
        {bool('ms-th-enabled', t('mediaSet.th_enabled'), cur.thumbnails_available ? t('mediaSet.th_enabled_note') : t('mediaSet.th_unavailable'), v.thumbnails.enabled, (b) => th({ enabled: b }))}
        <div className="grid gap-3 sm:grid-cols-4">
          {num('ms-th-small', t('mediaSet.th_small'), v.thumbnails.small_px, (n) => th({ small_px: n }), 64, 1024)}
          {num('ms-th-medium', t('mediaSet.th_medium'), v.thumbnails.medium_px, (n) => th({ medium_px: n }), 128, 2048)}
          {num('ms-th-quality', t('mediaSet.th_quality'), v.thumbnails.quality, (n) => th({ quality: n }), 30, 95)}
          {num('ms-th-max', t('mediaSet.th_max'), v.thumbnails.max_source_mb, (n) => th({ max_source_mb: n }), 1, 100)}
        </div>
        <div className="flex gap-2" role="radiogroup" aria-label={t('mediaSet.th_format')}>{(['webp', 'jpeg'] as const).map((f) => (
          <label key={f} className={`chip cursor-pointer border ${v.thumbnails.format === f ? 'border-accent bg-accentSoft text-accentText' : 'border-line bg-card text-mute'}`}>
            <input type="radio" name="ms-format" className="sr-only" data-testid={`ms-format-${f}`} checked={v.thumbnails.format === f} disabled={ro} onChange={() => th({ format: f })} />{f}</label>))}</div>
      </fieldset>
      {!ro && <UnsavedGuard scope="settings" dirty={dirty} needsReason label={t('ui.guard_settings')}
        onSave={(reason) => new Promise<boolean>((res) => set.mutate({ version: cur.version, ...v, reason }, { onSuccess: () => { setDraft(null); setRegs(null); setExcl(null); res(true); }, onError: () => res(false) }))} />}
      {ro ? <p className="text-sm text-mute" data-testid="ms-readonly">{t('mediaSet.readonly')}</p>
        : <button className="btn btn-accent" data-testid="ms-save" disabled={!dirty} onClick={() => setOpen(true)}>{t('common.save')}</button>}
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="ms-dialog" title={t('mediaSet.title')} busy={set.isPending} error={set.isError ? errText(set.error, t) : null}
          onSubmit={(reason) => set.mutate({ version: cur.version, ...v, reason }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setDraft(null); setRegs(null); setExcl(null); } })}>
          <p className="text-sm text-mute">{t('mediaSet.confirm')}</p>
        </FormDialog>
      )}
    </section>
  );
}
