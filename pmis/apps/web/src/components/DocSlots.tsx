import * as Dialog from '@radix-ui/react-dialog';
import { Camera, Download, FileUp, History, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { downloadDocument, suggestSlots, taskTarget, useAddSlot, useSlotUpload, useWithdrawFile, type DocumentSlot, type SlotSuggestion, type SlotTarget } from '@/api/documents';
import type { TaskDetail } from '@/api/types';
import { taskErrorMessage } from '@/lib/taskErrors';
import { useToast } from './Toast';

const SLOT_TONE: Record<string, string> = { approved: 'bg-doneBg text-doneInk', uploaded: 'bg-openBg text-openInk', in_review: 'bg-waitBg text-waitInk', rejected: 'bg-lateBg text-lateInk', missing: 'bg-lockBg text-lockInk', not_required: 'bg-lockBg text-lockInk' };
const IMAGE_FORMATS = new Set(['jpg', 'jpeg', 'png', 'heic', 'webp']);
const MB = 1024 * 1024;

export const slotUploadable = (s: DocumentSlot, edit: boolean): boolean =>
  s.can_upload ?? (edit && (s.status === 'missing' || s.status === 'uploaded' || s.status === 'rejected'));

/** Plain words for a refused upload: the reason the server gives for a rejected file, the limit for a large one. */
export function uploadMessage(t: (k: string, o?: Record<string, unknown>) => string, e: unknown, slot?: DocumentSlot): string {
  if (e instanceof ApiError) {
    const p = e.problem as unknown as { reason?: string; max_size_mb?: number; allowed?: string[] };
    if (e.code === 'file_too_large') return t('docs.err.too_large', { mb: p.max_size_mb ?? slot?.max_size_mb ?? 20 });
    if (e.code === 'file_rejected') {
      const key = `docs.rej.${p.reason ?? 'unknown_type'}`;
      const txt = t(key, { formats: (p.allowed ?? slot?.formats ?? []).join(', ') });
      return txt === key ? t('docs.rej.unknown_type') : txt;
    }
    if (e.code === 'invalid_transition' || e.code === 'not_eligible_holder') return t(`taskErrors.${e.code}`);
  }
  return taskErrorMessage(t as never, e) || t('drawer.upload_failed');
}

/** The checks the browser can make before sending (the server checks the bytes again): size and the extension against the document's formats. */
export function precheck(t: (k: string, o?: Record<string, unknown>) => string, slot: DocumentSlot, f: File): string | null {
  const max = (slot.max_size_mb ?? 20) * MB;
  if (f.size > max) return t('docs.err.too_large', { mb: slot.max_size_mb ?? 20 });
  if (f.size === 0) return t('docs.rej.empty');
  const ext = (f.name.split('.').pop() ?? '').toLowerCase().replace('jpeg', 'jpg');
  const ok = (slot.formats ?? []).map((x) => x.toLowerCase().replace('jpeg', 'jpg'));
  if (ok.length > 0 && ext && f.type !== '' && !ok.includes(ext) && !(f.type.startsWith('image/') && ok.includes(f.type.slice(6).replace('jpeg', 'jpg')))) return t('docs.rej.format_not_allowed', { formats: (slot.formats ?? []).join(', ') });
  return null;
}

const acceptOf = (s: DocumentSlot): string => (s.formats ?? []).map((x) => `.${x}`).join(',');
const camera = (s: DocumentSlot): boolean => s.kind === 'photo' || (s.formats ?? []).some((x) => IMAGE_FORMATS.has(x.toLowerCase()));
const size = (n: number): string => (n >= MB ? `${(n / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function SlotCard({ slot, canUpload, onFile, onWithdraw, onDeclare, onAddCandidate, busy }: {
  slot: DocumentSlot; canUpload: boolean; onFile: (f: File) => void; onWithdraw: (fileId: string) => void; onDeclare: () => void; onAddCandidate: (label: string) => void; busy: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [over, setOver] = useState(false);
  const [history, setHistory] = useState(false);
  const [label, setLabel] = useState('');
  const camRef = useRef<HTMLInputElement>(null);
  const drop = (e: DragEvent) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f && canUpload) onFile(f); };
  const name = (i18n.language === 'ar' && slot.name_ar) || slot.name_en;
  const current = slot.files.filter((f) => f.is_current);
  const older = slot.files.filter((f) => !f.is_current);
  const fileLine = (f: (typeof slot.files)[number], old: boolean) => (
    <li key={f.id} className={`flex flex-wrap items-center gap-2 ${old ? 'opacity-75' : ''}`} data-testid={`file-${f.id}`}>
      <button type="button" className="mono truncate text-link hover:underline" data-testid={`file-dl-${f.id}`} title={f.download_name} onClick={() => void downloadDocument(f.id)}><Download size={12} className="me-1 inline" />{f.original_name}</button>
      <span className="chip bg-card2" data-testid={`file-v-${f.id}`}>v{f.version}</span>
      <span className="text-xs">{size(f.size_bytes)}</span>
      {f.unknown_capture_date && <span className="chip bg-waitBg text-waitInk" data-testid={`file-unknown-date-${f.id}`}>{t('docs.unknown_capture')}</span>}
      {f.capture_date && <span className="text-xs" data-testid={`file-capture-${f.id}`}>{t('docs.captured', { date: f.capture_date.slice(0, 10) })}</span>}
      {canUpload && !old && <button type="button" className="btn ms-auto px-1 py-0.5 text-xs" aria-label={t('docs.withdraw')} data-testid={`file-withdraw-${f.id}`} disabled={busy} onClick={() => onWithdraw(f.id)}><Trash2 size={12} /></button>}
    </li>
  );
  return (
    <li data-testid={`slot-${slot.id}`} data-status={slot.status} className="rounded-md border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <b>{name}</b>{slot.candidate_label && <span className="chip bg-card2" data-testid={`slot-candidate-${slot.id}`}>{slot.candidate_label}</span>}
        {slot.mandatory && slot.status !== 'not_required' && <span className="text-lateInk" title={t('drawer.mandatory')}>*</span>}
        {slot.conditional && <span className="chip bg-card2 text-xs" data-testid={`slot-conditional-${slot.id}`}>{t('docs.conditional')}</span>}
        <span className={`chip ms-auto ${SLOT_TONE[slot.status]}`} data-testid={`slot-status-${slot.id}`}>{t(`slotStatus.${slot.status}`)}</span>
      </div>
      <p className="text-xs text-mute" data-testid={`slot-limits-${slot.id}`}>{t('docs.limits', { formats: (slot.formats ?? []).join(', '), mb: slot.max_size_mb ?? 20 })}{slot.max_files ? ` · ${t('docs.max_files', { n: slot.max_files })}` : ''}</p>
      {slot.determination_pending && <p className="mt-1 rounded-md bg-waitBg p-2 text-xs text-waitInk" data-testid={`slot-pending-${slot.id}`}>{t('docs.determination_pending')}</p>}
      {slot.inherited_approval && <p className="mt-1 text-xs text-mute" data-testid={`slot-inherited-${slot.id}`}>{t('docs.inherited_approval')}</p>}
      {slot.shared_with && (
        <p className="mt-1 text-xs text-mute" data-testid={`slot-shared-${slot.id}`}>
          {slot.shared_with.owner === 'task' ? t('docs.shared_task', { code: slot.shared_with.task_code ?? '' }) : t('docs.shared_record', { key: slot.shared_with.register_key ?? '' })}
          {slot.shared_with.has_file && ['uploaded', 'in_review', 'approved'].includes(slot.shared_with.status ?? '') ? ` · ${t('docs.shared_filled')}` : ''}
        </p>
      )}
      {slot.status === 'rejected' && slot.reject_reason && <p className="mt-1 text-sm text-lateInk" data-testid={`slot-reject-${slot.id}`}>{slot.reject_reason}</p>}
      {slot.blank_form_file_id && <button type="button" className="mt-1 text-xs text-link hover:underline" data-testid={`slot-blank-${slot.id}`} onClick={() => void downloadDocument(slot.blank_form_file_id as string)}>{t('docs.blank_form')}</button>}
      <ul className="mt-1 space-y-1 text-sm text-mute">{current.map((f) => fileLine(f, false))}</ul>
      {older.length > 0 && (
        <div className="mt-1">
          <button type="button" className="inline-flex items-center gap-1 text-xs text-link" aria-expanded={history} data-testid={`slot-history-${slot.id}`} onClick={() => setHistory(!history)}><History size={12} />{t('docs.history', { count: older.length })}</button>
          {history && <ul className="mt-1 space-y-1 border-s border-line ps-2 text-sm text-mute" data-testid={`slot-history-list-${slot.id}`}>{older.map((f) => fileLine(f, true))}</ul>}
        </div>
      )}
      {canUpload && (
        <div className="mt-2 flex flex-wrap gap-2">
          <label data-testid={`slot-drop-${slot.id}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}
            className={`flex min-w-48 flex-1 cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed p-2 text-sm ${over ? 'border-accent bg-accentSoft' : 'border-line text-mute hover:bg-hover'}`}>
            <FileUp size={14} />{t('drawer.drop')}
            <input type="file" className="sr-only" accept={acceptOf(slot) || undefined} data-testid={`slot-input-${slot.id}`} onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
          </label>
          {camera(slot) && (
            <>
              <button type="button" className="btn text-sm" data-testid={`slot-camera-btn-${slot.id}`} onClick={() => camRef.current?.click()}><Camera size={14} />{t('docs.camera')}</button>
              <input ref={camRef} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden="true" data-testid={`slot-camera-${slot.id}`}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
            </>
          )}
        </div>
      )}
      {canUpload && !slot.conditional && (
        <details className="mt-1 text-xs">
          <summary className="cursor-pointer text-mute">{t('docs.more')}</summary>
          <div className="mt-1 flex gap-2">
            <input className="input py-1 text-sm" aria-label={t('docs.candidate_label')} placeholder={t('docs.candidate_label')} data-testid={`slot-candidate-input-${slot.id}`} value={label} maxLength={100} onChange={(e) => setLabel(e.target.value)} />
            <button type="button" className="btn text-sm" data-testid={`slot-add-candidate-${slot.id}`} disabled={!label.trim() || busy} onClick={() => { onAddCandidate(label.trim()); setLabel(''); }}><Plus size={12} />{t('docs.add_candidate')}</button>
          </div>
        </details>
      )}
      {slot.status === 'not_required' && (
        <button type="button" className="btn mt-2 text-sm" data-testid={`slot-declare-${slot.id}`} disabled={busy} onClick={onDeclare}><Plus size={14} />{t('docs.declare')}</button>
      )}
    </li>
  );
}

interface Pending { file: File; slotId: string | '' }

/** Several files dropped at once: the type of each is suggested from its name and confirmed here, then they are uploaded one by one. */
function SuggestDialog({ task, files, slots, onClose, onUpload }: { task: string; files: File[]; slots: DocumentSlot[]; onClose: () => void; onUpload: (p: Pending[]) => void }) {
  const { t, i18n } = useTranslation();
  const [rows, setRows] = useState<Pending[] | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    const best = (items: SlotSuggestion[], i: number): string => { const top = items[i]?.suggestions[0]; return top && top.score >= 0.5 ? top.slot_id : ''; };
    void suggestSlots(task, files.map((f) => f.name))
      .then((items) => live && setRows(files.map((file, i) => ({ file, slotId: best(items, i) }))))
      .catch(() => live && setRows(files.map((file) => ({ file, slotId: '' }))))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [task, files]);
  const label = (s: DocumentSlot) => `${s.doc_code} · ${(i18n.language === 'ar' && s.name_ar) || s.name_en}${s.candidate_label ? ` (${s.candidate_label})` : ''}`;
  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-scrim/60" />
        <Dialog.Content data-testid="suggest-dialog" className="card fixed inset-x-0 top-[8vh] z-[70] mx-auto max-h-[84vh] w-[min(640px,94vw)] space-y-3 overflow-y-auto p-5">
          <Dialog.Title className="text-lg font-bold">{t('docs.suggest_title')}</Dialog.Title>
          <Dialog.Description className="text-sm text-mute">{t('docs.suggest_help')}</Dialog.Description>
          {loading || !rows ? <p>{t('common.loading')}</p> : (
            <ul className="space-y-2">
              {rows.map((r, i) => (
                <li key={`${r.file.name}-${i}`} className="flex flex-wrap items-center gap-2">
                  <span className="mono min-w-0 flex-1 truncate" title={r.file.name}>{r.file.name}</span>
                  <select className="input w-64" aria-label={t('docs.choose_type', { name: r.file.name })} data-testid={`suggest-select-${i}`} value={r.slotId}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, slotId: e.target.value } : x)))}>
                    <option value="">{t('docs.skip')}</option>
                    {slots.map((s) => <option key={s.id} value={s.id}>{label(s)}</option>)}
                  </select>
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-end gap-2">
            <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
            <button className="btn btn-accent" data-testid="suggest-confirm" disabled={loading || !rows || !rows.some((r) => r.slotId)} onClick={() => rows && onUpload(rows.filter((r) => r.slotId))}>{t('docs.upload_n', { count: rows?.filter((r) => r.slotId).length ?? 0 })}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The Documents tab of a task: one named slot per required document (CLAUDE.md "Upload UI"). */
export function DocSlots({ task, edit }: { task: TaskDetail; edit: boolean }) {
  return <SlotList slots={task.slots as DocumentSlot[]} target={taskTarget(task)} edit={edit} suggestFor={task.id} />;
}

/**
 * The named slots of a task or of a register record (Q131): drag, click or camera into a slot, versions, withdraw, "this document applies", candidates.
 * `suggestFor`: the task whose multi-file suggestion endpoint is used (records have none: one file per slot).
 */
export function SlotList({ slots, target, edit, suggestFor }: { slots: DocumentSlot[]; target: SlotTarget; edit: boolean; suggestFor?: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const up = useSlotUpload(target), del = useWithdrawFile(target), add = useAddSlot(target);
  const [multi, setMulti] = useState<File[] | null>(null);
  const [over, setOver] = useState(false);
  // Q226: a slot whose rule waits for a determination is shown with the active slots ("pending determination"), not as a confirmed "not required"
  const active = slots.filter((s) => s.status !== 'not_required' || s.determination_pending);
  const optional = slots.filter((s) => s.status === 'not_required' && !s.determination_pending);
  const uploadable = active.filter((s) => slotUploadable(s, edit));
  const send = (slot: DocumentSlot, file: File): Promise<boolean> => {
    const pre = precheck(t, slot, file);
    if (pre) { toast(`${file.name}: ${pre}`, 'err'); return Promise.resolve(false); }
    return up.mutateAsync({ slot, file }).then(() => true, (e) => { toast(`${file.name}: ${uploadMessage(t, e, slot)}`, 'err'); return false; });
  };
  const sendMany = async (rows: Pending[]) => {
    setMulti(null);
    let ok = 0;
    for (const r of rows) { const s = slots.find((x) => x.id === r.slotId); if (s && (await send(s, r.file))) ok++; }
    if (ok) toast(t('docs.uploaded_n', { count: ok }));
  };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setOver(false); const fs = [...e.dataTransfer.files]; if (fs.length && uploadable.length) setMulti(fs); };
  const busy = up.isPending || del.isPending || add.isPending;
  const act = (p: Promise<unknown>) => void p.catch((e) => toast(uploadMessage(t, e), 'err'));
  return (
    <>
      {edit && suggestFor && uploadable.length > 1 && (
        <label data-testid="docs-multi-drop" onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}
          className={`mb-2 flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed p-3 text-sm ${over ? 'border-accent bg-accentSoft' : 'border-line text-mute hover:bg-hover'}`}>
          <FileUp size={14} />{t('docs.multi_drop')}
          <input type="file" multiple className="sr-only" data-testid="docs-multi-input" onChange={(e) => { const fs = [...(e.target.files ?? [])]; if (fs.length) setMulti(fs); e.target.value = ''; }} />
        </label>
      )}
      <ul className="space-y-2" data-testid="slot-list">
        {active.map((s) => (
          <SlotCard key={s.id} slot={s} canUpload={slotUploadable(s, edit)} busy={busy}
            onFile={(f) => void send(s, f)}
            onWithdraw={(fileId) => act(del.mutateAsync({ slotId: s.id, fileId }))}
            onDeclare={() => act(add.mutateAsync({ doc_code: s.doc_code, candidate_label: s.candidate_label ?? null }))}
            onAddCandidate={(label) => act(add.mutateAsync({ doc_code: s.doc_code, candidate_label: label }))} />
        ))}
        {!slots.length && <li className="text-mute">{t('drawer.no_slots')}</li>}
      </ul>
      {optional.length > 0 && (
        <details className="mt-3" data-testid="slot-optional">
          <summary className="cursor-pointer text-sm text-mute">{t('docs.optional', { count: optional.length })}</summary>
          <ul className="mt-2 space-y-2">
            {optional.map((s) => (
              <SlotCard key={s.id} slot={s} canUpload={false} busy={busy} onFile={() => undefined} onWithdraw={() => undefined}
                onDeclare={() => act(add.mutateAsync({ doc_code: s.doc_code, candidate_label: s.candidate_label ?? null }))} onAddCandidate={() => undefined} />
            ))}
          </ul>
        </details>
      )}
      {multi && suggestFor && <SuggestDialog task={suggestFor} files={multi} slots={uploadable} onClose={() => setMulti(null)} onUpload={(rows) => void sendMany(rows)} />}
    </>
  );
}
