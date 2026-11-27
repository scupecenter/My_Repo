import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useRelatedRecords } from '@/api/p4c';

/** 0216: the records this record names and the records that name it, read from the link fields (one reader on the server, nothing stored).
 *  Shown only when there is something to show; a group the caller may not read is not sent. */
export function RelatedRecords({ registerKey, entityId }: { registerKey: string; entityId: string }) {
  const { t } = useTranslation();
  const q = useRelatedRecords(registerKey, entityId);
  const groups = q.data ?? [];
  if (q.isError || groups.length === 0) return null;
  return (
    <section aria-labelledby="rs-related" data-testid="reg-section-related" className="space-y-2">
      <h3 id="rs-related" className="font-semibold">{t('related.title')}</h3>
      <ul className="space-y-2 text-sm">
        {groups.map((g) => (
          <li key={`${g.direction}-${g.register_key}-${g.field}`} data-testid={`reg-related-${g.direction}-${g.register_key}`}>
            <div className="text-mute">{t(`related.${g.direction}`)} {t(`related.register.${g.register_key}`, { defaultValue: g.register_key })}</div>
            <ul className="ms-3 space-y-1">
              {g.items.map((i) => (
                <li key={i.record_id} className="flex flex-wrap gap-x-3">
                  <Link className="mono underline" to={`/registers/${g.register_key}?record=${i.record_id}`}>{i.title}</Link>
                  <span className="text-mute">{t(`regState.${i.state}`, { defaultValue: i.state })}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}
