import { FileDown, FileSpreadsheet, FileUp } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { downloadTemplate, useBatches, useTemplates } from '@/api/registers';
import type { ImportBatch, Template } from '@/api/types';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/States';
import { TemplateUploadDialog } from '@/components/TemplateUploadDialog';
import { useToast } from '@/components/Toast';
import { registerErrorMessage } from '@/lib/registerErrors';

const STATUSES = ['validated', 'in_approval', 'partially_approved', 'approved', 'rejected', 'discarded'];
const TONE: Record<string, string> = { validated: 'bg-waitBg text-waitInk', in_approval: 'bg-openBg text-openInk', partially_approved: 'bg-openBg text-openInk', approved: 'bg-doneBg text-doneInk', rejected: 'bg-lateBg text-lateInk', discarded: 'bg-lockBg text-lockInk' };

const dateOf = (iso?: string) => (iso ? iso.slice(0, 10) : '—');

/** The Templates page (CLAUDE.md "Approved templates only"): the approved template of each register to download (blank or pre-filled) and upload, and the batches of the uploads. */
export function TemplatesPage() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const status = sp.get('status') ?? '', register = sp.get('register') ?? '';
  const templates = useTemplates();
  const batches = useBatches({ status, template_id: '', register_key: register });
  const [uploadFor, setUploadFor] = useState<Template | null>(null);
  const lang = i18n.language;
  const nameOf = (x: { name_en: string; name_ar?: string | null }) => (lang === 'ar' && x.name_ar) || x.name_en;
  const down = (x: Template, prefill: boolean) => downloadTemplate(x.template_id, { prefill }).then((n) => toast(t('grid.downloaded', { name: n })), (e) => toast(registerErrorMessage(t, e), 'err'));
  const set = (k: string, v: string) => setSp((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  const entries = (templates.data ?? []).filter((x) => x.register_key);
  const items: ImportBatch[] = batches.data?.items ?? [];
  const tplName = (id: string) => { const x = templates.data?.find((y) => y.template_id === id); return x ? nameOf(x) : id; };

  return (
    <div data-testid="page-templates">
      <PageHeader title={t('tpl.title')} subtitle={t('tpl.subtitle')} />
      <section aria-labelledby="tpl-cat" className="mb-6">
        <h2 id="tpl-cat" className="mb-2 text-lg font-bold">{t('tpl.catalogue')}</h2>
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm" data-testid="tpl-table">
            <thead className="bg-card2 text-mute"><tr>{['name', 'id', 'version', 'issued', ''].map((c) => <th key={c} className="p-2 text-start">{c ? t(`tpl.col_${c}`) : ''}</th>)}</tr></thead>
            <tbody>
              {entries.map((x) => (
                <tr key={x.template_id} className="border-t border-line" data-testid={`tpl-row-${x.template_id}`} data-register={x.register_key ?? ''}>
                  <td className="p-2 font-semibold">{nameOf(x)}</td>
                  <td className="mono p-2">{x.template_id}</td>
                  <td className="p-2"><span className="chip bg-accentSoft text-accentText" data-testid={`tpl-version-${x.template_id}`}>v{x.current_version}</span></td>
                  <td className="p-2 text-mute">{dateOf(x.issued_at)}</td>
                  <td className="p-2">
                    <span className="flex flex-wrap gap-1">
                      <button className="btn px-2 py-1 text-xs" data-testid={`tpl-download-${x.template_id}`} onClick={() => void down(x, false)}><FileDown size={14} />{t('registers.template_download')}</button>
                      <button className="btn px-2 py-1 text-xs" data-testid={`tpl-prefill-${x.template_id}`} onClick={() => void down(x, true)}><FileSpreadsheet size={14} />{t('registers.template_prefill')}</button>
                      <button className="btn px-2 py-1 text-xs" data-testid={`tpl-upload-${x.template_id}`} onClick={() => setUploadFor(x)}><FileUp size={14} />{t('registers.template_upload')}</button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {templates.isLoading && <LoadingSkeleton />}
          {templates.isSuccess && !entries.length && <EmptyState testid="tpl-empty" title={t('tpl.none')} />}
          {templates.isError && <ErrorState onRetry={() => void templates.refetch()} />}
        </div>
        <p className="mt-2 text-sm text-mute" data-testid="tpl-streams-note">{t('tpl.streams_note')}</p>
      </section>

      <section aria-labelledby="tpl-batches">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h2 id="tpl-batches" className="text-lg font-bold">{t('tpl.batches')}</h2>
          <select className="input ms-auto w-auto" aria-label={t('tpl.col_status')} data-testid="batches-filter-status" value={status} onChange={(e) => set('status', e.target.value)}>
            <option value="">{t('tpl.all_statuses')}</option>
            {STATUSES.map((s) => <option key={s} value={s}>{t(`batchStatus.${s}`)}</option>)}
          </select>
          <select className="input w-auto" aria-label={t('tpl.col_register')} data-testid="batches-filter-register" value={register} onChange={(e) => set('register', e.target.value)}>
            <option value="">{t('tpl.all_registers')}</option>
            {entries.map((x) => <option key={x.template_id} value={x.register_key ?? ''}>{nameOf(x)}</option>)}
          </select>
        </div>
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm" data-testid="batches-table">
            <thead className="bg-card2 text-mute"><tr>{['file', 'template', 'status', 'rows', 'uploaded'].map((c) => <th key={c} className="p-2 text-start">{t(`tpl.col_${c}`)}</th>)}</tr></thead>
            <tbody>
              {items.map((b) => (
                <tr key={b.id} className="cursor-pointer border-t border-line hover:bg-hover" data-testid={`batch-list-row-${b.id}`} data-status={b.status} tabIndex={0}
                  onClick={() => nav(`/registers/${b.register_key}/batches/${b.id}`)} onKeyDown={(e) => { if (e.key === 'Enter') nav(`/registers/${b.register_key}/batches/${b.id}`); }}>
                  <td className="p-2 font-semibold"><Link to={`/registers/${b.register_key}/batches/${b.id}`} data-testid={`batch-link-${b.id}`} onClick={(e) => e.stopPropagation()}>{b.file_name}</Link></td>
                  <td className="p-2">{tplName(b.template_id)} <span className="mono text-mute">v{b.template_version}</span></td>
                  <td className="p-2"><span className={`chip ${TONE[b.status] ?? 'bg-lockBg text-lockInk'}`}>{t(`batchStatus.${b.status}`, { defaultValue: b.status })}</span></td>
                  <td className="p-2 text-mute">{t('batch.diff', { create: b.counts.create ?? 0, update: b.counts.update ?? 0, unchanged: b.counts.unchanged ?? 0 })}{!!b.counts.error && ` · ${t('batch.invalid', { count: b.counts.error })}`}{!!b.counts.held && ` · ${t('batch.held_count', { count: b.counts.held })}`}</td>
                  <td className="p-2 text-mute">{b.uploaded_by?.display_name ?? '—'} · {dateOf(b.uploaded_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {batches.isLoading && <LoadingSkeleton />}
          {batches.isSuccess && !items.length && <EmptyState testid="batches-empty" title={t('tpl.no_batches')} />}
          {batches.isError && <ErrorState onRetry={() => void batches.refetch()} />}
        </div>
      </section>
      {uploadFor && <TemplateUploadDialog open onClose={() => setUploadFor(null)} templateId={uploadFor.template_id} templateName={`${nameOf(uploadFor)} · v${uploadFor.current_version}`}
        onDone={(b) => { setUploadFor(null); toast(t('grid.uploaded')); nav(`/registers/${b.register_key ?? uploadFor.register_key}/batches/${b.id}`); }} />}
    </div>
  );
}
