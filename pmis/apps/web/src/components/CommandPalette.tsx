import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

export function CommandPalette({ open, onOpenChange, items }: { open: boolean; onOpenChange: (o: boolean) => void; items: { key: string; to: string }[] }) {
  const { t } = useTranslation();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const list = items.filter((i) => t(`nav.${i.key}`).toLowerCase().includes(q.toLowerCase()));
  const go = (to: string) => { onOpenChange(false); setQ(''); nav(to); };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-scrim/60" />
        <Dialog.Content data-testid="palette" className="card fixed inset-x-0 top-24 z-50 mx-auto w-[min(520px,92vw)] p-3">
          <Dialog.Title className="sr-only">{t('palette.title')}</Dialog.Title>
          <Dialog.Description className="sr-only">{t('palette.placeholder')}</Dialog.Description>
          <input autoFocus className="input" data-testid="palette-input" placeholder={t('palette.placeholder')} value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && list[0]) go(list[0].to); }} />
          <ul className="mt-2">
            {list.map((i) => <li key={i.key}><button data-testid={`palette-${i.key}`} className="w-full rounded-md p-2 text-start hover:bg-hover" onClick={() => go(i.to)}>{t(`nav.${i.key}`)}</button></li>)}
            {!list.length && <li className="p-2 text-mute">{t('palette.empty')}</li>}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
