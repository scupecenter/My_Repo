import { useTranslation } from 'react-i18next';

export type Scope = 'all' | string[];
/** "All" or a set of values (regions as numbers, modules as keys). Used by assignment dialogs. */
export function ScopePicker<T extends string | number>({ id, label, options, value, onChange }: { id: string; label: string; options: [T, string][]; value: Scope | T[]; onChange: (v: 'all' | T[]) => void }) {
  const { t } = useTranslation();
  const all = value === 'all', set = new Set(all ? [] : (value as T[]));
  return (
    <fieldset data-testid={id}>
      <legend className="text-sm font-semibold">{label}</legend>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm">
        <label className="flex items-center gap-1"><input type="checkbox" data-testid={`${id}-all`} checked={all} onChange={(e) => onChange(e.target.checked ? 'all' : [])} />{t('common.all')}</label>
        {options.map(([v, l]) => (
          <label key={String(v)} className="flex items-center gap-1">
            <input type="checkbox" data-testid={`${id}-${v}`} disabled={all} checked={all || set.has(v)} onChange={(e) => onChange(e.target.checked ? [...set, v] : [...set].filter((x) => x !== v))} />{l}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export const MODULES = ['sites', 'approvals', 'my_work', 'dashboard', 'procurement', 'warehouse', 'quality', 'issues', 'risks', 'reports'];
