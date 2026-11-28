import * as Popover from '@radix-ui/react-popover';
import { ChevronDown, FilePlus2, Plus, Upload } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The New button of a register page, split in two: the main part starts a blank record (as before); the arrow offers the second way in, importing rows
 * from the register's template. With no template for this register the second entry stays visible but off, and says why.
 */
export function SplitNewButton({ onNew, onImport, canImport, testid = 'register-new' }: { onNew: () => void; onImport: () => void; canImport: boolean; testid?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="inline-flex" data-testid={`${testid}-split`}>
      <button type="button" className="btn btn-primary rounded-e-none" data-testid={testid} onClick={onNew}><Plus size={16} />{t('registers.new')}</button>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button type="button" className="btn btn-primary rounded-s-none border-s border-accentInk/30 px-2" data-testid={`${testid}-more`} aria-label={t('registers.new_more')}><ChevronDown size={16} aria-hidden /></button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content align="end" sideOffset={4} className="card z-50 w-64 space-y-1 p-1" data-testid={`${testid}-menu`}>
            <button type="button" className="flex w-full items-center gap-2 rounded px-2 py-2 text-start text-sm hover:bg-hover" data-testid={`${testid}-blank`} onClick={() => { setOpen(false); onNew(); }}><FilePlus2 size={16} aria-hidden />{t('registers.new_blank')}</button>
            <button type="button" disabled={!canImport} aria-describedby={canImport ? undefined : `${testid}-why`} className="flex w-full items-center gap-2 rounded px-2 py-2 text-start text-sm hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50" data-testid={`${testid}-import`} onClick={() => { setOpen(false); onImport(); }}><Upload size={16} aria-hidden />{t('registers.new_import')}</button>
            {!canImport && <p id={`${testid}-why`} className="px-2 pb-1 text-xs text-mute" data-testid={`${testid}-import-why`}>{t('registers.new_import_off')}</p>}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
