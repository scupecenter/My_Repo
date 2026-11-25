import { useTranslation } from 'react-i18next';
import { useToast } from '@/components/Toast';
import { BatchEditBar } from '@/components/BatchEditBar';
import { SitesWideTable, type WideEdit, type WideRow } from '@/components/SitesWideTable';
import { useBatchEdit } from '@/lib/useBatchEdit';
import type { SiteMasterMenuItem } from '@/api/siteMaster';

type Cell = { task_id: string; version: number; field?: string; values?: unknown };
export type SiteCellSave = (a: { task_id: string; version: number; field: never; values: never; value: string | number | boolean }) => Promise<unknown>;

/** What the cell holds before the edit, in the type of the new value, so putting the old value back removes the edit from the draft. */
const typed = (from: string | null | undefined, like: unknown): unknown => (typeof like === 'number' ? (from === null || from === undefined || from === '' ? null : Number(from)) : typeof like === 'boolean' ? /^(true|yes|1)$/i.test(from ?? '') : (from ?? ''));

/**
 * Batch edit of the Site Master wide table (owner request, P4): the cell edits wait in a draft (pending chip, one bar with Review, Save all and Discard all)
 * and are saved one cell at a time through the same PATCH /tasks/{task_id} as a single edit, with the version the edit started from. A cell whose task
 * changed in the meantime is a conflict and stays in the draft. The draft is per menu (the parent gives this component a key per menu).
 */
export function SitesWideBatch({ menu, rows, onSave, errorText, columnLabel, ...table }: {
  menu: SiteMasterMenuItem; rows: WideRow[]; onSave: SiteCellSave; errorText: (e: unknown) => string; columnLabel: (ord: string) => string;
  display?: React.ComponentProps<typeof SitesWideTable>['display']; sel: string; height: number; loaded: boolean; filtered: boolean; onClear: () => void; busy?: boolean;
  picked: Set<string>; onPick: (code: string) => void; onPickAll: () => void; hasMore: boolean; loadingMore: boolean; onMore: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const batch = useBatchEdit<{ id: string; version: number }>(`sites-${menu.key}`, true, () => toast(t('batchedit.resumed')));
  const cellOf = (taskId: string, ord: string): Cell | undefined => { for (const r of rows) { const c = r.cells?.[ord]; if (c && c.task_id === taskId) return c as Cell; } return undefined; };
  const taskOf = (id: string): { id: string; version: number } | undefined => { for (const r of rows) for (const c of Object.values(r.cells ?? {})) if (c.task_id === id) return { id, version: c.version }; return undefined; };
  const edit = async (e: WideEdit) => {
    if (!batch.on) return onSave({ task_id: e.target.task_id, version: e.target.version, field: e.target.field as never, values: e.target.values as never, value: e.value });
    batch.edit({ id: e.target.task_id, version: e.target.version }, e.row.site_code, String(e.ord), typed(e.row.values[String(e.ord)], e.value), e.value);
    return undefined;
  };
  const pending = batch.on ? Object.fromEntries(Object.entries(batch.draft.changes).map(([id, r]) => [id, r.set])) : undefined;
  return (
    <div className="space-y-2">
      <div className="space-y-2">
        {!batch.on ? (
          <button type="button" className="btn" data-testid="batch-start" onClick={() => batch.setOn(true)}>{t('batchedit.start')}</button>
        ) : (
          <BatchEditBar
            draft={batch.draft} results={batch.results} busy={batch.busy}
            fieldLabel={columnLabel} valueText={(_c, v) => (v === null || v === undefined ? '' : String(v))}
            onSave={() => void batch.saveAll(taskOf, async (live, data) => {
              for (const [ord, value] of Object.entries(data)) {
                const c = cellOf(live.id, ord);
                if (!c) throw new Error('missing');
                await onSave({ task_id: c.task_id, version: c.version, field: c.field as never, values: c.values as never, value: value as string | number | boolean });
              }
            }, errorText).then((out) => { const ok = out.filter((o) => o.status === 'saved').length; if (ok) toast(t('batchedit.saved_n', { count: ok })); })}
            onDiscard={batch.discard} onExit={() => batch.setOn(false)}
          />
        )}
      </div>
      <SitesWideTable menu={menu} rows={rows} pending={pending} onEdit={edit} {...table} />
    </div>
  );
}
