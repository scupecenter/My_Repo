import { Lock } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePrivateNote, useSavePrivateNote, type NoteEntity } from '@/api/privateNotes';
import { useExtra } from '@/lib/uiExtras';
import { Tip } from './Tip';

const MAX = 4000;

/** A note only I can read, kept on the record the drawer shows (item 7). It sits under the drawer body, closed until opened, and saves with its own button. */
export function PrivateNotePanel({ type, id }: { type: NoteEntity; id: string }) {
  const { t } = useTranslation();
  const on = useExtra('private_notes');
  const [open, setOpen] = useState(false);
  const q = usePrivateNote(type, id, on);
  const save = useSavePrivateNote(type, id);
  const [draft, setDraft] = useState<string | null>(null);
  if (!on) return null;
  const saved = q.data?.body ?? '';
  const text = draft ?? saved;
  const dirty = draft !== null && draft !== saved;
  const has = saved.trim().length > 0;
  return (
    <section className="border-t border-line bg-surface px-3 py-2" data-testid="private-note" aria-label={t('pnote.title')}>
      <Tip text={t('pnote.tip')}>
        <button type="button" className="flex w-full items-center gap-2 text-start text-sm font-medium" aria-expanded={open} aria-label={t('pnote.title')}
          data-testid="private-note-toggle" onClick={() => setOpen((v) => !v)}>
          <Lock size={14} aria-hidden />
          <span>{t('pnote.title')}</span>
          {has && <span className="rounded bg-brand/10 px-1.5 text-xs" data-testid="private-note-has">{t('pnote.has')}</span>}
        </button>
      </Tip>
      {open && (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-muted">{t('pnote.hint')}</p>
          <textarea className="min-h-24 w-full rounded border border-line bg-bg p-2 text-sm" dir="auto" maxLength={MAX} value={text} data-testid="private-note-text"
            aria-label={t('pnote.title')} onChange={(e) => setDraft(e.target.value)} disabled={q.isLoading} />
          <div className="flex items-center justify-between gap-2 text-xs text-muted">
            <span>{text.length} / {MAX}</span>
            <span role="status" data-testid="private-note-status">{save.isError ? t('pnote.failed') : save.isSuccess && !dirty ? t('pnote.saved') : ''}</span>
            <button type="button" className="btn btn-primary" disabled={!dirty || save.isPending} data-testid="private-note-save" aria-label={t('pnote.save')}
              onClick={() => save.mutate(text, { onSuccess: () => setDraft(null) })}>{t('pnote.save')}</button>
          </div>
        </div>
      )}
    </section>
  );
}
