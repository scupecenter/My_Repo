import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { P } from './model';
import { Code, Name } from './rtl';

/** A filtered checklist of the active tasks of the version (the predecessor, successor and insert pickers). */
export function TaskPicker({ all, exclude, sel, onChange, prefix }: { all: P[]; exclude?: string; sel: string[]; onChange: (v: string[]) => void; prefix: string }) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');
  const options = all.filter((p) => p.task_code !== exclude && p.is_active !== false && `${p.task_code} ${p.name_en ?? ''}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div>
      <input className="input" dir="ltr" placeholder={t('common.search')} aria-label={t('common.search')} value={filter} onChange={(e) => setFilter(e.target.value)} />
      <ul className="max-h-48 overflow-y-auto text-sm" data-testid={`${prefix}-list`}>
        {options.map((p) => (
          <li key={p.task_code}><label className="flex items-center gap-2 py-0.5">
            <input type="checkbox" data-testid={`${prefix}-opt-${p.task_code}`} checked={sel.includes(p.task_code)} onChange={(e) => onChange(e.target.checked ? [...sel, p.task_code] : sel.filter((c) => c !== p.task_code))} />
            <Code>{p.task_code}</Code> <Name>{p.name_en}</Name> <Code className="mono text-mute">({p.stage_code})</Code>
          </label></li>
        ))}
      </ul>
    </div>
  );
}
