import { Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useEditPresence } from '@/api/presence';

/**
 * The soft "… is editing this …" notice (0.15.246, item 17): shown while another user has the same record or task open for editing.
 * Advisory only; the heartbeat of the caller starts here too, so other viewers of the entity see this caller. Never blocks anything.
 * Shared by the register record editor (kind `record`) and the task drawer (kind `task`).
 */
export function EditingNotice({ kind, id, editing, testid }: { kind: 'record' | 'task'; id: string; editing: boolean; testid: string }) {
  const { t } = useTranslation();
  const editors = useEditPresence(kind, id, editing).data ?? [];
  if (!editors.length) return null;
  return (
    <p className="flex items-center gap-2 rounded-md bg-waitBg p-3 text-sm text-waitInk" data-testid={testid} role="note">
      <Users size={14} aria-hidden />{t(`presence.editing_${kind}`, { names: editors.map((e) => e.display_name).join(t('presence.editing_join')), count: editors.length })}
    </p>
  );
}
