import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ApiError } from '@/api/client';
import { useSiteLinked } from '@/api/p4c';

/**
 * D60 phase 3: the Linked records tab of the Site page. For every register that has records at this site (and that the caller may see): the count, the latest
 * records and, for each, the records it points to through the declared links (table register_links). A register with no declared link is marked, so the gap
 * is visible. Read only: each row opens the record in its register.
 */
export function SiteLinkedRecords({ siteId }: { siteId: string }) {
  const { t, i18n } = useTranslation();
  const q = useSiteLinked(siteId);
  const denied = q.error instanceof ApiError && q.error.status === 403;
  if (q.isLoading) return <p className="text-mute" data-testid="site-linked-loading">{t('common.loading')}</p>;
  if (denied) return <p className="card p-6 text-mute" data-testid="site-linked-denied">{t('site.linked_denied')}</p>;
  if (q.isError) return <p role="alert" className="text-lateInk" data-testid="site-linked-error">{t('site.linked_failed')}</p>;
  const regs = q.data ?? [];
  if (regs.length === 0) return <p className="card p-6 text-mute" data-testid="site-linked-empty">{t('site.linked_empty')}</p>;
  const name = (r: (typeof regs)[number]) => (i18n.language === 'ar' && r.name_ar) || r.name_en;
  const nameOf = (key: string) => { const r = regs.find((x) => x.register_key === key); return r ? name(r) : key; };
  return (
    <div className="space-y-3" data-testid="site-linked">
      <p className="text-sm text-mute">{t('site.linked_hint')}</p>
      {regs.map((r) => (
        <section key={r.register_key} className="card space-y-2 p-3" data-testid={`site-linked-${r.register_key}`}>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{name(r)}</h3>
            <span className="chip" data-testid={`site-linked-count-${r.register_key}`}>{r.count}</span>
            {!r.linked && <span className="chip bg-lateBg text-lateInk" data-testid={`site-linked-orphan-${r.register_key}`}>{t('site.linked_no_links')}</span>}
            <Link className="ms-auto text-sm text-accentText underline" to={`/registers/${r.register_key}`}>{t('site.linked_open')}</Link>
          </div>
          <ul className="space-y-1 text-sm">
            {r.items.map((i) => (
              <li key={i.entity_id} data-testid={`site-linked-row-${r.register_key}`}>
                <Link className="font-semibold text-accentText underline" to={`/registers/${r.register_key}?record=${i.record_id ?? i.entity_id}`}>{i.title ?? i.entity_id.slice(0, 8)}</Link>
                {i.state && <span className="ms-2 text-mute">{t(`regState.${i.state}`, { defaultValue: i.state })}</span>}
                {i.links.map((l) => (
                  <span key={`${l.field}-${l.entity_id}`} className="ms-2 text-mute" data-testid="site-linked-link">
                    → {nameOf(l.target_register)}: <Link className="text-accentText underline" to={`/registers/${l.target_register}?record=${l.entity_id}`}>{l.label}</Link>
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
