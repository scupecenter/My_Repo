import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCompanyStatus } from '@/api/registers';

const BAD = new Set(['suspended', 'blacklisted']);

/**
 * K2b: a warning beside the company of an order when its status is Suspended or Blacklisted, with the reason and the date. Only a warning: new orders are
 * already blocked for such a company (its party is inactive), and nothing here changes a right.
 */
export function CompanyStatusWarning({ partyId }: { partyId: string | null | undefined }) {
  const { t } = useTranslation();
  const q = useCompanyStatus(partyId);
  const s = q.data?.status?.toLowerCase() ?? '';
  if (!BAD.has(s)) return null;
  return (
    <p role="alert" className="mt-1 flex items-start gap-2 rounded-md bg-waitBg p-2 text-sm text-waitInk" data-testid="company-status-warning">
      <TriangleAlert size={14} className="mt-0.5 shrink-0" />
      <span>{t(`companyStatus.warn_${s}`)}{q.data?.reason ? ` ${t('companyStatus.reason', { reason: q.data.reason })}` : ''}{q.data?.date ? ` ${t('companyStatus.since', { date: q.data.date })}` : ''}</span>
    </p>
  );
}
