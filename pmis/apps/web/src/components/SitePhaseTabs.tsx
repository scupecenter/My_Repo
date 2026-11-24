import { useTranslation } from 'react-i18next';
import { phaseLabel, type SitePhase } from '@/lib/sitePhases';

/**
 * The one phase row of the site page (W1, 2026-11-23): "All" first, then the phases of the site's workflow version in
 * their configured order. A phase with no task that applies to the site is disabled, with a tooltip. Left and Right
 * (mirrored in RTL) move between the enabled tabs.
 */
export function SitePhaseTabs({ phases, value, empty, onChange }: { phases: SitePhase[]; value: string; empty: (p: SitePhase) => boolean; onChange: (p: SitePhase | null) => void }) {
  const { t, i18n } = useTranslation();
  const tabs = [{ code: '', label: t('sites.stream_all'), phase: null as SitePhase | null, off: false }, ...phases.map((p) => ({ code: p.code, label: phaseLabel(t, i18n.language, p), phase: p, off: empty(p) }))];
  const move = (e: React.KeyboardEvent, k: number) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    const step = document.dir === 'rtl' ? -d : d;
    for (let n = 1; n < tabs.length; n += 1) {
      const j = (k + step * n + tabs.length * n) % tabs.length;
      if (tabs[j].off) continue;
      onChange(tabs[j].phase);
      (e.currentTarget.parentElement?.children[j] as HTMLElement | undefined)?.focus();
      return;
    }
  };
  return (
    <div role="tablist" aria-label={t('site.phases')} className="mb-3 mt-3 flex flex-wrap gap-1 border-b border-line" data-testid="site-phase-tabs">
      {tabs.map((x, k) => (
        <button key={x.code || 'ALL'} type="button" role="tab" aria-selected={value === x.code} aria-disabled={x.off || undefined} tabIndex={value === x.code ? 0 : -1}
          title={x.off ? t('site.phase_empty') : undefined} data-testid={`site-phase-tab-${x.code || 'ALL'}`} data-disabled={x.off ? 'true' : undefined}
          onClick={() => { if (!x.off) onChange(x.phase); }} onKeyDown={(e) => move(e, k)}
          className={`px-4 py-2 text-sm font-semibold ${value === x.code ? 'border-b-2 border-accent text-accentText' : 'text-mute'} ${x.off ? 'cursor-not-allowed opacity-50' : value === x.code ? '' : 'hover:text-ink'}`}>{x.label}</button>
      ))}
    </div>
  );
}
