import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ApiError } from '@/api/client';
import { useListCatalogues } from '@/api/lists';
import { useColumnAdmin, useColumnDetails, useColumnSections, useDeactivateColumn, useDeleteColumn, useReactivateColumn, useUpdateColumn } from '@/api/siteMasterColumns';
import type { ColCtx } from './studio/studioCtx';
import { useAsk } from './studio/studioCtx';
import { colName, Dialogs, RowActions, type Dlg } from './studio/StudioColumns';

/** The six Site Master streams the Columns page lists (the Dismantle menu is a register of its own and is listed with the registers). */
export const STREAM_MENUS = ['design_acq', 'sow', 'cw', 'te', 'hoto', 'om'] as const;
export type StreamMenu = (typeof STREAM_MENUS)[number];
export const STREAM_PREFIX = 'stream:';
export const isStreamKey = (k: string) => k.startsWith(STREAM_PREFIX) && (STREAM_MENUS as readonly string[]).includes(k.slice(STREAM_PREFIX.length));

/**
 * Settings > Registers > Columns for a Site Master stream: the columns of the stream in Master order, with the same row actions and rules as the Workflow
 * Studio (rename, type, dropdown list, menus, hide, delete). Writes go through the same /site-master/columns endpoints: reason, step-up, version and audit unchanged.
 */
export function StreamColumns({ menu }: { menu: StreamMenu }) {
  const { t, i18n } = useTranslation();
  const ar = i18n.language === 'ar';
  const q = useColumnAdmin();
  const lists = useListCatalogues().data ?? [];
  const { askReason, node } = useAsk();
  const W = { colCreate: undefined as never, colUpdate: useUpdateColumn(), colDeactivate: useDeactivateColumn(), colReactivate: useReactivateColumn(), colDelete: useDeleteColumn(), colSections: useColumnSections() };
  const forbidden = q.error instanceof ApiError && q.error.status === 403;
  const c: ColCtx = { W, askReason, canCols: !forbidden };
  const cols = (q.data?.items ?? []).filter((x) => x.sections.includes(menu)).sort((a, b) => a.display_order - b.display_order);
  const details = useColumnDetails(cols.filter((x) => x.is_added && !x.is_protected).map((x) => x.ord)).data;
  const [dlg, setDlg] = useState<Dlg>(null);
  const listName = (code: string | null) => { const l = lists.find((x) => x.code === code); return l ? (ar && l.name_ar ? l.name_ar : l.name_en) : code; };
  return (
    <div className="space-y-2" data-testid={`stream-columns-${menu}`}>
      <p className="text-sm text-mute">{t('regcols.stream_note', { stream: t(`studio.columns.menu_${menu}`) })}{' '}
        <Link to="/admin/settings/workflow/editor" className="text-accentText underline" data-testid="stream-columns-add">{t('regcols.stream_add')}</Link></p>
      {q.isLoading && <p className="text-mute">{t('common.loading')}</p>}
      {q.isError && <p role="alert" className="text-lateInk">{forbidden ? t('studio.columns.no_access') : t('errors.generic')}</p>}
      {q.data && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="stream-columns-table" aria-label={t('studio.columns.menu_' + menu)}>
            <thead className="text-mute"><tr>
              {(['col', 'name', 'type', 'list', 'state'] as const).map((k) => <th key={k} scope="col" className="p-2 text-start">{t(`studio.columns.${k}`)}</th>)}
              <th className="p-2" />
            </tr></thead>
            <tbody>
              {cols.map((col) => (
                <tr key={col.ord} className={`border-t border-line ${col.is_active ? '' : 'opacity-60'}`} data-testid={`stream-col-row-${col.letter}`}>
                  <td className="mono p-2" dir="ltr">{col.letter}</td>
                  <td className="p-2">{colName(col, ar)}{col.is_protected && <span className="chip ms-2" title={col.protected_reason ?? undefined}>{t('studio.columns.protected')}</span>}</td>
                  <td className="p-2">{t(`studio.columns.type_${col.value_type}`)}</td>
                  <td className="p-2">{col.value_type === 'list' ? listName(col.list_catalogue) : ''}</td>
                  <td className="p-2">{t(col.is_active ? 'regcols.active' : 'regcols.inactive')}</td>
                  <td className="p-2 text-end"><RowActions c={c} col={col} del={details?.[col.ord]?.delete_mode === 'hard'} onDialog={(kind) => setDlg({ kind, col })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Dialogs c={c} dlg={dlg} onClose={() => setDlg(null)} />
      {node}
    </div>
  );
}
