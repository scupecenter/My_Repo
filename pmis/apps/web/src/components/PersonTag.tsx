import * as HoverCard from '@radix-ui/react-hover-card';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStaffCard } from '@/api/hooks';
import type { UserAccountStatus } from '@/api/types';

/** Name with the 4-digit employee ID beside it; hover or focus the ID for the registry card (visibility applied server-side). */
export function PersonTag({ name, employeeId, status }: { name: string; employeeId?: string | null; status?: UserAccountStatus }) {
  if (!employeeId) return <span>{name}</span>;
  return (
    <span className="inline-flex items-baseline gap-1">
      <span>{name}</span>
      <IdBadge employeeId={employeeId} />
      <AccountBadge status={status} employeeId={employeeId} />
    </span>
  );
}

/** B14: "deactivated" / "deleted" beside a person who still holds a task. Nothing for active accounts. */
export function AccountBadge({ status, employeeId }: { status?: UserAccountStatus; employeeId: string }) {
  const { t } = useTranslation();
  if (!status || status === 'active') return null;
  return <span className="chip bg-lockBg text-lockInk" data-testid={`holder-status-${employeeId}`}>{t(`holderStatus.${status}`)}</span>;
}

export function IdBadge({ employeeId }: { employeeId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <HoverCard.Root open={open} onOpenChange={setOpen} openDelay={150} closeDelay={100}>
      <HoverCard.Trigger asChild>
        <button type="button" data-testid={`person-id-${employeeId}`} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
          className="mono rounded bg-card2 px-1 text-xs text-mute hover:bg-hover">{employeeId}</button>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content data-testid="staff-card" sideOffset={6} className="card z-50 w-64 p-3 text-sm"><CardBody employeeId={employeeId} open={open} /></HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}

function Row({ k, v, id }: { k: string; v: string; id: string }) {
  return <div className="flex justify-between gap-2" data-testid={`card-${id}`}><span className="text-mute">{k}</span><span dir="auto" className="text-end">{v}</span></div>;
}

function CardBody({ employeeId, open }: { employeeId: string; open: boolean }) {
  const { t, i18n } = useTranslation();
  const q = useStaffCard(employeeId, open);
  if (q.isLoading) return <p>{t('card.loading')}</p>;
  if (!q.data) return <p>{t('card.unavailable')}</p>;
  const c = q.data;
  const hidden = t('card.hidden');
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 font-bold">
        {i18n.language === 'ar' ? c.name_ar : c.name_en} <span className="mono text-xs text-mute">{c.employee_id}</span>
        {c.status === 'inactive' && <span className="chip bg-lockBg text-lockInk">{t('card.inactive')}</span>}
      </div>
      <Row id="position" k={t('card.position')} v={c.position} />
      <Row id="region" k={t('card.region')} v={c.region} />
      <Row id="email" k={t('card.email')} v={c.hidden_fields.includes('email') || !c.email ? hidden : c.email} />
      <Row id="phone" k={t('card.phone')} v={c.hidden_fields.includes('phone') || !c.phone ? hidden : c.phone} />
    </div>
  );
}
