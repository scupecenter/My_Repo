import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useIssueLessonSuggestions } from '@/api/p4c';
import { useDebounced } from './ChoiceList';

/** 0765: while a new Issue is written, the approved Lessons Learned that share words with it. Read only: nothing is stored or linked;
 *  each lesson opens in a new tab. Shown only when there is something to show (the server applies the Lessons Learned view right). */
export function LessonSuggestions({ siteId, text }: { siteId: string | null | undefined; text: string }) {
  const { t } = useTranslation();
  const q = useIssueLessonSuggestions(siteId, useDebounced(text, 600));
  const items = q.data ?? [];
  if (q.isError || items.length === 0) return null;
  return (
    <section aria-labelledby="rs-lessons" data-testid="reg-section-lessons" className="space-y-2">
      <h3 id="rs-lessons" className="font-semibold">{t('lessonSuggest.title')}</h3>
      <p className="text-xs text-mute">{t('lessonSuggest.hint')}</p>
      <ul className="space-y-2 text-sm">
        {items.map((i) => (
          <li key={i.id} data-testid={`reg-lesson-${i.id}`}>
            <Link className="underline" to={`/registers/lessons_learned?record=${i.id}`} target="_blank" rel="noreferrer" title={t('lessonSuggest.open_hint')}>
              <bdi>{i.title ?? '—'}</bdi>
            </Link>
            {i.category && <span className="chip ms-2"><bdi>{i.category}</bdi></span>}
            {i.same_site && <span className="chip ms-2">{t('lessonSuggest.same_site')}</span>}
            {i.recommendation && <div className="text-mute"><bdi>{i.recommendation}</bdi></div>}
          </li>
        ))}
      </ul>
    </section>
  );
}
