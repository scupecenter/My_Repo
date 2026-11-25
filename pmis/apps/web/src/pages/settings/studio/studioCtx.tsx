import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useCreateTask, useDiscardDraft, useGateLight, useInsertTask, useMilestoneLight, usePublish, useRemoveItem, useReorderTasks, useRemoveSlaRule, useReplaceStructure, useSaveSlaRule, useSetClosing, useSetWeight, useSetPredecessors, useSetSuccessors, useUpdateTask,
  type SlaWeightItem, type WeightTotal, type WorkflowVersion,
} from '@/api/workflowEditor';
import { useColumnSections, useCreateColumn, useDeactivateColumn, useDeleteColumn, useReactivateColumn, useUpdateColumn } from '@/api/site360Columns';
import { useToast } from '@/components/Toast';
import { ReasonDialog } from '../wf/Forms';
import type { Can, G, M, P } from '../wf/model';
import { ColError } from './colErr';
import { useErr } from '../wf/useErr';
import type { StudioSel } from './studioModel';

/** Every write hook of the workflow editor for one version, with the ETag of the version as read (If-Match). */
export function useWrites(version: number, etag: number) {
  return {
    createTask: useCreateTask(version, etag), updateTask: useUpdateTask(version, etag), setPreds: useSetPredecessors(version, etag), setSuccs: useSetSuccessors(version, etag), setClosing: useSetClosing(version, etag),
    insertTask: useInsertTask(version, etag), replace: useReplaceStructure(version, etag), reorder: useReorderTasks(version, etag), msLight: useMilestoneLight(version, etag), gateLight: useGateLight(version, etag),
    saveSla: useSaveSlaRule(version, etag), removeSla: useRemoveSlaRule(version, etag), setWeight: useSetWeight(version, etag), publish: usePublish(version, etag), removeItem: useRemoveItem(version, etag), discard: useDiscardDraft(version, etag),
    // S3: the Site Master columns (contract 0.15.43); each write carries the column's own version as If-Match, not the workflow's
    colCreate: useCreateColumn(), colUpdate: useUpdateColumn(), colDeactivate: useDeactivateColumn(), colReactivate: useReactivateColumn(), colDelete: useDeleteColumn(), colSections: useColumnSections(),
  };
}
export type Writes = ReturnType<typeof useWrites>;
/** What the Site Master column rows need: the column writes and the reason question. The Studio and Settings > Registers > Columns both provide it. */
export type ColCtx = { W: Pick<Writes, 'colCreate' | 'colUpdate' | 'colDeactivate' | 'colReactivate' | 'colDelete' | 'colSections'>; askReason: (a: Ask) => void; canCols: boolean };
export type Ask = { title: string; hint?: string; run: (reason: string, cb: { onSuccess: () => void; onError: (e: unknown) => void }) => void; children?: React.ReactNode; disabled?: boolean };

/** The one question every write asks (the reason, then the step-up the client opens by itself): the same rule as the classic editor. */
export function useAsk() {
  const { t } = useTranslation();
  const toast = useToast();
  const err = useErr();
  const [ask, setAsk] = useState<Ask | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const askReason = (a: Ask) => { setError(null); setBusy(false); setAsk(a); };
  const node = ask ? (
    <ReasonDialog title={ask.title} hint={ask.hint} onClose={() => setAsk(null)} busy={busy} error={error} testid="studio-reason-dialog"
      onSubmit={(reason) => { setBusy(true); ask.run(reason, { onSuccess: () => { toast(t('wfe.saved')); setAsk(null); setBusy(false); }, onError: (e) => { setError(e instanceof ColError ? e.message : err(e)); setBusy(false); } }); }}>
      {ask.children}
    </ReasonDialog>
  ) : null;
  return { askReason, node };
}

export type Ctx = {
  v: WorkflowVersion; etag: number; placements: P[]; milestones: M[]; gates: G[]; can: Can; W: Writes; askReason: (a: Ask) => void;
  nm: (x: { name_en?: string; name_ar?: string | null }) => string; sw: Map<string, SlaWeightItem>; baseSw: Map<string, SlaWeightItem> | null; totals: WeightTotal[];
  edited: ReadonlySet<string>; select: (s: StudioSel) => void; isDraft: boolean;
  /** S3: the Site Master columns are not part of the draft: they are written at once, by a System Admin (or a `fields` delegate: the server decides). */
  canCols: boolean; addColumn: (taskCode?: string) => void;
};
