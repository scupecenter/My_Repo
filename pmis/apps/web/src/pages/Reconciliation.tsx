import * as Dialog from '@radix-ui/react-dialog';
import { FileDown, FileSpreadsheet, FileUp, Play } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { ApiError } from '@/api/client';
import type { ImportBatch } from '@/api/types';
import {
  downloadOriginal, exportDiffs, useApplyRun, useMasterDiffs, useMasterRun, useMasterRuns, useResolveDiff, useUploadLegacyMaster,
  type DiffFilters, type MasterImportDiff, type MasterImportRun, type MasterImportRunProgress,
} from '@/api/masterImport';
import { useHistoricalOffer } from '@/api/historicalWaiver';
import { BatchProgress } from '@/components/BatchProgress';
import { HistoricalLoadOption, historicalReady, NO_HISTORICAL, type HistoricalChoice } from '@/components/HistoricalLoadOption';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/States';
import { useToast } from '@/components/Toast';
import { registerErrorMessage } from '@/lib/registerErrors';

const KINDS = ['diff', 'missing_in_pmis', 'missing_in_master', 'exception'];
const RESOLUTIONS = ['open', 'pmis_correct', 'master_correct', 'fixed', 'ignored'];
const KIND_TONE: Record<string, string> = { diff: 'bg-waitBg text-waitInk', missing_in_pmis: 'bg-lateBg text-lateInk', missing_in_master: 'bg-openBg text-openInk', exception: 'bg-lateBg text-lateInk' };
const num = (o: Record<string, unknown> | undefined, k: string): number => Number((o ?? {})[k] ?? 0);

/**
 * Q1 and Q211 (contract 0.12.8): the admin-only legacy import of the real Site Master and the comparison report of the parallel run. The upload is identified
 * and compared by the server; nothing changes until an admin applies the run (reason and step-up), and then every task goes through the normal batch flow.
 */
export function ReconciliationPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const runId = sp.get('run') ?? undefined;
  const runs = useMasterRuns();
  const upload = useUploadLegacyMaster();
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<{ text: string; detail?: string; reason?: string } | null>(null);
  const open = (id: string) => setSp((p) => { const n = new URLSearchParams(p); n.set('run', id); return n; }, { replace: true });
  const send = () => {
    if (!file) return;
    setError(null);
    upload.mutate(file, {
      onSuccess: (r) => { setFile(null); toast(t('mi.uploaded')); open(r.id); },
      onError: (e) => setError({ text: registerErrorMessage(t, e), detail: e instanceof ApiError ? e.problem.detail : undefined, reason: e instanceof ApiError ? String(e.problem.reason ?? '') : undefined }),
    });
  };
  const forbidden = runs.error instanceof ApiError && runs.error.status === 403;

  return (
    <div data-testid="page-reconciliation">
      <PageHeader title={t('mi.title')} subtitle={t('mi.subtitle')} />
      {forbidden ? <EmptyState testid="mi-forbidden" title={t('mi.forbidden')} /> : (
        <>
          <section className="card mb-4 space-y-2 p-4" aria-labelledby="mi-up">
            <h2 id="mi-up" className="text-lg font-bold">{t('mi.upload_title')}</h2>
            <ul className="list-disc space-y-1 ps-5 text-sm text-mute">
              <li>{t('mi.rule_identify')}</li>
              <li>{t('mi.rule_nothing')}</li>
              <li>{t('mi.rule_kept')}</li>
              <li>{t('mi.rule_pmis_files')}</li>
            </ul>
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <label htmlFor="mi-file" className="text-sm font-semibold">{t('mi.file')}</label>
                <input id="mi-file" type="file" accept=".xlsx" data-testid="mi-file" className="input mt-1" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null); }} />
              </div>
              <button className="btn btn-primary" data-testid="mi-upload" disabled={!file || upload.isPending} onClick={send}><FileUp size={16} />{t('mi.upload')}</button>
            </div>
            {error && (
              <div role="alert" data-testid="mi-upload-error" data-reason={error.reason ?? ''} className="rounded-md bg-lateBg p-3 text-sm text-lateInk">
                <p className="font-semibold">{t(`mi.reject_${error.reason}`, { defaultValue: error.text })}</p>
                {error.detail && <p className="mt-1" data-testid="mi-upload-detail">{error.detail}</p>}
                <p className="mt-1 text-xs">{t('tpl.rejection_logged')}</p>
              </div>
            )}
          </section>

          <section className="mb-4" aria-labelledby="mi-runs">
            <h2 id="mi-runs" className="mb-2 text-lg font-bold">{t('mi.runs')}</h2>
            <div className="card overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm" data-testid="mi-runs-table">
                <thead className="bg-card2 text-mute"><tr>{['file', 'hash', 'status', 'rows', 'diffs', 'exceptions', 'uploaded'].map((c) => <th key={c} className="p-2 text-start">{t(`mi.col_${c}`)}</th>)}</tr></thead>
                <tbody>
                  {(runs.data?.items ?? []).map((r) => (
                    <tr key={r.id} data-testid={`mi-run-${r.id}`} data-status={r.status} tabIndex={0} className={`cursor-pointer border-t border-line hover:bg-hover ${r.id === runId ? 'bg-accentSoft' : ''}`}
                      onClick={() => open(r.id)} onKeyDown={(e) => { if (e.key === 'Enter') open(r.id); }}>
                      <td className="p-2 font-semibold">{r.file_name}</td>
                      <td className="mono p-2 text-mute">{r.file_sha256.slice(0, 12)}</td>
                      <td className="p-2"><span className={`chip ${r.status === 'applied' ? 'bg-doneBg text-doneInk' : 'bg-waitBg text-waitInk'}`}>{t(`mi.status_${r.status}`)}</span></td>
                      <td className="p-2">{num(r.summary, 'rows')}</td>
                      <td className="p-2">{num(r.summary, 'diffs')}</td>
                      <td className="p-2">{num(r.summary, 'exceptions')}</td>
                      <td className="p-2 text-mute">{r.created_by?.display_name ?? '—'} · {r.created_at.slice(0, 10)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {runs.isLoading && <LoadingSkeleton />}
              {runs.isSuccess && !runs.data.items.length && <EmptyState testid="mi-no-runs" title={t('mi.no_runs')} />}
              {runs.isError && !forbidden && <ErrorState onRetry={() => void runs.refetch()} />}
            </div>
          </section>
          {runId && <RunDetail id={runId} />}
        </>
      )}
    </div>
  );
}

/**
 * 0.14.6: the staged batches of a big apply are sent in the background. While they run, the same bar as a batch page (BatchProgress, phase processing) shows the
 * rows done and the tasks submitted; the page reads the run again every 3 s. When they end, one line says what was sent and what failed.
 */
function RunProgress({ p }: { p: MasterImportRunProgress }) {
  const { t } = useTranslation();
  if (p.state === 'running') {
    const batch = {
      id: 'mi-run', template_id: 'TPL-MASTER', template_version: 0, version: 0, status: 'processing', stream: 'master', counts: {},
      progress: { job_id: 'mi-run', kind: 'submit', batch_kind: 'stream', action: null, state: 'running', rows_total: p.rows_total, rows_done: p.rows_done, percent: p.percent,
        submitted: p.submitted ?? 0, approved: p.approved ?? 0, failed: p.failed ?? 0 },
    } as unknown as ImportBatch;
    return (
      <div data-testid="mi-run-progress" data-state={p.state}>
        <BatchProgress batch={batch} />
        <p className="text-xs text-mute" data-testid="mi-run-progress-batches">{t('mi.progress_batches', { running: p.batches_running ?? 0, total: p.batches })}</p>
      </div>
    );
  }
  return (
    <p className={`card p-3 text-sm ${p.state === 'failed' || (p.failed ?? 0) > 0 ? 'text-lateInk' : ''}`} role="status" data-testid="mi-run-progress" data-state={p.state}>
      {p.state === 'failed' ? t('mi.progress_failed', { done: p.rows_done, total: p.rows_total }) : t('mi.progress_done', { submitted: p.submitted ?? 0, saved: p.saved ?? 0, failed: p.failed ?? 0, total: p.rows_total })}
    </p>
  );
}

function RunDetail({ id }: { id: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const run = useMasterRun(id);
  const [f, setF] = useState<DiffFilters>({ kind: '', reason: '', resolution: '', site_code: '' });
  const diffs = useMasterDiffs(id, f);
  const [applying, setApplying] = useState(false);
  const [resolving, setResolving] = useState<MasterImportDiff | null>(null);
  if (run.isLoading) return <LoadingSkeleton />;
  if (!run.data) return <ErrorState onRetry={() => void run.refetch()} />;
  const r = run.data;
  const s = r.structure as Record<string, unknown>;
  const moved = (s.moved as unknown[] | undefined) ?? [];
  const missing = (s.missing as { header: string }[] | undefined) ?? [];
  const sheetsMissing = (s.register_sheets_missing as string[] | undefined) ?? [];
  const down = (p: Promise<string>) => p.then((n) => toast(t('grid.downloaded', { name: n })), (e) => toast(registerErrorMessage(t, e), 'err'));
  return (
    <section className="space-y-3" aria-labelledby="mi-run-title" data-testid="mi-run-detail">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="mi-run-title" className="text-lg font-bold">{r.file_name}</h2>
        <span className="mono text-xs text-mute" data-testid="mi-run-sha">{r.file_sha256}</span>
        <span className="ms-auto flex flex-wrap gap-1">
          <button className="btn px-2 py-1 text-xs" data-testid="mi-export" onClick={() => void down(exportDiffs(r.id, f))}><FileSpreadsheet size={14} />{t('mi.export')}</button>
          {r.has_file && <button className="btn px-2 py-1 text-xs" data-testid="mi-original" onClick={() => void down(downloadOriginal(r.id))}><FileDown size={14} />{t('mi.original')}</button>}
          {r.status === 'previewed' && <button className="btn btn-primary px-2 py-1 text-xs" data-testid="mi-apply" onClick={() => setApplying(true)}><Play size={14} />{t('mi.apply')}</button>}
        </span>
      </div>
      <div className="card grid gap-2 p-3 text-sm sm:grid-cols-2" data-testid="mi-structure">
        <p data-testid="mi-identified">{s.identified ? t('mi.identified', { found: Number(s.columns_found), expected: Number(s.columns_expected) }) : t('mi.not_identified')}</p>
        <p>{t('mi.summary', { rows: num(r.summary, 'rows'), sites: num(r.summary, 'sites_matched'), unknown: num(r.summary, 'sites_unknown'), matches: num(r.summary, 'matches'), compared: num(r.summary, 'cells_compared') })}</p>
        {moved.length > 0 && <p data-testid="mi-moved">{t('mi.moved', { count: moved.length })}</p>}
        {missing.length > 0 && <p data-testid="mi-missing">{t('mi.missing', { list: missing.slice(0, 5).map((m) => m.header).join(', ') })}</p>}
        {sheetsMissing.length > 0 && <p className="text-mute">{t('mi.sheets_missing', { list: sheetsMissing.join(', ') })}</p>}
        <p className="text-mute">{t('mi.staff', { mapped: num(r.summary, 'staff_mapped'), rows: num(r.summary, 'staff_rows') })}</p>
        {r.status === 'applied' && <p data-testid="mi-applied" className="font-semibold">{t('mi.applied', { mode: t(`mi.mode_${r.apply_mode}`), reason: r.apply_reason ?? '' })}</p>}
      </div>
      {r.progress && <RunProgress p={r.progress} />}

      <div role="toolbar" className="flex flex-wrap items-center gap-2">
        <select className="input w-auto" aria-label={t('mi.col_kind')} data-testid="mi-filter-kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
          <option value="">{t('mi.all_kinds')}</option>
          {KINDS.map((k) => <option key={k} value={k}>{t(`mi.kind_${k}`)}</option>)}
        </select>
        <select className="input w-auto" aria-label={t('mi.col_resolution')} data-testid="mi-filter-resolution" value={f.resolution} onChange={(e) => setF({ ...f, resolution: e.target.value })}>
          <option value="">{t('mi.all_resolutions')}</option>
          {RESOLUTIONS.map((k) => <option key={k} value={k}>{t(`mi.res_${k}`)}</option>)}
        </select>
        <input className="input w-40" aria-label={t('mi.col_site')} placeholder={t('mi.col_site')} data-testid="mi-filter-site" value={f.site_code} onChange={(e) => setF({ ...f, site_code: e.target.value })} />
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[960px] text-sm" data-testid="mi-diffs-table">
          <thead className="bg-card2 text-mute"><tr>{['site', 'source', 'column', 'field', 'master', 'pmis', 'kind', 'reason', 'resolution', ''].map((c) => <th key={c} className="p-2 text-start">{c ? t(`mi.col_${c}`) : ''}</th>)}</tr></thead>
          <tbody>
            {(diffs.data?.items ?? []).map((d) => (
              <tr key={d.id} className="border-t border-line" data-testid={`mi-diff-${d.id}`} data-kind={d.kind} data-reason={d.reason}>
                <td className="mono p-2">{d.site_code ?? '—'}</td>
                <td className="mono p-2 text-mute">{d.source_ref ?? '—'}</td>
                <td className="mono p-2">{d.master_col ?? '—'}</td>
                <td className="p-2">{d.header ?? d.field ?? '—'}</td>
                <td className="p-2">{d.master_value ?? '—'}</td>
                <td className="p-2">{d.pmis_value ?? '—'}</td>
                <td className="p-2"><span className={`chip ${KIND_TONE[d.kind] ?? ''}`}>{t(`mi.kind_${d.kind}`)}</span></td>
                <td className="p-2 text-mute">{t(`mi.reason_${d.reason}`, { defaultValue: d.reason })}</td>
                <td className="p-2">{t(`mi.res_${d.resolution}`)}{d.resolution_note && <span className="block text-xs text-mute">{d.resolution_note}</span>}</td>
                <td className="p-2"><button className="btn px-2 py-1 text-xs" data-testid={`mi-resolve-${d.id}`} onClick={() => setResolving(d)}>{t('mi.resolve')}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {diffs.isLoading && <LoadingSkeleton />}
        {diffs.isSuccess && !diffs.data.items.length && <EmptyState testid="mi-no-diffs" title={t('mi.no_diffs')} />}
      </div>
      {applying && <ApplyDialog run={r} onClose={() => setApplying(false)} />}
      {resolving && <ResolveDialog diff={resolving} onClose={() => setResolving(null)} />}
    </section>
  );
}

function ApplyDialog({ run, onClose }: { run: MasterImportRun; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const apply = useApplyRun();
  const [mode, setMode] = useState<'submit' | 'draft'>('submit');
  const [reason, setReason] = useState('');
  // Q462 (0.14.3): "historical load: accept without documents", for a System Admin while the waiver is open; a draft has no document check
  const offer = useHistoricalOffer(mode === 'submit');
  const [hist, setHist] = useState<HistoricalChoice>(NO_HISTORICAL);
  const [err, setErr] = useState<string | null>(null);
  const go = () => apply.mutate({ run, mode, reason, ...(offer && hist.on ? { historical_load: { reason: hist.reason.trim() } } : {}) }, {
    onSuccess: (r) => { toast(r.progress?.state === 'running' ? t('mi.applied_processing') : t('mi.applied_toast', { count: r.outcome?.batches?.length ?? 0 })); onClose(); },
    onError: (e) => setErr(e.problem.detail ?? registerErrorMessage(t, e)),
  });
  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-scrim/60" />
        <Dialog.Content data-testid="mi-apply-dialog" className="card fixed inset-x-0 top-[12vh] z-[70] mx-auto w-[min(520px,94vw)] space-y-3 p-5">
          <Dialog.Title className="text-lg font-bold">{t('mi.apply_title')}</Dialog.Title>
          <Dialog.Description className="text-sm text-mute">{t('mi.apply_hint', { count: num(run.summary, 'applicable') })}</Dialog.Description>
          <fieldset className="space-y-1 text-sm">
            <legend className="font-semibold">{t('mi.mode')}</legend>
            {(['submit', 'draft'] as const).map((m) => (
              <label key={m} className="flex items-center gap-2"><input type="radio" name="mi-mode" value={m} data-testid={`mi-mode-${m}`} checked={mode === m} onChange={() => setMode(m)} />{t(`mi.mode_${m}`)}</label>
            ))}
          </fieldset>
          {offer && <HistoricalLoadOption waiver={offer} value={hist} onChange={setHist} testid="hl" />}
          <div>
            <label htmlFor="mi-reason" className="text-sm font-semibold">{t('mi.reason')}</label>
            <textarea id="mi-reason" className="input mt-1 w-full" data-testid="mi-apply-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          {err && <p role="alert" className="text-sm text-lateInk" data-testid="mi-apply-error">{err}</p>}
          <div className="flex justify-end gap-2">
            <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
            <button className="btn btn-primary" data-testid="mi-apply-confirm" disabled={reason.trim().length < 3 || apply.isPending || (!!offer && !historicalReady(hist))} onClick={go}>{t('mi.apply')}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ResolveDialog({ diff, onClose }: { diff: MasterImportDiff; onClose: () => void }) {
  const { t } = useTranslation();
  const resolve = useResolveDiff();
  const [resolution, setResolution] = useState<string>(diff.resolution === 'open' ? 'pmis_correct' : diff.resolution);
  const [note, setNote] = useState(diff.resolution_note ?? '');
  const [err, setErr] = useState<string | null>(null);
  const needsNote = resolution !== 'open';
  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-scrim/60" />
        <Dialog.Content data-testid="mi-resolve-dialog" className="card fixed inset-x-0 top-[12vh] z-[70] mx-auto w-[min(480px,94vw)] space-y-3 p-5">
          <Dialog.Title className="text-lg font-bold">{t('mi.resolve_title', { site: diff.site_code ?? '', column: diff.master_col ?? '' })}</Dialog.Title>
          <Dialog.Description className="text-sm text-mute">{t('mi.resolve_hint')}</Dialog.Description>
          <select className="input w-full" aria-label={t('mi.col_resolution')} data-testid="mi-resolution" value={resolution} onChange={(e) => setResolution(e.target.value)}>
            {RESOLUTIONS.map((k) => <option key={k} value={k}>{t(`mi.res_${k}`)}</option>)}
          </select>
          <textarea className="input w-full" aria-label={t('mi.note')} placeholder={t('mi.note')} data-testid="mi-resolve-note" value={note} onChange={(e) => setNote(e.target.value)} />
          {err && <p role="alert" className="text-sm text-lateInk">{err}</p>}
          <div className="flex justify-end gap-2">
            <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
            <button className="btn btn-primary" data-testid="mi-resolve-save" disabled={(needsNote && note.trim().length < 3) || resolve.isPending}
              onClick={() => resolve.mutate({ id: diff.id, resolution, note: note.trim() || undefined }, { onSuccess: onClose, onError: (e) => setErr(e.problem.detail ?? registerErrorMessage(t, e)) })}>{t('common.save')}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
