import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useContractorCompanies } from '@/api/registers';
import { CompanyComplianceChip, CompanyContactsDocuments } from '@/components/CompanyContactsDocuments';

/** /companies/:id (Companies K3): the contacts and the documents of a company. The full company page (K1/K2) takes these as tabs. */
export function CompanyRecords() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const companies = useContractorCompanies(true);
  const name = companies.data?.find((c) => c.id === id)?.name ?? t('companyDocs.company');
  return (
    <main className="space-y-4 p-4" data-testid="page-company-records">
      <h1 className="flex items-center gap-3 text-xl font-bold">{name}<CompanyComplianceChip party={id} /></h1>
      <CompanyContactsDocuments party={id} canEdit />
    </main>
  );
}
