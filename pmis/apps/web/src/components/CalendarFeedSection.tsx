import { CalendarDays, Copy } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { feedUrl, useMyCalendarFeed, useRevokeCalendarFeed, useSetCalendarFeed } from '@/api/calendarFeed';
import { Tip } from '@/components/Tip';

/**
 * Profile > My calendar feed (D4, contract 0.15.460). A private link a calendar app subscribes to: it lists only my own dated items (my planned
 * dates and my permit expiries). Off until I turn it on; the link is shown once, can be replaced (the old one stops at once) or turned off.
 */
export function CalendarFeedSection() {
  const { t } = useTranslation();
  const q = useMyCalendarFeed();
  const set = useSetCalendarFeed();
  const revoke = useRevokeCalendarFeed();
  const [link, setLink] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const on = q.data?.enabled === true;

  const make = async () => {
    setErr(null); setNote(null);
    try { const r = await set.mutateAsync(); setLink(feedUrl(r.path)); } catch { setErr(t('calFeed.failed')); }
  };
  const off = async () => {
    setErr(null); setNote(null);
    try { await revoke.mutateAsync(); setLink(null); } catch { setErr(t('calFeed.failed')); }
  };
  const copy = () => { void navigator.clipboard?.writeText(link ?? '').then(() => setNote(t('calFeed.copied'))).catch(() => setErr(t('calFeed.failed'))); };

  return (
    <section className="card space-y-2 p-4" id="calendar-feed" data-testid="profile-calfeed">
      <h2 className="flex items-center gap-2 font-bold"><CalendarDays size={18} aria-hidden />{t('calFeed.title')}</h2>
      <p className="text-sm text-mute">{t('calFeed.note')}</p>
      {q.data && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm" data-testid="calfeed-state">{on ? t('calFeed.on') : t('calFeed.off')}</span>
          {on
            ? <>
              <button type="button" className="btn" data-testid="calfeed-rotate" onClick={() => void make()}>{t('calFeed.rotate')}</button>
              <button type="button" className="btn" data-testid="calfeed-disable" onClick={() => void off()}>{t('calFeed.disable')}</button>
            </>
            : <button type="button" className="btn btn-accent" data-testid="calfeed-enable" onClick={() => void make()}>{t('calFeed.enable')}</button>}
        </div>)}
      {on && q.data?.last_read_at && <p className="text-xs text-mute" data-testid="calfeed-last">{t('calFeed.last_read')} <bdi>{new Date(q.data.last_read_at).toLocaleString()}</bdi></p>}
      {link && (
        <div className="space-y-1" data-testid="calfeed-link-box">
          <p className="text-sm font-semibold">{t('calFeed.once')}</p>
          <div className="flex items-center gap-2">
            <input readOnly dir="ltr" className="input w-full font-mono text-xs" value={link} aria-label={t('calFeed.link')} data-testid="calfeed-link" onFocus={(e) => e.currentTarget.select()} />
            <Tip text={t('calFeed.copy')}><button type="button" className="btn" aria-label={t('calFeed.copy')} data-testid="calfeed-copy" onClick={copy}><Copy size={16} aria-hidden /></button></Tip>
          </div>
        </div>)}
      {note && <p role="status" className="text-sm" data-testid="calfeed-note">{note}</p>}
      {err && <p role="alert" className="text-sm text-danger" data-testid="calfeed-error">{err}</p>}
    </section>
  );
}
