import { useTranslation } from 'react-i18next';
import type { PipelineNode } from '@/api/types';

const COLOR = { done: 'var(--done)', current: 'var(--open)', late: 'var(--late)' } as Record<string, string>;
const CLS = { done: 'done', current: 'cur', late: 'late', planned: 'ghost', na: 'na', locked: 'ghost', awaiting_confirmation: 'cur' } as const;

function Ring({ p, color }: { p: number; color: string }) {
  const r = 31, C = 2 * Math.PI * r;
  return (
    <svg className="rg" viewBox="0 0 74 74" aria-hidden="true">
      <circle cx="37" cy="37" r={r} fill="none" stroke="var(--pipe)" strokeWidth="4" />
      <circle cx="37" cy="37" r={r} fill="none" stroke={color} strokeWidth="4" strokeLinecap="round" strokeDasharray={`${C * p} ${C}`} style={{ transition: 'stroke-dasharray .6s ease' }} />
    </svg>
  );
}

/** Milestone pipeline in the dashboard style: progress rings on nodes, a gradient track, hover lift. */
export function Pipeline({ nodes, selected, onSelect }: { nodes: PipelineNode[]; selected?: string | null; onSelect?: (code: string) => void }) {
  const { t, i18n } = useTranslation();
  const ms = nodes.filter((n) => n.kind === 'milestone');
  const n = ms.length || 1;
  const done = ms.filter((m) => m.state === 'done').length;
  const cur = ms.find((m) => m.state === 'current' || m.state === 'late');
  const width = Math.min(100, ((done + (cur?.progress ?? 0)) / n) * 100);
  return (
    <div data-testid="pipeline">
      <div className="pipe">
        <div className="pipe-track" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
          <div className="pipe-line" style={{ insetInline: `${50 / n}%` }}><i style={{ width: `${width}%` }} /></div>
          {ms.map((m) => {
            const name = i18n.language === 'ar' && m.name_ar ? m.name_ar : m.name_en;
            const p = m.progress ?? 0, cls = CLS[m.state];
            return (
              <button key={m.code} type="button" data-testid={`pipe-node-${m.code}`} data-state={m.state} className={`st ${cls} ${selected === m.code ? 'sel' : ''}`}
                aria-pressed={selected === m.code} aria-label={`${name}: ${t(`pipe.${m.state}`)}`} onClick={() => onSelect?.(m.code)}>
                <div className="node">
                  {m.state !== 'planned' && m.state !== 'na' && <Ring p={p} color={COLOR[m.state] ?? 'var(--lock)'} />}
                  <b style={p >= 1 ? { fontSize: 15 } : undefined}>{m.state === 'na' ? '—' : `${Math.round(p * 100)}%`}</b>
                  <small>{t(`pipe.${m.state}`)}</small>
                </div>
                <div className="nm">{name}</div>
                <div className="stats">
                  {m.actual_date ? <span className="mono">{m.actual_date.slice(5)}</span> : m.planned_date ? <>{t('grid.plan')} <span className="mono">{m.planned_date.slice(5)}</span></> : null}
                  {!!m.variance_wd && <span className={m.variance_wd > 0 ? 'late' : ''}> {m.variance_wd > 0 ? '+' : ''}{m.variance_wd} {t('approvals.wd')}</span>}
                </div>
              </button>
            );
          })}
        </div>
      </div>
      <div className="legend">
        <span><i className="d" />{t('pipe.done')}</span><span><i className="o" />{t('pipe.current')}</span><span><i className="l" />{t('pipe.late')}</span><span><i className="g" />{t('pipe.planned')}</span>
      </div>
    </div>
  );
}

export function MiniRail({ rail }: { rail: { code: string; state: string }[] }) {
  return <span className="mr" data-testid="mini-rail" aria-hidden="true">{rail.map((r) => <i key={r.code} className={r.state} title={r.code} />)}</span>;
}
