import { Undo2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SlaWeightItem, WorkflowVersion } from '@/api/workflowEditor';
import { Code, Flow, ltr, Name } from '../wf/rtl';
import { Badge } from './StudioReview';
import type { Ctx, Writes } from './studioCtx';
import { undoPlan, type Change, type Struct, type UndoOp } from './studioModel';

type Cb = { onSuccess: () => void; onError: (e: unknown) => void };

/** Runs the write of an undo through the door the Studio already uses for that edit: the ETag of the version rides in If-Match, the reason and the step-up are asked by the caller. */
export function runUndo(W: Writes, op: UndoOp, reason: string, cb: Cb) {
  switch (op.door) {
    case 'msLight': return W.msLight.mutate({ ...op.body, reason }, cb);
    case 'gateLight': return W.gateLight.mutate({ ...op.body, reason }, cb);
    case 'updateTask': return W.updateTask.mutate({ ...op.body, reason }, cb);
    case 'setPreds': return W.setPreds.mutate({ ...op.body, reason }, cb);
    case 'setClosing': return W.setClosing.mutate({ ...op.body, reason }, cb);
    case 'saveSla': return W.saveSla.mutate({ ...op.body, reason }, cb);
    case 'removeSla': return W.removeSla.mutate({ ...op.body, reason }, cb);
    case 'setWeight': return W.setWeight.mutate({ ...op.body, reason }, cb);
    case 'removeItem': return W.removeItem.mutate({ ...op.body, reason }, cb);
    case 'replace': return W.replace.mutate({ ...op.body, reason }, cb);
  }
}

const structOf = (v: WorkflowVersion | undefined): Struct | null => (v ? { milestones: v.milestones as Struct['milestones'], gates: v.gates as Struct['gates'], placements: v.placements as Struct['placements'] } : null);

/** The side panel of the "N pending changes" button: every change of the draft against its parent version, each with an Undo that puts the parent value back (reason, step-up and If-Match like any write). An undo that the API cannot do is shown off, with the reason. */
export function StudioPending({ c, parent, parentSw, draftSw, changes, onClose }: { c: Ctx; parent: WorkflowVersion | undefined; parentSw: SlaWeightItem[]; draftSw: SlaWeightItem[]; changes: Change[]; onClose: () => void }) {
  const { t } = useTranslation();
  const closeRef = useRef<HTMLButtonElement>(null);
  // Optimistic: a row leaves the list as soon as its undo is sent (hidden for the ETag it was sent on) and comes back if the server refuses it.
  const [gone, setGone] = useState<ReadonlyMap<string, number>>(new Map());
  useEffect(() => { closeRef.current?.focus(); }, []);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('[role="dialog"]')) onClose(); }; document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k); }, [onClose]);
  const drafts = structOf(c.v), parents = structOf(parent);
  const shown = changes.filter((x) => gone.get(x.id) !== c.etag);
  const mark = (id: string, on: boolean) => setGone((s) => { const n = new Map(s); if (on) n.set(id, c.etag); else n.delete(id); return n; });

  return (
    <aside aria-label={t('studioPanel.title', { count: shown.length })} data-testid="studio-pending-panel" className="card fixed inset-y-0 end-0 z-[60] flex w-[min(440px,100vw)] flex-col rounded-none border-y-0 border-e-0 shadow-lg">
      <header className="flex items-center justify-between gap-2 border-b border-line p-4">
        <h2 className="text-base font-bold" data-testid="studio-pending-title">{t('studioPanel.title', { count: shown.length })}</h2>
        <button ref={closeRef} type="button" className="btn min-h-11 min-w-11 px-0" aria-label={t('studioPanel.close')} data-testid="studio-pending-close" onClick={onClose}><X size={16} aria-hidden /></button>
      </header>
      <p className="px-4 pt-3 text-xs text-mute">{t('studioPanel.sub', { parent: c.v.parent_version ?? '-' })}</p>
      <ul className="flex-1 divide-y divide-line overflow-y-auto p-4" data-testid="studio-pending-list">
        {shown.length === 0 && <li className="text-sm text-mute" data-testid="studio-pending-empty">{t('studioPanel.empty')}</li>}
        {shown.map((x) => {
          const plan = parents && drafts ? undoPlan(x, parents, drafts, parentSw, draftSw) : null;
          const noRight = plan?.ok ? (plan.needsStruct ? !c.can.struct : !c.can.edit) : false;
          const why = !plan ? t('wfe.loading') : !plan.ok ? t(`studioPanel.undo_no_${plan.why}`) : noRight ? c.can.why ?? t('wfe.readonly') : null;
          const label = t(`studio.change_${x.key}`);
          return (
            <li key={x.id} className="space-y-2 py-3 text-sm" data-testid={`studio-pending-${x.id}`}>
              <div className="flex flex-wrap items-center gap-2"><Badge kind={x.kind} /><span className="font-semibold">{label}</span>{x.code !== '*' && <Code>{x.code}</Code>}</div>
              {x.from !== undefined && x.to !== undefined ? <p className="text-mute" data-testid={`studio-pending-detail-${x.id}`}><Flow from={x.from} to={x.to} ltr={!!x.ltr} /></p>
                : x.detail ? <p className="text-mute"><Name>{x.detail}</Name></p> : null}
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className="btn min-h-11" data-testid={`studio-undo-${x.id}`} disabled={!!why || c.can.busy} aria-describedby={why ? `studio-undo-why-${x.id}` : undefined} title={why ?? undefined}
                  onClick={() => plan?.ok && c.askReason({
                    title: t('studioPanel.undo_title', { what: t(`studio.change_${x.key}`), code: x.code === '*' ? '' : ltr(x.code) }).trim(),
                    hint: t(`studioPanel.undo_hint_${plan.hint}`, { parent: c.v.parent_version ?? '-' }),
                    run: (reason, cb) => { mark(x.id, true); runUndo(c.W, plan.op, reason, { onSuccess: () => { cb.onSuccess(); }, onError: (e) => { mark(x.id, false); cb.onError(e); } }); },
                  })}><Undo2 size={14} aria-hidden />{t('studioPanel.undo')}</button>
                {why && <span id={`studio-undo-why-${x.id}`} className="text-xs text-mute" data-testid={`studio-undo-why-${x.id}`}>{why}</span>}
              </div>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
