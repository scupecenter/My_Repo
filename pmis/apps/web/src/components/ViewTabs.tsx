import { useTranslation } from 'react-i18next';
import { DEFAULT_VIEWS, viewName } from '@/lib/streams';
import type { ViewRef } from '@/api/types';

/** The CW / TE / O&M tabs of the Site Register (Q98): "All work" first, then the API views. Left/Right (mirrored in RTL) move between tabs. */
export function ViewTabs({ views, value, onChange, testid }: { views: ViewRef[] | undefined; value: string; onChange: (code: string) => void; testid: string }) {
  const { t, i18n } = useTranslation();
  const list = views?.length ? [...views].sort((a, b) => a.sort_order - b.sort_order) : DEFAULT_VIEWS;
  const tabs = [{ code: '', label: t('sites.view_all') }, ...list.map((v) => ({ code: v.code, label: viewName(i18n.language, v) }))];
  const move = (e: React.KeyboardEvent, k: number) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    const to = tabs[(k + (document.dir === 'rtl' ? -d : d) + tabs.length) % tabs.length];
    onChange(to.code);
    (e.currentTarget.parentElement?.children[tabs.indexOf(to)] as HTMLElement | undefined)?.focus();
  };
  return (
    <div role="tablist" aria-label={t('sites.views_label')} className="mb-3 flex flex-wrap gap-1 border-b border-line" data-testid={testid}>
      {tabs.map((v, k) => (
        <button key={v.code || 'ALL'} role="tab" aria-selected={value === v.code} tabIndex={value === v.code ? 0 : -1} data-testid={`${testid}-${v.code || 'ALL'}`} onClick={() => onChange(v.code)} onKeyDown={(e) => move(e, k)}
          className={`px-4 py-2 text-sm font-semibold ${value === v.code ? 'border-b-2 border-accent text-accentText' : 'text-mute hover:text-ink'}`}>{v.label}</button>
      ))}
    </div>
  );
}
