import type { ReactNode } from 'react';
import { Printer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMe } from '@/api/hooks';
import { useDownloadGate } from '@/lib/downloadGate';

/**
 * The one A4 print layout for every report (Report Center, item 1). On screen it shows the content as is. On paper it shows the product name, the report title, the
 * filters used, who printed it and when, the content, and a footer with the page number. The sidebar and top bar are hidden by the print rules in index.css.
 * `orientation` picks A4 portrait or landscape for this sheet (named CSS pages); the dashboard keeps its own landscape rule. The print button honours the
 * admin "disable export" lock, like every other file the browser builds.
 */
export function PrintSheet({ title, filters, orientation = 'portrait', children, testId = 'print-sheet' }: { title: string; filters?: string[]; orientation?: 'portrait' | 'landscape'; children: ReactNode; testId?: string }) {
  const { t, i18n } = useTranslation();
  const me = useMe(true).data?.user;
  const when = new Date().toLocaleString(i18n.language === 'ar' ? 'ar' : 'en-GB');
  return (
    <section className="print-sheet" data-orientation={orientation} data-testid={testId}>
      <header className="print-only print-head" data-testid={`${testId}-head`}>
        <div className="print-brand">{t('app.name')}</div>
        <h1 className="print-title">{title}</h1>
        {filters && filters.length > 0 && <p className="print-filters" data-testid={`${testId}-filters`}>{t('print.filters')}: {filters.join(' | ')}</p>}
        <p className="print-meta">{t('print.printed_by', { name: me?.display_name ?? '', when })}</p>
      </header>
      {children}
      <footer className="print-only print-foot" data-testid={`${testId}-foot`}>{t('app.name')} | {title}</footer>
    </section>
  );
}

/** The button of the layout: opens the browser print dialog (choose "Save as PDF" there). Disabled with the reason when export is locked. */
export function PrintButton({ testId = 'print-button' }: { testId?: string }) {
  const { t } = useTranslation();
  const gate = useDownloadGate();
  return (
    <button type="button" className="btn print:hidden" data-testid={testId} disabled={gate.exportLocked} title={gate.exportLocked ? gate.note(true) : t('print.hint')} onClick={() => window.print()}>
      <Printer size={16} />{t('print.button')}
    </button>
  );
}
