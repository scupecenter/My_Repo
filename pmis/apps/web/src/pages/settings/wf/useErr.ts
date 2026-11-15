import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { errText } from '@/components/FormDialog';
import { fieldErrors } from '@/lib/fields';

/** The text of a failed write: a field error of the workflow editor first (cycle, self, unknown...), then the freeze, then the generic texts. */
export function useErr() {
  const { t } = useTranslation();
  return (e: unknown): string => {
    if (e instanceof ApiError) {
      if (e.code === 'master_impact_unconfirmed') return t('wfe.err.master_impact_unconfirmed');
      if (e.code === 'freeze_active') return t('wfe.err.freeze_active');
      if (e.code === 'workflow_invalid') return `${t('wfe.err.workflow_invalid')} ${((e.problem as { problems?: string[] }).problems ?? []).join('; ')}`;
      const first = Object.values(fieldErrors(e))[0];
      if (first && t(`wfe.err.${first}`) !== `wfe.err.${first}`) return t(`wfe.err.${first}`);
    }
    return errText(e, t);
  };
}
