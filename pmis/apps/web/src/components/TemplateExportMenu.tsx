import * as Popover from '@radix-ui/react-popover';
import { ChevronDown, Download, FileDown, FileSpreadsheet, FileUp, ListChecks } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useExportColumns, useStartExport } from '@/api/admin';
import type { ExportPartKey } from '@/api/types';
import { exportError } from './ExportDialog';
import { useToast } from './Toast';

type Item = { id: string; label: string; icon: ReactNode; testid: string; disabled?: boolean; onSelect: () => void };

/**
 * One toolbar button for everything a table does with files: the blank template, the template filled with the current list (its filters and the
 * caller's permissions), the upload of a filled template, the export of the current view and the batches of the uploads. It takes the place of the
 * plain Export button, so the toolbar keeps its width. Every item keeps the test id it had as a button of its own (`${testid}-...`).
 */
export function TemplateExportMenu({ testid, exportTestid, source, filters, columns, sort, onBlank, onFilled, onUpload, onBatches, hasTemplate }: {
  testid: string; exportTestid: string; source: ExportPartKey; filters: Record<string, unknown>; columns: string[]; sort?: string;
  onBlank: () => void; onFilled: () => void; onUpload: () => void; onBatches?: () => void; hasTemplate: boolean;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const start = useStartExport();
  const offered = useExportColumns(source);
  const label = (k: string) => k;
  const items: Item[] = [
    { id: 'blank', label: t('registers.template_download'), icon: <FileDown size={16} />, testid: `${testid}-blank`, disabled: !hasTemplate, onSelect: onBlank },
    { id: 'filled', label: t('registers.template_prefill'), icon: <FileSpreadsheet size={16} />, testid: `${testid}-filled`, disabled: !hasTemplate, onSelect: onFilled },
    { id: 'upload', label: t('registers.template_upload'), icon: <FileUp size={16} />, testid: `${testid}-upload`, disabled: !hasTemplate, onSelect: onUpload },
    { id: 'export', label: t('export.view'), icon: <Download size={16} />, testid: exportTestid, disabled: start.isPending,
      onSelect: () => start.mutate({ view: { source, filters, columns: offered ? columns.filter((c) => offered.includes(c)) : columns, ...(sort ? { sort } : {}) } }, {
        onSuccess: () => toast(t('export.view_started')), onError: (e) => toast(exportError(e, t, label), 'err') }) },
    ...(onBatches ? [{ id: 'batches', label: t('registers.template_batches'), icon: <ListChecks size={16} />, testid: `${testid}-batches`, onSelect: onBatches }] : []),
  ];
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className="btn" data-testid={testid} aria-haspopup="menu"><FileSpreadsheet size={16} />{t('tplmenu.title')}<ChevronDown size={14} /></button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} role="menu" className="card z-50 min-w-56 p-1 shadow-lg" data-testid={`${testid}-panel`}>
          {items.map((i) => (
            <button key={i.id} type="button" role="menuitem" disabled={i.disabled} data-testid={i.testid}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-hover disabled:opacity-50" onClick={() => { setOpen(false); i.onSelect(); }}>{i.icon}{i.label}</button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
