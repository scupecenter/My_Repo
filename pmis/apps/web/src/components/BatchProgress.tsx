import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { ImportBatch, Job } from '@/api/types';

/** Whole percent of `n` in `total` (0 when there is nothing). Western digits come from String(), in both languages. */
export const pct = (n: number, total: number): number => (total > 0 ? Math.round((n * 100) / total) : 0);

/** The server counts of a batch (never derived from loaded rows): valid = create + update + unchanged, invalid = error. */
export function batchTotals(c: ImportBatch['counts']) {
  const create = c.create ?? 0, update = c.update ?? 0, unchanged = c.unchanged ?? 0, error = c.error ?? 0;
  const approved = c.approved ?? 0, rejected = c.rejected ?? 0, pending = c.pending ?? 0, held = c.held ?? 0;
  return { create, update, unchanged, error, valid: create + update + unchanged, rows: create + update + unchanged + error, approved, rejected, pending, held, sent: approved + rejected + pending + held };
}

type Seg = { key: string; n: number; tone: string; label: string };

/** A bar of segments. It is a single progressbar; each segment has its own title and the legend names every segment with its count and percentage, so colour is never the only signal. It fills from the inline start (the right in Arabic). */
function Bar({ segs, total, now, label, testid }: { segs: Seg[]; total: number; now: number; label: string; testid: string }) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div data-testid={testid}>
      <p id={id} className="mb-1 text-sm font-semibold" data-testid={`${testid}-label`}>{label}</p>
      <div role="progressbar" aria-labelledby={id} aria-valuenow={now} aria-valuemin={0} aria-valuemax={100} aria-valuetext={label}
        className="flex h-3 w-full overflow-hidden rounded-full bg-card2" data-testid={`${testid}-bar`}>
        {segs.filter((s) => s.n > 0).map((s) => (
          <span key={s.key} className={s.tone} style={{ width: `${(s.n * 100) / Math.max(total, 1)}%` }} title={`${s.label}: ${s.n} (${pct(s.n, total)}%)`} data-testid={`${testid}-seg-${s.key}`} data-count={s.n} />
        ))}
      </div>
      <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label={t('batchProgress.legend')}>
        {segs.map((s) => (
          <li key={s.key} className="flex items-center gap-1" data-testid={`${testid}-legend-${s.key}`}>
            <i className={`inline-block h-2.5 w-2.5 rounded-sm ${s.tone}`} aria-hidden />
            <span>{s.label} {s.n} ({pct(s.n, total)}%)</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The progress of an import, following the batch status: parsing, checked, sent to L2, or closed without a bar. */
export function BatchProgress({ batch: b, job, site }: { batch: ImportBatch; job?: Job; site?: boolean }) {
  const { t } = useTranslation();
  const c = batchTotals(b.counts);
  const wrap = 'mb-3 rounded-md border border-line bg-card p-3';

  if (b.status === 'parsing') {
    const p = typeof job?.progress === 'number' ? Math.min(100, Math.max(0, Math.round(job.progress * 100))) : null;
    const r = (job?.result ?? {}) as Record<string, unknown>;
    const done = typeof r.rows_done === 'number' ? r.rows_done : null, total = typeof r.rows_total === 'number' ? r.rows_total : null;
    const label = p === null ? t('batchProgress.parsing_wait') : done !== null && total !== null ? t('batchProgress.parsing_rows', { pct: p, done, total }) : t('batchProgress.parsing', { pct: p });
    const id = 'batch-progress-parsing-label';
    return (
      <section className={wrap} data-testid="batch-progress" data-phase="parsing" aria-label={t('batchProgress.title')}>
        <p id={id} className="mb-1 text-sm font-semibold" data-testid="batch-progress-parsing-label">{label}</p>
        <div role="progressbar" aria-labelledby={id} aria-valuemin={0} aria-valuemax={100} {...(p === null ? {} : { 'aria-valuenow': p })} aria-valuetext={label}
          className="relative h-3 w-full overflow-hidden rounded-full bg-card2" data-testid="batch-progress-parsing-bar">
          {p === null
            ? <span className="absolute inset-y-0 start-0 w-1/3 animate-pulse rounded-full bg-open" data-testid="batch-progress-indeterminate" />
            : <span className="block h-full rounded-full bg-open transition-all" style={{ width: `${p}%` }} />}
        </div>
      </section>
    );
  }

  if (b.status === 'processing') {
    // 0.14.4: a big New sites batch is sent or approved in the background, 25 rows per chunk; the bar follows the committed chunks
    const pr = b.progress, total = pr?.rows_total ?? c.sent, doneN = pr?.rows_done ?? 0, p = pr?.percent ?? pct(doneN, total);
    const creating = !!site && (pr?.kind === 'decide' || (pr?.approved ?? 0) > 0);
    const shown = creating ? (pr?.approved ?? c.approved) : doneN;
    const label = creating ? t('batchProgress.processing_sites', { done: shown, total, pct: pct(shown, total) }) : t('batchProgress.processing', { done: doneN, total, pct: p });
    const segs: Seg[] = [
      { key: 'done', n: shown, tone: 'bg-done', label: creating ? t('batchProgress.approved') : t('batchStatus.processing') },
      ...(pr?.failed ? [{ key: 'failed', n: pr.failed, tone: 'bg-late', label: t('batchProgress.invalid') }] : []),
      { key: 'pending', n: Math.max(0, total - shown - (pr?.failed ?? 0)), tone: 'bg-wait', label: t('batchProgress.pending') },
    ];
    // 0.14.6: a register or a stream batch says what its rows became so far (records approved, tasks submitted); rounded down like the server's percent
    const kind = pr?.batch_kind ?? (b.stream ? 'stream' : b.entity === 'site' ? 'site' : 'register');
    const what = !pr || kind === 'site' ? null
      : kind === 'register'
        ? (pr.kind === 'decide' && pr.action !== 'approve' ? { key: 'batchProgress.processing_records_decided', n: pr.decided ?? 0 } : { key: 'batchProgress.processing_records', n: pr.approved ?? 0 })
        : (pr.kind === 'decide' ? { key: 'batchProgress.processing_tasks_decided', n: pr.decided ?? 0 } : { key: 'batchProgress.processing_tasks', n: pr.submitted ?? 0 });
    return (
      <section className={wrap} data-testid="batch-progress" data-phase="processing" aria-label={t('batchProgress.title')} aria-busy="true">
        <Bar segs={segs} total={total} now={creating ? pct(shown, total) : p} label={label} testid="batch-progress-processing" />
        {what && <p className="mt-2 text-sm" data-testid="batch-progress-processing-kind" data-kind={kind}>{t(what.key, { done: what.n, total, pct: total > 0 ? Math.floor((what.n * 100) / total) : 0 })}</p>}
        <p className="mt-2 text-xs text-mute" role="status" data-testid="batch-progress-processing-note">{t('batchProgress.processing_note')}</p>
      </section>
    );
  }

  if (b.status === 'validated') {
    const segs: Seg[] = [{ key: 'valid', n: c.valid, tone: 'bg-done', label: t('batchProgress.valid') }, { key: 'invalid', n: c.error, tone: 'bg-late', label: t('batchProgress.invalid') }];
    const label = t('batchProgress.checked', { total: c.rows, valid: c.valid, validPct: pct(c.valid, c.rows), invalid: c.error, invalidPct: pct(c.error, c.rows) });
    return (
      <section className={wrap} data-testid="batch-progress" data-phase="validated" aria-label={t('batchProgress.title')}>
        <Bar segs={segs} total={c.rows} now={pct(c.valid, c.rows)} label={label} testid="batch-progress-checked" />
        <p className="mt-2 text-xs text-mute" data-testid="batch-progress-split">{t('batchProgress.split', { create: c.create, update: c.update, unchanged: c.unchanged })}</p>
      </section>
    );
  }

  if (['in_approval', 'partially_approved', 'in_review', 'approved', 'rejected'].includes(b.status)) {
    const segs: Seg[] = [
      { key: 'approved', n: c.approved, tone: 'bg-done', label: t('batchProgress.approved') },
      { key: 'rejected', n: c.rejected, tone: 'bg-late', label: t('batchProgress.rejected') },
      { key: 'held', n: c.held, tone: 'bg-lock', label: t('batchProgress.held') },
      { key: 'pending', n: c.pending, tone: 'bg-wait', label: t('batchProgress.pending') },
    ];
    const total = c.sent, doneN = site ? c.approved : c.approved + c.rejected, p = pct(doneN, total);
    const label = site ? t('batchProgress.sites_created', { done: c.approved, total, pct: p }) : t('batchProgress.done', { pct: p, done: doneN, total });
    const pr = b.progress;
    return (
      <section className={wrap} data-testid="batch-progress" data-phase="sent" aria-label={t('batchProgress.title')}>
        <Bar segs={segs} total={total} now={p} label={label} testid="batch-progress-sent" />
        {pr?.state === 'failed' && <p className="mt-2 text-xs text-lateInk" role="status" data-testid="batch-progress-run-failed">{t('batchProgress.processing_failed', { done: pr.rows_done, total: pr.rows_total })}</p>}
        {!!pr?.failed && <p className="mt-2 text-xs text-lateInk" data-testid="batch-progress-run-errors">{t('batchProgress.processing_errors', { count: pr.failed })}</p>}
      </section>
    );
  }

  if (b.status === 'discarded' || b.status === 'failed') {
    return <p className={`${wrap} text-mute`} role="status" data-testid="batch-progress" data-phase={b.status}>{b.status === 'failed' ? t('batchProgress.failed') : t('batchProgress.discarded')}</p>;
  }
  return null;
}
