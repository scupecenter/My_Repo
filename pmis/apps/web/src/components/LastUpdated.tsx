import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useExtra } from '@/lib/uiExtras';
import { Tip } from './Tip';

/** Background and personal queries that say nothing about how fresh the page's own data is. */
const SKIP = /^(me|session|notif|thread|message|announcement|nav|ui|settings|default-views|saved-views|field|layout|screen|auth|push|health)/i;

/** When the data shown on the page was last loaded: the newest successful, observed query that is not one of the background ones. 0 when there is none. */
export function pageDataStamp(qc: QueryClient): number {
  let at = 0;
  for (const q of qc.getQueryCache().findAll({ type: 'active' })) {
    const k = String(q.queryKey[0] ?? '');
    if (SKIP.test(k) || q.state.status !== 'success') continue;
    if (q.state.dataUpdatedAt > at) at = q.state.dataUpdatedAt;
  }
  return at;
}

/** "Updated 3 min ago": minutes below an hour, then hours, then the clock time. Pure so it can be tested. */
export function ageText(ms: number, lang: string, tNow: string): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 45) return tNow;
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'always', style: 'short' });
  if (s < 3600) return rtf.format(-Math.max(1, Math.round(s / 60)), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  return rtf.format(-Math.round(s / 86400), 'day');
}

/**
 * "Updated X min ago" + a refresh button in the page header (dashboard, lists, registers: every page with a PageHeader). Reads the query cache, so no page
 * wires anything; the button refetches the queries the page is showing. A person can switch it off in Settings > Screens > Interface > "On this device".
 */
export function LastUpdated() {
  const { t, i18n } = useTranslation();
  const on = useExtra('last_updated');
  const qc = useQueryClient();
  const [stamp, setStamp] = useState(() => pageDataStamp(qc));
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!on) return;
    const un = qc.getQueryCache().subscribe(() => { setStamp(pageDataStamp(qc)); setNow(Date.now()); });
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => { un(); window.clearInterval(id); };
  }, [on, qc]);
  if (!on || !stamp) return null;
  const refresh = () => {
    setBusy(true);
    const skip = (q: { queryKey: readonly unknown[] }) => SKIP.test(String(q.queryKey[0] ?? ''));
    void qc.refetchQueries({ type: 'active', predicate: (q) => !skip(q) }).finally(() => setBusy(false));
  };
  const text = ageText(now - stamp, i18n.language, t('lu.now'));
  return (
    <span className="flex items-center gap-1 text-xs text-mute" data-testid="last-updated">
      <span role="status" aria-live="polite" data-testid="last-updated-text" title={new Date(stamp).toLocaleString(i18n.language)}>{t('lu.updated', { when: text })}</span>
      <Tip text={t('lu.refresh')}>
        <button type="button" className="btn px-1.5 py-1" aria-label={t('lu.refresh')} data-testid="last-updated-refresh" disabled={busy} onClick={refresh}>
          <RefreshCw size={12} aria-hidden className={busy ? 'animate-spin' : ''} />
        </button>
      </Tip>
    </span>
  );
}
