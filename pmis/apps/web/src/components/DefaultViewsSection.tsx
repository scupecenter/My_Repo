import { Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useDefaultViewOps, useDefaultViews } from '@/api/views';
import { errText } from './FormDialog';
import { useToast } from './Toast';
import { Tip } from './Tip';

/**
 * My profile > Default views: every screen where I made a saved view my default, with the view's name and a reset. The default itself is chosen on the
 * screen (the star next to the views); it opens by itself when the screen is opened without a filter of its own. A deactivated or unreadable view drops
 * out here and the screen opens on its built-in view. Personal; nothing here is shared.
 */
export function DefaultViewsSection() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useDefaultViews();
  const ops = useDefaultViewOps();
  const items = q.data ?? [];
  return (
    <section className="card space-y-3 p-4" aria-labelledby="default-views-title" data-testid="profile-default-views">
      <h2 id="default-views-title" className="flex items-center gap-2 text-lg font-bold"><Star size={18} aria-hidden />{t('dv.title')}</h2>
      <p className="text-sm text-mute">{t('dv.hint')}</p>
      {items.length === 0
        ? <p className="text-sm" data-testid="dv-empty">{t('dv.none')}</p>
        : (
          <ul>
            {items.map((d) => (
              <li key={d.screen_key} className="flex items-center gap-2 border-b border-line py-2 text-sm last:border-0" data-testid={`dv-row-${d.screen_key}`}>
                <span className="mono min-w-0 flex-1 truncate" dir="ltr">{d.screen_key}</span>
                <b className="truncate">{d.name}</b>
                <Tip text={t('dv.reset_hint')}>
                  <button type="button" className="btn px-2 py-1 text-xs" data-testid={`dv-reset-${d.screen_key}`} aria-label={`${d.screen_key}: ${t('dv.reset')}`} disabled={ops.clear.isPending}
                    onClick={() => ops.clear.mutate(d.view_id, { onSuccess: () => toast(t('savedViews.default_cleared')), onError: (e) => toast(errText(e, t), 'err') })}>{t('dv.reset')}</button>
                </Tip>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}
