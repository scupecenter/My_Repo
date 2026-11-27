import { useTranslation } from 'react-i18next';
import { useDocumentSearchIndex } from '@/api/documentSearchIndex';
import { QueryFallback } from '@/components/States';

const KEYS = ['indexed', 'pending', 'empty', 'unsupported', 'too_large', 'failed'] as const;

/**
 * Settings > Documents > Search index (item 12, contract 0.15.104). Read only, System Admin: how many files have searchable text. The text is
 * extracted in the background from clean-scan PDF and DOCX files; there is nothing to configure and nothing here changes a file.
 */
export function DocumentSearchIndex() {
  const { t, i18n } = useTranslation();
  const q = useDocumentSearchIndex();
  if (!q.data) return <QueryFallback queries={[q]} />;
  const d = q.data;
  return (
    <div className="space-y-4" data-testid="settings-document-search-index">
      <div><h2 className="font-bold">{t('dsi.title')}</h2><p className="text-sm text-mute">{t('dsi.note')}</p></div>
      <dl className="grid max-w-xl grid-cols-2 gap-2">
        {KEYS.map((k) => (
          <div key={k} className="card p-3" data-testid={`dsi-${k}`}>
            <dt className="text-sm text-mute">{t(`dsi.${k}`)}</dt>
            <dd className="text-xl font-bold">{d[k]}</dd>
          </div>))}
      </dl>
      <p className="text-sm text-mute" data-testid="dsi-last">{d.last_extracted_at ? t('dsi.last', { at: new Date(d.last_extracted_at).toLocaleString(i18n.language) }) : t('dsi.never')}</p>
    </div>
  );
}
