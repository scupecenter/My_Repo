import { Camera, Check, Download, FileUp, Plus, Trash2, Undo2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { downloadDocument } from '@/api/documents';
import { useDecideEvidence, useRaiseSnag, useSiteSnags, useSnagOp, useSnagPhoto, useSnagSeverities, useSnagTypes, useWithdrawSnagPhoto, type Snag } from '@/api/qc';
import { taskErrorMessage } from '@/lib/taskErrors';
import { RejectDialog } from './RejectDialog';
import { useToast } from './Toast';

const STATE_TONE: Record<string, string> = { open: 'bg-lateBg text-lateInk', fix_submitted: 'bg-openBg text-openInk', in_review: 'bg-waitBg text-waitInk', closed: 'bg-doneBg text-doneInk', cancelled: 'bg-lockBg text-lockInk' };
const MB = 1024 * 1024;

/** The words of a refused photo: the EXIF date before the raise, the format, the size, or the server's message. */
export function snagError(t: (k: string, o?: Record<string, unknown>) => string, e: unknown): string {
  if (e instanceof ApiError) {
    const p = e.problem as unknown as { reason?: string; max_size_mb?: number; allowed?: string[]; errors?: { code: string }[] };
    if (e.code === 'file_rejected' && p.reason === 'before_snag_raised') return t('snags.err.before_raised');
    if (e.code === 'file_rejected') return t('snags.err.format', { formats: (p.allowed ?? []).join(', ') });
    if (e.code === 'file_too_large') return t('snags.err.too_large', { mb: p.max_size_mb ?? 20 });
    if (e.code === 'self_approval_forbidden') return t('snags.err.self_approval_forbidden');
    const first = p.errors?.[0]?.code;
    if (e.code === 'validation_failed' && first && ['min_count', 'shot_type_missing', 'unknown_shot_type'].includes(first)) return t(`snags.err.${first}`);
  }
  return taskErrorMessage(t as never, e) || t('snags.err.failed');
}

function SnagCard({ snag, siteId }: { snag: Snag; siteId: string }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const up = useSnagPhoto(siteId), del = useWithdrawSnagPhoto(siteId), op = useSnagOp(siteId), ev = useDecideEvidence(siteId);
  const rules = snag.snag_type.photo_rules;
  const shots = rules.shot_types ?? [];
  const [shot, setShot] = useState(shots[0] ?? '');
  const [rejecting, setRejecting] = useState(false);
  const camRef = useRef<HTMLInputElement>(null);
  const can = (a: string) => (snag.allowed_actions ?? []).includes(a as never);
  const typeName = (i18n.language === 'ar' && snag.snag_type.name_ar) || snag.snag_type.name_en;
  const busy = up.isPending || del.isPending || op.isPending || ev.isPending;
  const decide = (photoId: string, decision: 'accept' | 'reject') => {
    const note = window.prompt(t(`snags.evidence_${decision}_prompt`)) ?? '';
    if (note.trim().length < 3) return;
    ev.mutate({ snag, photoId, decision, note: note.trim() }, { onSuccess: () => toast(t(`snags.evidence_${decision}ed`)), onError: (e) => toast(snagError(t, e), 'err') });
  };
  const sevName = (i18n.language === 'ar' && snag.severity_label?.name_ar) || snag.severity_label?.name_en || snag.severity;
  const accept = (rules.formats ?? ['JPG', 'PNG', 'HEIC']).map((f) => `.${f.toLowerCase()}`).join(',');
  const send = (f: File) => {
    if (rules.max_size_mb && f.size > rules.max_size_mb * MB) { toast(t('snags.err.too_large', { mb: rules.max_size_mb }), 'err'); return; }
    up.mutate({ snag, file: f, shot_type: shot || null }, { onSuccess: () => toast(t('snags.photo_added')), onError: (e) => toast(`${f.name}: ${snagError(t, e)}`, 'err') });
  };
  const run = (o: 'submit' | 'approve' | 'reject', note?: string) =>
    op.mutate({ snag, op: o, note }, { onSuccess: () => { setRejecting(false); toast(t(`snags.done_${o}`)); }, onError: (e) => { setRejecting(false); toast(snagError(t, e), 'err'); } });
  const photos = snag.photos ?? [];
  return (
    <li className="rounded-md border border-line p-3" data-testid={`snag-${snag.id}`} data-state={snag.state}>
      <div className="flex flex-wrap items-center gap-2">
        <b>{snag.title}</b>
        <span className="chip bg-card2">{snag.scope}</span>
        <span className="chip bg-card2 text-xs">{typeName}</span>
        {snag.severity && <span className="chip bg-card2 text-xs" data-testid={`snag-severity-${snag.id}`}>{sevName}</span>}
        {snag.severity_missing && <span className="chip bg-waitBg text-waitInk text-xs" data-testid={`snag-severity-missing-${snag.id}`}>{t('snags.severity_missing')}</span>}
        {snag.register_record && <span className="chip bg-card2 text-xs" data-testid={`snag-record-${snag.id}`}>{t('snags.from_record', { code: snag.register_record.record_code ?? '' })}</span>}
        {snag.self_approval && <span className="chip bg-waitBg text-waitInk text-xs" data-testid={`snag-self-${snag.id}`}>{t('drawer.self_approval')}</span>}
        <span className={`chip ms-auto ${STATE_TONE[snag.state] ?? ''}`} data-testid={`snag-state-${snag.id}`}>{t(`snagState.${snag.state}`)}</span>
      </div>
      {snag.description && <p className="mt-1 text-sm text-mute">{snag.description}</p>}
      {(snag.found_by || snag.fixed_by || snag.approved_by) && (
        <p className="mt-1 text-xs text-mute" data-testid={`snag-people-${snag.id}`}>
          {[snag.found_by && t('snags.found_by', { name: snag.found_by.display_name }), snag.fixed_by && t('snags.fixed_by', { name: snag.fixed_by.display_name }),
            snag.approved_by && t('snags.approved_by', { name: snag.approved_by.display_name })].filter(Boolean).join(' · ')}
        </p>
      )}
      {snag.approval_blocked === 'self_approval_forbidden' && <p className="mt-1 text-xs text-lateInk" data-testid={`snag-self-blocked-${snag.id}`}>{t('snags.self_blocked')}</p>}
      {snag.ball_in_court?.votes_needed ? <p className="mt-1 text-xs text-mute" data-testid={`snag-votes-${snag.id}`}>{t('snags.votes', { done: snag.ball_in_court.votes_done ?? 0, needed: snag.ball_in_court.votes_needed })}</p> : null}
      <p className="mt-1 text-xs text-mute" data-testid={`snag-rules-${snag.id}`}>
        {t('snags.rules', { n: snag.photos_required ?? 1, formats: (rules.formats ?? []).join(', '), mb: rules.max_size_mb ?? 20 })}{shots.length ? ` · ${t('snags.shots', { list: shots.join(', ') })}` : ''}
      </p>
      {snag.last_return_note && snag.state !== 'closed' && snag.state !== 'in_review' && (
        <p className="mt-1 rounded-md bg-lateBg p-2 text-sm text-lateInk" data-testid={`snag-return-${snag.id}`}>{t('approvals.returned_note', { note: snag.last_return_note })}</p>
      )}
      <ul className="mt-2 space-y-1 text-sm" data-testid={`snag-photos-${snag.id}`}>
        {photos.map((p) => (
          <li key={p.id} className={`flex flex-wrap items-center gap-2 ${p.status === 'rejected' ? 'opacity-70' : ''}`} data-testid={`snag-photo-${p.id}`}>
            <button type="button" className="text-link hover:underline" onClick={() => void downloadDocument(p.file_id)}><Download size={12} className="me-1 inline" />{p.shot_type ?? t('snags.photo')}</button>
            {p.unknown_capture_date && <span className="chip bg-waitBg text-waitInk" data-testid={`snag-photo-unknown-${p.id}`}>{t('docs.unknown_capture')}</span>}
            {p.captured_at && <span className="text-xs text-mute">{t('docs.captured', { date: p.captured_at.slice(0, 10) })}</span>}
            {p.status === 'rejected' && <span className="chip bg-lateBg text-lateInk" data-testid={`snag-photo-rejected-${p.id}`}>{t('slotStatus.rejected')}{p.reject_reason ? `: ${p.reject_reason}` : ''}</span>}
            {p.status === 'pending_evidence' && <span className="chip bg-waitBg text-waitInk" data-testid={`snag-photo-pending-${p.id}`}>{t('snags.pending_evidence')}</span>}
            {p.status === 'pending_evidence' && can('decide_evidence') && (
              <>
                <button type="button" className="btn px-1 py-0.5 text-xs" data-testid={`snag-evidence-accept-${p.id}`} disabled={busy} onClick={() => decide(p.id, 'accept')}>{t('snags.evidence_accept')}</button>
                <button type="button" className="btn btn-danger px-1 py-0.5 text-xs" data-testid={`snag-evidence-reject-${p.id}`} disabled={busy} onClick={() => decide(p.id, 'reject')}>{t('snags.evidence_reject')}</button>
              </>
            )}
            {can('upload') && p.status !== 'rejected' && (
              <button type="button" className="btn ms-auto px-1 py-0.5 text-xs" aria-label={t('docs.withdraw')} data-testid={`snag-photo-withdraw-${p.id}`} disabled={busy}
                onClick={() => del.mutate({ snag, photoId: p.id }, { onError: (e) => toast(snagError(t, e), 'err') })}><Trash2 size={12} /></button>
            )}
          </li>
        ))}
        {!photos.length && <li className="text-mute">{t('snags.no_photos')}</li>}
      </ul>
      {can('upload') && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {shots.length > 0 && (
            <select className="input w-40" aria-label={t('snags.shot_type')} data-testid={`snag-shot-${snag.id}`} value={shot} onChange={(e) => setShot(e.target.value)}>
              {shots.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
          <label className="btn cursor-pointer text-sm" data-testid={`snag-upload-${snag.id}`}>
            <FileUp size={14} />{t('snags.add_photo')}
            <input type="file" className="sr-only" accept={accept} data-testid={`snag-input-${snag.id}`} onChange={(e) => { const f = e.target.files?.[0]; if (f) send(f); e.target.value = ''; }} />
          </label>
          <button type="button" className="btn text-sm" onClick={() => camRef.current?.click()}><Camera size={14} />{t('docs.camera')}</button>
          <input ref={camRef} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden="true"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) send(f); e.target.value = ''; }} />
        </div>
      )}
      {snag.state !== 'closed' && (snag.photos_missing?.length ?? 0) > 0 && can('upload') && (
        <p className="mt-1 text-xs text-lateInk" data-testid={`snag-missing-${snag.id}`}>{snag.photos_missing!.map((m) => m.message ?? m.code).join(' · ')}</p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {can('reject') && <button className="btn btn-danger" data-testid={`snag-reject-${snag.id}`} disabled={busy} onClick={() => setRejecting(true)}><Undo2 size={14} />{t('approvals.reject')}</button>}
        {can('submit') && <button className="btn btn-primary ms-auto" data-testid={`snag-submit-${snag.id}`} disabled={busy} onClick={() => run('submit')}><Check size={14} />{t('snags.submit')}</button>}
        {can('approve') && <button className="btn btn-primary ms-auto" data-testid={`snag-approve-${snag.id}`} disabled={busy} onClick={() => run('approve')}><Check size={14} />{t('snags.approve')}</button>}
      </div>
      <RejectDialog open={rejecting} title={t('snags.reject_title', { title: snag.title ?? '' })} onClose={() => setRejecting(false)} onSend={(note) => run('reject', note)} />
    </li>
  );
}

function RaiseForm({ siteId, onDone }: { siteId: string; onDone: () => void }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const types = useSnagTypes();
  const severities = useSnagSeverities();
  const raise = useRaiseSnag(siteId);
  const [severity, setSeverity] = useState('');
  const [typeId, setTypeId] = useState('');
  const [scope, setScope] = useState<'CW' | 'TE'>('CW');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const tid = typeId || types.data?.[0]?.id || '';
  const activeSev = (severities.data?.items ?? []).filter((x) => x.is_active);
  return (
    <form className="card space-y-2 p-3" data-testid="snag-raise-form" onSubmit={(e) => {
      e.preventDefault();
      raise.mutate({ snag_type_id: tid, scope, title: title.trim(), severity, ...(description.trim() ? { description: description.trim() } : {}) }, {
        onSuccess: () => { toast(t('snags.raised')); onDone(); }, onError: (err) => toast(snagError(t, err), 'err'),
      });
    }}>
      <div className="grid gap-2 sm:grid-cols-4">
        <label className="text-sm">{t('snags.type')}
          <select className="input mt-1" data-testid="snag-raise-type" value={tid} onChange={(e) => setTypeId(e.target.value)}>
            {(types.data ?? []).map((x) => <option key={x.id} value={x.id}>{(i18n.language === 'ar' && x.name_ar) || x.name_en}</option>)}
          </select>
        </label>
        <label className="text-sm">{t('snags.scope')}
          <select className="input mt-1" data-testid="snag-raise-scope" value={scope} onChange={(e) => setScope(e.target.value as 'CW' | 'TE')}>
            <option value="CW">CW</option><option value="TE">TE</option>
          </select>
        </label>
        <label className="text-sm">{t('snags.severity')}
          <select className="input mt-1" data-testid="snag-raise-severity" value={severity} onChange={(e) => setSeverity(e.target.value)}>
            <option value="">{t('snags.severity_choose')}</option>
            {activeSev.map((x) => <option key={x.code} value={x.code}>{(i18n.language === 'ar' && x.name_ar) || x.name_en}</option>)}
          </select>
        </label>
        <label className="text-sm">{t('snags.title')}
          <input className="input mt-1" data-testid="snag-raise-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
        </label>
      </div>
      <label className="block text-sm">{t('snags.description')}
        <textarea className="input mt-1 min-h-14" data-testid="snag-raise-description" value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={onDone}>{t('common.cancel')}</button>
        <button type="submit" className="btn btn-primary" data-testid="snag-raise-send" disabled={raise.isPending || title.trim().length < 3 || !tid || !severity}>{t('snags.raise')}</button>
      </div>
    </form>
  );
}

/** The QC snags of a site (owner answers Q131 / Q132): photos of the fix by L1, approval by L2 closes the snag; an open snag blocks its stream's PAC / FAC. */
export function SiteSnags({ siteId }: { siteId: string }) {
  const { t } = useTranslation();
  const q = useSiteSnags(siteId);
  const [raising, setRaising] = useState(false);
  return (
    <div className="space-y-3" data-testid="site-snags">
      <div className="flex items-center gap-2">
        <p className="me-auto text-sm text-mute" data-testid="snag-open-count">{t('snags.open_count', { count: q.data?.open_count ?? 0 })}</p>
        {!raising && <button className="btn" data-testid="snag-raise" onClick={() => setRaising(true)}><Plus size={14} />{t('snags.raise')}</button>}
      </div>
      {raising && <RaiseForm siteId={siteId} onDone={() => setRaising(false)} />}
      {q.isLoading ? <p className="text-mute">{t('common.loading')}</p>
        : q.isError ? <p role="alert" className="text-lateInk" data-testid="snags-error">{t('snags.load_failed')}</p>
          : (
            <ul className="space-y-2" data-testid="snag-list">
              {(q.data?.items ?? []).map((s) => <SnagCard key={`${s.id}-${s.version}`} snag={s} siteId={siteId} />)}
              {!q.data?.items.length && <li className="text-mute">{t('snags.none')}</li>}
            </ul>
          )}
    </div>
  );
}
