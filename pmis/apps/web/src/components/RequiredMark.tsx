import { useTranslation } from 'react-i18next';

/** The one required-field marker: a red asterisk after the label, with a hover hint. Decorative for screen readers (the input carries aria-required). */
export function RequiredMark() {
  const { t } = useTranslation();
  return <span className="ms-1 text-lateInk" title={t('drawer.mandatory')} aria-hidden="true" data-testid="required-mark">*</span>;
}
