import { useTranslation } from 'react-i18next';

const SECTIONS = ['start', 'work', 'registers', 'templates', 'alerts', 'settings', 'help'] as const;

/** A short guide in the language of the screen (Arabic in Modern Standard Arabic): what each part is for and where to find it. */
export function Guide() {
  const { t } = useTranslation();
  return (
    <main className="space-y-4 p-4" data-testid="page-guide">
      <h1 className="text-xl font-bold">{t('guide.title')}</h1>
      <p className="text-sm text-mute">{t('guide.note')}</p>
      {SECTIONS.map((s) => (
        <section key={s} className="card space-y-1 p-3" data-testid={`guide-${s}`}>
          <h2 className="font-bold">{t(`guide.${s}.title`)}</h2>
          <p className="text-sm">{t(`guide.${s}.text`)}</p>
        </section>
      ))}
    </main>
  );
}
