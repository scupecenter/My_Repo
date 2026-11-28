import * as Dialog from '@radix-ui/react-dialog';
import { PanelRightOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { RegisterDefinition, RegisterRecord } from '@/api/types';
import { fieldLabel, showValue } from './RegisterFields';
import { STATE_TONE } from './RegisterDrawer';

/**
 * Space on a focused row or card: a read-only summary of the record from the data the list already holds (no request), with a button to open the
 * full drawer. Space or Escape closes it again.
 */
export function RegisterQuickPreview({ def, record, onClose, onOpen }: { def: RegisterDefinition; record: RegisterRecord | null; onClose: () => void; onOpen: (id: string) => void }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  return (
    <Dialog.Root open={!!record} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-scrim/60" />
        <Dialog.Content data-testid="register-quick-preview" className="card fixed inset-x-0 top-[12%] z-[70] mx-auto max-h-[75vh] w-[min(520px,94vw)] space-y-3 overflow-y-auto p-5"
          onKeyDown={(e) => { if (e.key === ' ' && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); onClose(); } }}>
          <Dialog.Title className="flex flex-wrap items-center gap-2 font-bold">
            {record?.site_code && <span className="mono" dir="ltr">{record.site_code}</span>}
            {record && <span className={`chip ${STATE_TONE[record.state] ?? ''}`}>{t(`regState.${record.state}`)}</span>}
            {record?.locked && <span className="chip bg-hover">{t('registers.locked_badge')}</span>}
          </Dialog.Title>
          <Dialog.Description className="sr-only">{t('regviews.preview_hint')}</Dialog.Description>
          {record && (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm" data-testid="register-quick-preview-fields">
              {def.fields.filter((f) => f.in_list).map((f) => {
                const v = showValue(f, record.data[f.code], lang, t);
                return (<div key={f.code} className="contents"><dt className="text-mute">{fieldLabel(f, lang)}</dt><dd dir="auto">{v || '-'}</dd></div>);
              })}
            </dl>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-mute">{t('regviews.preview_hint')}</span>
            <div className="flex gap-2">
              <button type="button" className="btn" onClick={onClose}>{t('common.close')}</button>
              <button type="button" className="btn btn-primary" data-testid="register-quick-preview-open" onClick={() => { if (record) { const id = record.id; onClose(); onOpen(id); } }}><PanelRightOpen size={16} />{t('regviews.preview_open')}</button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
