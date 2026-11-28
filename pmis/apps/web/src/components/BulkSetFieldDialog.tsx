import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RegisterField } from '@/api/types';
import { FieldInput, fieldLabel } from './RegisterFields';


/**
 * Bulk edit on a register: one field, one value, applied to every selected record through the same edit path as the drawer (If-Match, field rules,
 * locks). The caller runs the loop and reports who was refused, like the bulk lock and void.
 */
export function BulkSetFieldDialog({ open, count, fields, onClose, onApply }: { open: boolean; count: number; fields: RegisterField[]; onClose: () => void; onApply: (code: string, value: unknown) => void }) {
  const { t, i18n } = useTranslation();
  const [code, setCode] = useState('');
  const [value, setValue] = useState<unknown>('');
  const field = fields.find((f) => f.code === code);
  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-scrim/60" />
        <Dialog.Content data-testid="bulk-set-dialog" className="card fixed inset-x-0 top-1/4 z-[70] mx-auto w-[min(460px,92vw)] space-y-3 p-5">
          <Dialog.Title className="font-bold">{t('registers.bulk_set_title', { count })}</Dialog.Title>
          <Dialog.Description className="text-sm text-mute">{t('registers.bulk_set_hint')}</Dialog.Description>
          <label htmlFor="bulk-set-field" className="text-sm font-semibold">{t('registers.bulk_set_field')}</label>
          <select id="bulk-set-field" data-testid="bulk-set-field" className="input" value={code} onChange={(e) => { setCode(e.target.value); setValue(''); }}>
            <option value="">{t('registers.bulk_set_pick')}</option>
            {fields.map((f) => <option key={f.code} value={f.code}>{fieldLabel(f, i18n.language)}</option>)}
          </select>
          {field && <div data-testid="bulk-set-value"><FieldInput field={field} value={value} onChange={setValue} /></div>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
            <button type="button" className="btn btn-primary" data-testid="bulk-set-apply" disabled={!field} onClick={() => field && onApply(field.code, value === '' ? null : value)}>{t('registers.bulk_set_apply', { count })}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
