import * as HoverCard from '@radix-ui/react-hover-card';
import { Shield, User, Users, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MatrixAssignee } from '@/api/types';
import { AccountBadge, IdBadge } from './PersonTag';

const ICON = { user: User, role: Shield, group: Users } as const;
const TONE = { user: 'bg-openBg text-openInk', role: 'bg-doneBg text-doneInk', group: 'bg-waitBg text-waitInk' } as const;

/** A holder of a level: users show the 4-digit ID (registry card on hover); roles and groups show a small card. */
export function HolderChip({ a, onRemove }: { a: MatrixAssignee; onRemove?: () => void }) {
  const { t } = useTranslation();
  const Icon = ICON[a.kind];
  return (
    <span className={`chip gap-1 ${TONE[a.kind]}`} data-testid={`holder-${a.kind}-${a.employee_id ?? a.ref_id}`}>
      <Icon size={12} aria-hidden />
      {a.kind === 'user' ? (
        <><span>{a.label}</span>{a.employee_id && <><IdBadge employeeId={a.employee_id} /><AccountBadge status={a.account_status} employeeId={a.employee_id} /></>}</>
      ) : (
        <HoverCard.Root openDelay={150}>
          <HoverCard.Trigger asChild><button type="button" className="font-semibold">{a.label}</button></HoverCard.Trigger>
          <HoverCard.Portal>
            <HoverCard.Content sideOffset={6} className="card z-50 w-56 p-3 text-sm" data-testid="holder-card">
              <b>{a.label}</b><div className="text-mute">{t(`holder.${a.kind}`)}</div>
            </HoverCard.Content>
          </HoverCard.Portal>
        </HoverCard.Root>
      )}
      {onRemove && <button type="button" aria-label={t('matrix.remove', { name: a.label })} data-testid={`holder-remove-${a.ref_id}`} onClick={onRemove}><X size={12} /></button>}
    </span>
  );
}

export function Holders({ holders }: { holders: MatrixAssignee[] }) {
  if (!holders.length) return <span className="text-mute">—</span>;
  return <span className="flex flex-wrap gap-1">{holders.map((h) => <HolderChip key={h.ref_id} a={h} />)}</span>;
}
