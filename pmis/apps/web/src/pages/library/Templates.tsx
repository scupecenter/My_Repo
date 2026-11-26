import { useTranslation } from 'react-i18next';
import { useLibraryForms } from '@/api/library';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState, QueryFallback } from '@/components/States';
import { FormTemplates } from '@/pages/settings/FormTemplates';
import { LibraryTabs } from './LibraryTabs';

/**
 * Library > Templates: create, edit (a new version), preview, approve and retire the document templates. The same screens and the same server doors as
 * Settings > Documents > Form templates (the rights are unchanged: System Admin or an all-regions delegate of the Document Library); this is where they live now.
 */
export function LibraryTemplates() {
  const { t } = useTranslation();
  const forms = useLibraryForms();
  return (
    <div data-testid="page-library-templates">
      <PageHeader title={t('lib.templates_title')} subtitle={t('lib.templates_sub')} />
      <LibraryTabs />
      {!forms.data ? <QueryFallback queries={[forms]} /> : !forms.data.can_configure ? <EmptyState testid="lib-templates-denied" title={t('lib.templates_denied')} /> : <FormTemplates />}
    </div>
  );
}
