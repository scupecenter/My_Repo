import { ChevronDown, ChevronRight, Diamond, Plus } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { buildTree, masterCol, type StudioSel, type Struct } from './studioModel';

type Props = {
  s: Struct; version: number; isDraft: boolean; query: string; expanded: ReadonlySet<string>; onToggle: (code: string) => void;
  sel: StudioSel; edited: ReadonlySet<string>; nm: (x: { name_en?: string; name_ar?: string | null }) => string; onSelect: (s: NonNullable<StudioSel>) => void;
  onAddTask: (milestone: string) => void; canAdd: boolean; why?: string | null;
};

const rowCls = (on: boolean) => `flex min-h-11 w-full items-center gap-2 rounded-lg border px-3 text-start text-sm ${on ? 'border-accent bg-accentSoft font-semibold' : 'border-transparent hover:bg-hover'}`;

/** The tree of the shown version: milestones that open to their tasks, a gate after each milestone, an amber dot on what the draft changed. */
export function StudioTree(p: Props) {
  const { t } = useTranslation();
  const rows = useMemo(() => buildTree(p.s, p.query, p.expanded), [p.s, p.query, p.expanded]);
  const tasks = p.s.placements.filter((x) => x.is_active !== false).length;
  const gates = p.s.gates.filter((g) => g.is_active !== false).length;
  const is = (kind: string, code: string) => p.sel?.kind === kind && p.sel.code === code;
  const dot = (code: string) => p.edited.has(code) ? <span className="h-2 w-2 shrink-0 rounded-full bg-waitInk" role="img" aria-label={t('studio.edited')} data-testid={`studio-edited-${code}`} /> : null;
  return (
    <nav className="card flex flex-col gap-2 p-3" aria-label={t('studio.tree_aria')} data-testid="studio-tree">
      <div>
        <h3 className="text-xs font-bold uppercase tracking-wide text-mute" data-testid="studio-tree-title">{t(p.isDraft ? 'studio.tree_title_draft' : 'studio.tree_title', { version: p.version })}</h3>
        <p className="text-xs text-mute" data-testid="studio-tree-counts">{t('studio.tree_counts', { milestones: p.s.milestones.filter((m) => m.is_active !== false).length, tasks, gates })}</p>
      </div>
      {rows.length === 0 && <p className="px-1 text-sm text-mute" data-testid="studio-tree-empty">{t('studio.no_match')}</p>}
      <ul className="space-y-1">
        {rows.map(({ m, tasks: ts, gate, open }) => (
          <li key={m.code} data-testid={`studio-row-${m.code}`}>
            <div className="flex items-center gap-1">
              <button type="button" className="btn min-h-11 min-w-11 border-transparent px-0" aria-expanded={open} aria-label={t(open ? 'studio.collapse' : 'studio.expand', { name: p.nm(m) })} data-testid={`studio-ms-toggle-${m.code}`} onClick={() => p.onToggle(m.code)}>
                {open ? <ChevronDown size={16} aria-hidden className="rtl:rotate-90" /> : <ChevronRight size={16} aria-hidden className="rtl:rotate-180" />}
              </button>
              <button type="button" className={rowCls(is('milestone', m.code))} aria-current={is('milestone', m.code) ? 'true' : undefined} data-testid={`studio-ms-${m.code}`} onClick={() => p.onSelect({ kind: 'milestone', code: m.code })}>
                <span className="min-w-0 flex-1 truncate">{p.nm(m)}</span>{dot(m.code)}
                <span className="text-xs text-mute">{p.s.placements.filter((x) => x.stage_code === m.code && x.is_active !== false).length}</span>
              </button>
            </div>
            {open && (
              <ul className="ms-6 mt-1 space-y-1 border-s border-line ps-2">
                {ts.map((x) => (
                  <li key={x.task_code}>
                    <button type="button" className={`${rowCls(is('task', x.task_code))} ${x.is_active === false ? 'opacity-60' : ''}`} aria-current={is('task', x.task_code) ? 'true' : undefined} data-testid={`studio-task-${x.task_code}`} onClick={() => p.onSelect({ kind: 'task', code: x.task_code })}>
                      <span className="mono text-xs text-mute" dir="ltr">{x.task_code}</span><span className="min-w-0 flex-1 truncate">{p.nm(x)}</span>{dot(x.task_code)}
                    </button>
                  </li>
                ))}
                {!p.query && (
                  <li><button type="button" className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-dashed border-line px-3 text-sm text-mute hover:bg-hover disabled:pointer-events-none disabled:opacity-50" disabled={!p.canAdd} title={!p.canAdd && p.why ? p.why : undefined} data-testid={`studio-add-task-${m.code}`} onClick={() => p.onAddTask(m.code)}>
                    <Plus size={14} aria-hidden />{t('studio.add_task_in', { name: p.nm(m) })}</button></li>
                )}
              </ul>
            )}
            {gate && (
              <button type="button" className={`${rowCls(is('gate', gate.code))} ms-6 mt-1 w-[calc(100%-1.5rem)] ${gate.is_active === false ? 'opacity-60' : ''}`} aria-current={is('gate', gate.code) ? 'true' : undefined} data-testid={`studio-gate-${gate.code}`} onClick={() => p.onSelect({ kind: 'gate', code: gate.code })}>
                <Diamond size={14} aria-hidden className="shrink-0 text-mute" /><span className="min-w-0 flex-1 truncate">{p.nm(gate)}</span>{dot(gate.code)}
                {masterCol(gate) && <span className="mono text-xs text-mute" dir="ltr" data-testid={`studio-gate-col-${gate.code}`}>{masterCol(gate)}</span>}
              </button>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
