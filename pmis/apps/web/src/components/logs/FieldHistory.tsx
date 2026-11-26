import * as Popover from '@radix-ui/react-popover';
import { ArrowRight, History } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMe } from '@/api/hooks';
import { useFieldHistory } from '@/api/logs';
import { PersonTag } from '@/components/PersonTag';
import { Tip } from '@/components/Tip';
import { fmtDateTime } from '@/lib/time';
import { hasGrant } from '@/lib/perm';
import { DeviceIcon, ViaChip, valueText } from './bits';

/** Whoever may read the Audit Log (B4): System Admins, the Project Manager and Team Leads (their effective view_audit), or a view_audit grant. */
export function useCanReadAudit() {
  const me = useMe(true);
  return hasGrant(me.data, 'view_audit');
}

/** A value the form can take back as is: a text, a number or a yes/no. Lists and objects are never offered for restore. */
const restorable = (v: unknown): v is string | number | boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

function Body({ entityType, entityId, field, onRestore }: { entityType: string; entityId: string; field: string; onRestore?: (value: unknown) => void }) {
  const { t, i18n } = useTranslation();
  const q = useFieldHistory(entityType, entityId, field, true);
  if (q.isLoading) return <p className="text-sm text-mute">{t('common.loading')}</p>;
  if (q.isError) return <p role="alert" className="text-sm text-lateInk">{t('errors.generic')}</p>;
  if (!q.data?.length) return <p className="text-sm text-mute" data-testid="fh-empty">{t('logs.fh_empty')}</p>;
  return (
    <ol className="max-h-72 space-y-2 overflow-y-auto" data-testid="fh-list">
      {q.data.map((c) => (
        <li key={c.id} className="rounded-md border border-line p-2 text-sm" data-testid={`fh-item-${c.id}`}>
          <div className="flex flex-wrap items-center gap-1 font-semibold" dir="auto">
            <span className="mono" data-testid={`fh-old-${c.id}`}>{valueText(c.old_value)}</span>
            <ArrowRight size={14} aria-hidden className="rtl:rotate-180" />
            <span className="mono" data-testid={`fh-new-${c.id}`}>{valueText(c.new_value)}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-mute">
            <PersonTag name={c.actor.name} employeeId={c.actor.employee_id} />
            <span dir="ltr">{fmtDateTime(c.at, i18n.language)}</span>
            <DeviceIcon device={c.device} testid={`fh-device-${c.id}`} />
            <ViaChip via={c.via} />
            {onRestore && restorable(c.old_value) && (
              <button type="button" className="btn ms-auto px-2 py-0.5 text-xs" data-testid={`fh-restore-${c.id}`} onClick={() => onRestore(c.old_value)}>{t('logs.fh_restore')}</button>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * Small history icon beside a field value. With `onRestore` (given only where the person may edit the field) each past value has a "Restore" button: it puts the old
 * value back into the open form as a draft. Nothing is saved by it; the person still saves through the normal door, with its checks and rights.
 */
export function FieldHistory({ entityType, entityId, field, label, onRestore }: { entityType: string; entityId: string | null | undefined; field: string; label?: string; onRestore?: (value: unknown) => void }) {
  const { t } = useTranslation();
  const can = useCanReadAudit();
  const [open, setOpen] = useState(false);
  if (!can || !entityId) return null;
  const name = t('logs.fh_open', { field: label ?? field });
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tip text={name}>
        <Popover.Trigger asChild>
          <button type="button" className="btn px-1.5 py-0.5" data-testid={`field-history-${field}`} aria-label={name}><History size={14} aria-hidden /></button>
        </Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} className="card z-[75] w-[min(24rem,92vw)] p-3 shadow-lg" data-testid="field-history-popover">
          <h4 className="mb-2 text-sm font-bold">{t('logs.fh_title', { field: label ?? field })}</h4>
          {open && <Body entityType={entityType} entityId={entityId} field={field} onRestore={onRestore ? (v) => { onRestore(v); setOpen(false); } : undefined} />}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
