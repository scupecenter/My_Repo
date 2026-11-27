import { FileDown, FileSpreadsheet, FileUp } from 'lucide-react';
import { useDownloadGate } from '@/lib/downloadGate';
import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMe } from '@/api/hooks';
import { isAdmin } from '@/lib/perm';
import { downloadTemplate, useBatches, useTemplates } from '@/api/registers';
import { batchPath, type ImportBatch, type Template } from '@/api/types';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/States';
import { WhatChangedButton } from '@/components/TemplateChanges';
import { TemplateUploadDialog } from '@/components/TemplateUploadDialog';
import { useToast } from '@/components/Toast';
import { registerErrorMessage } from '@/lib/registerErrors';

const STATUSES = ['validated', 'in_approval', 'partially_approved', 'approved', 'rejected', 'discarded'];
const STREAMS = ['DESIGN_ACQ', 'CW', 'TE', 'CLOSURE'];
const TONE: Record<string, string> = { validated: 'bg-waitBg text-waitInk', in_approval: 'bg-openBg text-openInk', partially_approved: 'bg-openBg text-openInk', approved: 'bg-doneBg text-doneInk', rejected: 'bg-lateBg text-lateInk', discarded: 'bg-lockBg text-lockInk' };

const dateOf = (iso?: string) => (iso ? iso.slice(0, 10) : '—');
/** The kind of a template: the whole Master, a Site Register stream template (Q73), or the template of a register (a file from before 0.11.5 has no `template_kind`). */
const kindOf = (x: Template): NonNullable<Template['template_kind']> => x.template_kind ?? (x.stream ? 'stream' : x.register_key ? 'register' : 'master');
/** 0.15.61: the list values (TPL-LISTVALUES) and the holidays (TPL-HOLIDAYS) are uploaded on their own screens (Lists, Settings > Calendar), not as an import batch. */
const ownScreen = (k: ReturnType<typeof kindOf>): k is 'list_values' | 'holidays' => k === 'list_values' || k === 'holidays';

/**
 * The Templates page (CLAUDE.md "Approved templates only"): the approved templates to download (blank or pre-filled) and upload, and the batches of the uploads.
 * The Site Register templates come first: the whole Master and one per stream (contract 0.11.5); then the template of each register.
 */
export function TemplatesPage() {
  const gate = useDownloadGate();
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const status = sp.get('status') ?? '', register = sp.get('register') ?? '', stream = sp.get('stream') ?? '';
  const templates = useTemplates();
  const batches = useBatches({ status, template_id: '', register_key: register, stream });
  const [uploadFor, setUploadFor] = useState<Template | null>(null);
  const lang = i18n.language;
  const me = useMe(true);
  const nameOf = (x: { name_en: string; name_ar?: string | null }) => (lang === 'ar' && x.name_ar) || x.name_en;
  const down = (x: Template, prefill: boolean) => downloadTemplate(x.template_id, { prefill }).then((n) => toast(t('grid.downloaded', { name: n })), (e) => toast(registerErrorMessage(t, e), 'err'));
  const set = (k: string, v: string) => setSp((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  const all = (templates.data ?? []).filter((x) => x.register_key || x.stream || x.template_kind);
  // Grouping: the Master (and the new-sites, list and holiday files), then the sections (streams), then the registers and logs
  const groupOf = (x: Template): 'master' | 'sections' | 'registers' => (kindOf(x) === 'register' ? 'registers' : kindOf(x) === 'stream' ? 'sections' : 'master');
  const GROUPS = ['master', 'sections', 'registers'] as const;
  const entries = GROUPS.flatMap((g) => all.filter((x) => groupOf(x) === g));
  const registers = all.filter((x) => kindOf(x) === 'register');
  const items: ImportBatch[] = batches.data?.items ?? [];
  const tplName = (id: string) => { const x = templates.data?.find((y) => y.template_id === id); return x ? nameOf(x) : id; };

  return (
    <div data-testid="page-templates">
      <PageHeader title={t('tpl.title')} subtitle={t('tpl.subtitle')} settings="templates" context={
        <span className="ms-auto flex flex-wrap gap-1">
          <Link className="btn px-2 py-1 text-xs" to="/templates/mapping" data-testid="tpl-mapping-link">{t('tmap.title')}</Link>
          {isAdmin(me.data) && <Link className="btn px-2 py-1 text-xs" to="/templates/master-import" data-testid="tpl-master-import-link">{t('mi.title')}</Link>}
        </span>} />
      <section aria-labelledby="tpl-cat" className="mb-6">
        <h2 id="tpl-cat" className="mb-2 text-lg font-bold">{t('tpl.catalogue')}</h2>
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm" data-testid="tpl-table">
            <thead className="bg-card2 text-mute"><tr>{['name', 'id', 'version', 'issued', ''].map((c) => <th key={c} className="p-2 text-start">{c ? t(`tpl.col_${c}`) : ''}</th>)}</tr></thead>
            <tbody>
              {entries.map((x, i) => {
                const kind = kindOf(x);
                const g = groupOf(x);
                return (
                  <Fragment key={x.template_id}>
                  {(i === 0 || groupOf(entries[i - 1]) !== g) && <tr className="bg-card2" data-testid={`tpl-group-${g}`}><th colSpan={5} scope="colgroup" className="p-2 text-start text-xs font-bold uppercase text-mute">{t(`tpl.group_${g}`)}</th></tr>}
                  <tr className="border-t border-line" data-testid={`tpl-row-${x.template_id}`} data-register={x.register_key ?? ''} data-kind={kind} data-stream={x.stream ?? ''}>
                    <td className="p-2 font-semibold">
                      {nameOf(x)}
                      {kind !== 'register' && <span className="chip ms-2 bg-card2 text-mute" data-testid={`tpl-kind-${x.template_id}`}>{kind === 'master' ? t('tpl.kind_master') : kind === 'sites' ? t('tpl.kind_sites') : kind === 'holidays' ? t('tpl.kind_holidays') : kind === 'list_values' ? t('tpl.kind_list_values') : t('tpl.kind_stream')}</span>}
                    </td>
                    <td className="mono p-2">{x.template_id}</td>
                    <td className="p-2"><span className="chip bg-accentSoft text-accentText" data-testid={`tpl-version-${x.template_id}`}>v{x.current_version}</span></td>
                    <td className="p-2 text-mute">{dateOf(x.issued_at)}</td>
                    <td className="p-2">
                      <span className="flex flex-wrap gap-1">
                        {kind === 'register' && <WhatChangedButton templateId={x.template_id} version={x.current_version} />}
                        <button className="btn px-2 py-1 text-xs" data-testid={`tpl-download-${x.template_id}`} disabled={gate.templatesLocked} title={gate.note(gate.templatesLocked)} onClick={() => void down(x, false)}><FileDown size={14} />{t('registers.template_download')}</button>
                        {!ownScreen(kind) && <button className="btn px-2 py-1 text-xs" data-testid={`tpl-prefill-${x.template_id}`} disabled={gate.templatesLocked} title={gate.note(gate.templatesLocked)} onClick={() => void down(x, true)}><FileSpreadsheet size={14} />{t('registers.template_prefill')}</button>}
                        {!ownScreen(kind) && <button className="btn px-2 py-1 text-xs" data-testid={`tpl-upload-${x.template_id}`} onClick={() => setUploadFor(x)}><FileUp size={14} />{t('registers.template_upload')}</button>}
                      </span>
                    </td>
                  </tr>
                  </Fragment>
                );
              })}
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
            {registers.map((x) => <option key={x.template_id} value={x.register_key ?? ''}>{nameOf(x)}</option>)}
          </select>
          <select className="input w-auto" aria-label={t('tpl.col_stream')} data-testid="batches-filter-stream" value={stream} onChange={(e) => set('stream', e.target.value)}>
            <option value="">{t('tpl.all_streams')}</option>
            {STREAMS.map((s) => <option key={s} value={s}>{t(`tpl.stream_${s}`)}</option>)}
          </select>
        </div>
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm" data-testid="batches-table">
            <thead className="bg-card2 text-mute"><tr>{['file', 'template', 'status', 'rows', 'uploaded'].map((c) => <th key={c} className="p-2 text-start">{t(`tpl.col_${c}`)}</th>)}</tr></thead>
            <tbody>
              {items.map((b) => (
                <tr key={b.id} className="cursor-pointer border-t border-line hover:bg-hover" data-testid={`batch-list-row-${b.id}`} data-status={b.status} data-stream={b.stream ?? ''} tabIndex={0}
                  onClick={() => nav(batchPath(b))} onKeyDown={(e) => { if (e.key === 'Enter') nav(batchPath(b)); }}>
                  <td className="p-2 font-semibold">
                    <Link to={batchPath(b)} data-testid={`batch-link-${b.id}`} onClick={(e) => e.stopPropagation()}>{b.file_name}</Link>
                    {b.part_sheet && b.group_id && <span className="chip ms-2 bg-card2 text-mute" data-testid={`batch-part-${b.id}`}>{t('tpl.part', { sheet: b.part_sheet })}</span>}
                  </td>
                  <td className="p-2">{tplName(b.template_id)} <span className="mono text-mute">v{b.template_version}</span></td>
                  <td className="p-2"><span className={`chip ${TONE[b.status] ?? 'bg-lockBg text-lockInk'}`}>{t(`batchStatus.${b.status}`, { defaultValue: b.status })}</span></td>
                  <td className="p-2 text-mute">{t('batch.diff', { create: b.counts.create ?? 0, update: b.counts.update ?? 0, unchanged: b.counts.unchanged ?? 0 })}{!!b.counts.error && ` · ${t('batch.invalid', { count: b.counts.error })}`}{!!b.counts.held && ` · ${t('batch.held_count', { count: b.counts.held })}`}{!!b.counts.saved && ` · ${t('batch.saved_count', { count: b.counts.saved })}`}{b.mode === 'draft' && <span className="chip ms-1 bg-card2 text-mute" data-testid={`batch-draft-${b.id}`}>{t('tpl.mode_draft')}</span>}</td>
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
        kind={((k) => (ownScreen(k) ? undefined : k))(kindOf(uploadFor))} onDone={(b) => { setUploadFor(null); toast(t('grid.uploaded')); nav(batchPath(b, uploadFor.register_key)); }} />}
    </div>
  );
}
