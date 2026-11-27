import { useTranslation } from 'react-i18next';
import { useOpenRecordMode } from '@/lib/openRecordPref';

/**
 * Administration > Settings > Screens > Records (decision V5): where a register record opens when its row is clicked — in the
 * side drawer (the default) or on its own full page. Unlike the other sections of the tab this is a personal choice of whoever
 * opens the page, not an organization default: it is kept on the server in the person's own draft store (lib/openRecordPref), so
 * it follows them to any device, applies at once, and needs no admin rights, reason or audit row (the same treatment as the
 * remembered view of a screen).
 */
export function OpenRecordSettings() {
  const { t } = useTranslation();
  const [mode, setMode] = useOpenRecordMode();
  return (
    <section className="card space-y-4 p-4" data-testid="page-openrecord-settings">
      <div>
        <h2 className="font-bold">{t('openrec.title')}</h2>
        <p className="text-sm text-mute">{t('openrec.note')}</p>
      </div>
      <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={t('openrec.title')}>
        {(['drawer', 'page'] as const).map((x) => (
          <button key={x} type="button" role="radio" aria-checked={mode === x} data-testid={`open-record-mode-${x}`} onClick={() => setMode(x)} className={`btn px-2 py-1 text-xs ${mode === x ? 'bg-accentSoft text-accentText' : ''}`}>{t(`openrec.${x}`)}</button>
        ))}
      </div>
    </section>
  );
}
