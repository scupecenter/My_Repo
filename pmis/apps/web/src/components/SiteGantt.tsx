import { useTranslation } from 'react-i18next';
import type { components } from '@/api/schema';
import { buildGantt, pos } from '@/lib/gantt';

type SiteDetail = components['schemas']['SiteDetail'];

/** Read-only timeline of the stages: baseline (hollow), planned (outline) and actual (filled) dates. No editing: a date changes only through the existing change and approval flow. */
export function SiteGantt({ site }: { site: SiteDetail }) {
  const { t, i18n } = useTranslation();
  const m = buildGantt(site.pipeline);
  if (!m) return null;
  const nm = (n: { name_en: string; name_ar?: string | null }) => (i18n.language === 'ar' && n.name_ar) || n.name_en;
  const dot = (d: number | null, cls: string, label: string) => d === null ? null : (
    <span key={label} title={label} className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full ${cls}`} style={{ insetInlineStart: `${pos(m, d)}%` }} />
  );
  return (
    <details className="card my-3 p-3" data-testid="site-gantt">
      <summary className="cursor-pointer text-sm font-semibold">{t('gantt.title')}</summary>
      <p className="mb-2 mt-1 text-xs text-mute">{t('gantt.legend')}</p>
      <ul className="space-y-1">
        {m.rows.map((r) => (
          <li key={r.code} className="flex items-center gap-2 text-sm" data-testid={`gantt-row-${r.code}`}>
            <span className="w-40 shrink-0 truncate">{nm(r.node)}</span>
            <span className="relative h-5 flex-1 rounded bg-card2" dir="ltr">
              {dot(r.baseline, 'border-2 border-mute bg-transparent', t('gantt.baseline'))}
              {dot(r.planned, 'border-2 border-accent bg-card', t('gantt.planned'))}
              {dot(r.actual, 'bg-accent', t('gantt.actual'))}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
