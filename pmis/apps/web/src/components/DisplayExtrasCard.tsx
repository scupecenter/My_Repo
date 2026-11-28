import { useTranslation } from 'react-i18next';
import { setExtra, UI_EXTRAS, useExtra, type UiExtra } from '@/lib/uiExtras';

function Row({ k }: { k: UiExtra }) {
  const { t } = useTranslation();
  const on = useExtra(k);
  return (
    <label className="flex items-start gap-2 text-sm" title={t(`ui.extra_${k}_hint`)}>
      <input type="checkbox" className="mt-1" data-testid={`ui-extra-${k}`} checked={on} onChange={(e) => setExtra(k, e.target.checked)} />
      <span><span className="font-semibold">{t(`ui.extra_${k}`)}</span><span className="block text-xs text-mute">{t(`ui.extra_${k}_hint`)}</span></span>
    </label>
  );
}

/** Settings > Screens > Interface > "On this device": personal switches for the small display features. Anyone may change them; they affect only this browser. */
export function DisplayExtrasCard() {
  const { t } = useTranslation();
  return (
    <section className="card space-y-3 p-4" data-testid="ui-extras">
      <h2 className="text-base font-semibold">{t('ui.extras_title')}</h2>
      <p className="text-xs text-mute">{t('ui.extras_note')}</p>
      {UI_EXTRAS.map((k) => <Row key={k} k={k} />)}
    </section>
  );
}
