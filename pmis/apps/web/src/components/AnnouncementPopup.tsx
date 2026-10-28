import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRespond, usePendingAnnouncements } from '@/api/msg';
import { errorCodes, fmtDateTime } from '@/lib/time';
import { errText } from './FormDialog';

type Draft = { mode: 'ask' | 'disagree'; note: string };

/**
 * The blocking announcement pop-up (ADR 0013). Shows the oldest unanswered announcement of the signed-in person, whatever
 * their account state. It has no close button, and Escape and a click outside do nothing; the rest of the page stays inert
 * behind it (a modal dialog). After an answer the next one shows. Mounted once, inside the signed-in gate.
 */
export function AnnouncementPopup() {
  const { t, i18n } = useTranslation();
  const q = usePendingAnnouncements(true);
  const respond = useRespond();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [err, setErr] = useState<{ id: string; text: string } | null>(null);
  const item = q.data?.[0];
  if (!item) return null;

  const draft = drafts[item.id] ?? { mode: 'ask', note: '' };
  const set = (d: Partial<Draft>) => setDrafts((x) => ({ ...x, [item.id]: { ...draft, ...d } }));
  const short = draft.note.trim().length < 3;
  const send = (decision: 'agree' | 'disagree') => {
    setErr(null);
    respond.mutate({ id: item.id, decision, note: decision === 'disagree' ? draft.note.trim() : undefined }, {
      onError: (e) => {
        if (e.status === 409) return; // answered somewhere else: it is gone from the list
        setErr({ id: item.id, text: e.code === 'note_required' || errorCodes(e).includes('note_required') ? t('annPopup.note_required') : errText(e, t) });
        if (decision === 'disagree') set({ mode: 'disagree' });
      },
    });
  };
  const sender = item.created_by;
  return (
    <Dialog.Root open modal>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-scrim/70 backdrop-blur-[2px]" />
        <Dialog.Content data-testid="ann-popup" key={item.id}
          onEscapeKeyDown={(e) => e.preventDefault()} onPointerDownOutside={(e) => e.preventDefault()} onInteractOutside={(e) => e.preventDefault()} onFocusOutside={(e) => e.preventDefault()}
          className="card fixed inset-x-0 top-[8vh] z-[100] mx-auto max-h-[84vh] w-[min(560px,94vw)] space-y-3 overflow-y-auto p-5">
          <p className="text-xs font-semibold text-waitInk" data-testid="ann-popup-kind">{t('annPopup.kind')}</p>
          <Dialog.Title className="text-lg font-bold" data-testid="ann-popup-title">{item.title}</Dialog.Title>
          <Dialog.Description className="text-sm text-mute" data-testid="ann-popup-meta">
            {/* bdi keeps a Latin name and the date from reordering inside Arabic text */}
            <bdi>{t('annPopup.from', { name: sender.display_name })}</bdi>{sender.employee_id ? <span className="mono ms-1 rounded bg-card2 px-1 text-xs">{sender.employee_id}</span> : null}
            {' · '}<bdi>{fmtDateTime(item.created_at, i18n.language)}</bdi>
            {(q.data?.length ?? 0) > 1 && <span className="ms-2" data-testid="ann-popup-more">{t('annPopup.more', { count: (q.data?.length ?? 1) - 1 })}</span>}
          </Dialog.Description>
          <div className="whitespace-pre-wrap break-words rounded-md bg-card2 p-3 text-sm" data-testid="ann-popup-body" dir="auto">{item.body}</div>
          {draft.mode === 'disagree' && (
            <div>
              <label htmlFor="ann-popup-note" className="text-sm font-semibold">{t('annPopup.note')}</label>
              <textarea id="ann-popup-note" data-testid="ann-popup-note" className="input mt-1 min-h-20" maxLength={2000} autoFocus value={draft.note} onChange={(e) => set({ note: e.target.value })} aria-describedby="ann-popup-note-hint" />
              <p id="ann-popup-note-hint" className="mt-1 text-xs text-mute">{t('annPopup.note_hint')}</p>
            </div>
          )}
          {err?.id === item.id && <p role="alert" data-testid="ann-popup-error" className="text-lateInk">{err.text}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            {draft.mode === 'ask' ? (
              <>
                <button className="btn" data-testid="ann-popup-disagree" onClick={() => set({ mode: 'disagree' })}>{t('annPopup.disagree')}</button>
                <button className="btn btn-accent" data-testid="ann-popup-agree" onClick={() => send('agree')}>{t('annPopup.agree')}</button>
              </>
            ) : (
              <>
                <button className="btn" data-testid="ann-popup-back" onClick={() => set({ mode: 'ask' })}>{t('annPopup.back')}</button>
                <button className="btn btn-accent" data-testid="ann-popup-submit" disabled={short} onClick={() => send('disagree')}>{t('annPopup.send_disagree')}</button>
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
