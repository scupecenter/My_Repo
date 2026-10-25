import { X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useEligible, usePicker } from '@/api/admin';
import type { UserPickerItem } from '@/api/types';

/** Searchable multi-select of registered people (name or ID, 2+ characters). `single` keeps one; `blockId` greys out a person (for example yourself). */
export function PeoplePicker({ value, onChange, single, blockId, blockHint, id = 'picker', eligible }: {
  value: UserPickerItem[]; onChange: (v: UserPickerItem[]) => void; single?: boolean; blockId?: string; blockHint?: string; id?: string; eligible?: { from?: string };
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const own = usePicker(eligible ? '' : q);
  const el = useEligible(eligible?.from, q, !!eligible);
  const found = (eligible ? el.data : own.data) ?? [];
  const picked = new Set(value.map((v) => v.id));
  const add = (u: UserPickerItem) => onChange(single ? [u] : [...value, u]);
  return (
    <div data-testid={id}>
      <div className="mb-1 flex flex-wrap gap-1">
        {value.map((u) => (
          <span key={u.id} className="chip gap-1 bg-openBg text-openInk" data-testid={`${id}-chip-${u.employee_id}`}>
            {u.display_name} <span className="mono">{u.employee_id}</span>
            <button type="button" aria-label={t('common.remove')} onClick={() => onChange(value.filter((x) => x.id !== u.id))}><X size={12} /></button>
          </span>
        ))}
      </div>
      <input className="input" data-testid={`${id}-search`} aria-label={t('picker.search')} placeholder={t('picker.search')} value={q} onChange={(e) => setQ(e.target.value)} />
      {(eligible || q.trim().length >= 2) && (
        <ul className="card mt-1 max-h-40 overflow-y-auto" role="listbox" aria-label={t('picker.results')}>
          {found.length === 0 && <li className="p-2 text-sm text-mute">{t('picker.none')}</li>}
          {found.map((u) => {
            const blocked = u.id === blockId;
            return (
              <li key={u.id}>
                <button type="button" role="option" aria-selected={picked.has(u.id)} disabled={picked.has(u.id) || blocked} title={blocked ? blockHint : undefined} data-testid={`${id}-opt-${u.employee_id}`}
                  className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-start text-sm hover:bg-hover disabled:opacity-50" onClick={() => { add(u); setQ(''); }}>
                  <span>{u.display_name}{blocked && blockHint ? <span className="ms-2 text-xs text-lateInk">{blockHint}</span> : null}</span><span className="mono text-xs text-mute">{u.employee_id}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {blockHint && value.some((v) => v.id === blockId) && <p role="alert" className="text-sm text-lateInk" data-testid={`${id}-blocked`}>{blockHint}</p>}
    </div>
  );
}
