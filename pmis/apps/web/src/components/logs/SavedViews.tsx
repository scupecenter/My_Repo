import { Bookmark, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { loadPref, savePref } from '@/lib/localPref';

type View<F> = { id: string; name: string; filter: F };

/** Saved views of a log screen: named filter sets kept per browser (like the column prefs). */
export function SavedViews<F>({ screen, value, onApply, empty }: { screen: string; value: F; onApply: (f: F) => void; empty: F }) {
  const { t } = useTranslation();
  const key = `pmis.logviews.${screen}`;
  const [views, setViews] = useState<View<F>[]>(() => { const v = loadPref<unknown>(key, []); return Array.isArray(v) ? (v as View<F>[]) : []; });
  const [cur, setCur] = useState('');
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const put = (n: View<F>[]) => { setViews(n); savePref(key, n); };
  const save = () => {
    const n = name.trim();
    if (!n) return;
    const v = { id: crypto.randomUUID(), name: n, filter: value };
    put([...views, v]); setCur(v.id); setName(''); setNaming(false);
  };
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="saved-views">
      <Bookmark size={14} aria-hidden className="text-mute" />
      <select className="input w-auto" aria-label={t('logs.views')} data-testid="views-select" value={cur}
        onChange={(e) => { setCur(e.target.value); const v = views.find((x) => x.id === e.target.value); onApply(v ? v.filter : empty); }}>
        <option value="">{t('logs.views_default')}</option>
        {views.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
      </select>
      {cur && <button type="button" className="btn px-2" data-testid="views-delete" aria-label={t('logs.view_delete')} onClick={() => { put(views.filter((v) => v.id !== cur)); setCur(''); }}><Trash2 size={14} aria-hidden /></button>}
      {naming
        ? <><input className="input w-40" data-testid="views-name" aria-label={t('logs.view_name')} placeholder={t('logs.view_name')} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} />
          <button type="button" className="btn btn-accent" data-testid="views-name-ok" onClick={save}>{t('common.save')}</button></>
        : <button type="button" className="btn" data-testid="views-save" onClick={() => setNaming(true)}>{t('logs.view_save')}</button>}
    </div>
  );
}
